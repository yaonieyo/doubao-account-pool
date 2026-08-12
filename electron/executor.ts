import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, clipboard } from "electron";
import type { AppDatabase } from "./database.js";
import { AccountTaskScheduler } from "./account-scheduler.js";
import {
  extractDoubaoConversationUrl,
  extractDoubaoFailureMessage,
  extractDoubaoShareUrl,
  doubaoVideoModelFromText,
  doubaoVideoModelLabel,
  getNewDoubaoVideoUrls,
  hasNewGenerationCompletion,
  hasNewPromptOccurrence,
  hasNewTextOccurrence,
  isDoubaoDesktopDownloadPrompt,
  isDoubaoGenerationComplete,
  isDoubaoPromptRewritePage,
  isGenerationReadyForShare,
  isQuotaNotChargedFailure,
  normalizeComparableText
} from "./doubao-page-state.js";
import { toPublicApiRequest } from "./public-api.js";
import type { Account, ApiRequest, ApiRequestStatus, AppSettings, DoubaoModel } from "./types.js";
import { resolveCleanVideoUrl, verifyDoubaoShareVideoResource } from "./watermark.js";

type DataChangedCallback = () => void;
type QueueItem = {
  key: string;
  requestId: string;
  accountId: number;
  mode: "generate" | "recover";
};

type ShareRecoveryResult = {
  shareUrl: string | null;
  candidateCount: number;
  promptMatchCount: number;
  generatedMatchCount: number;
  shareFailureReason: string | null;
};

type ShareCopyResult = {
  shareUrl: string | null;
  reason: string | null;
};

class DoubaoPageFailureError extends Error {
  constructor(message: string, readonly refundQuota: boolean) {
    super(message);
    this.name = "DoubaoPageFailureError";
  }
}

class AsyncMutex {
  private tail = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>) {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

// Electron's clipboard is process-wide. Serializing share-copy operations prevents
// parallel account windows from overwriting each other's sentinel or copied URL.
const clipboardMutex = new AsyncMutex();
const SHARE_PANEL_WAIT_MS = 3500;
const CLIPBOARD_WAIT_MS = 2800;
const CALLBACK_TIMEOUT_MS = 5000;
const VIDEO_CARD_WAIT_MS = 15000;
const callbackQueues = new Map<string, Promise<void>>();

export class DoubaoExecutor {
  private readonly scheduler: AccountTaskScheduler<QueueItem>;

  constructor(
    private readonly database: AppDatabase,
    private readonly onDataChanged: DataChangedCallback
  ) {
    this.scheduler = new AccountTaskScheduler(
      () => this.database.getSettings().maxConcurrentAccounts,
      async (item) => {
        if (item.mode === "recover") {
          await this.recoverResult(item.requestId);
        } else {
          await this.execute(item.requestId);
        }
      },
      (error) => console.error("豆包并行执行器异常", error)
    );
  }

  enqueue(requestId: string) {
    this.enqueueItem(requestId, "generate");
  }

  enqueueRecovery(requestId: string) {
    this.enqueueItem(requestId, "recover");
  }

  private enqueueItem(requestId: string, mode: QueueItem["mode"]) {
    const request = this.database.getApiRequest(requestId);
    if (!request?.accountId) return false;
    return this.scheduler.enqueue({
      key: requestId,
      requestId,
      accountId: request.accountId,
      mode
    });
  }

  private async recoverResult(requestId: string) {
    const request = this.database.getApiRequest(requestId);
    if (!request?.accountId) return;

    const account = this.database.getAccount(request.accountId);
    if (!account) return;

    const settings = this.database.getSettings();
    let win: BrowserWindow | null = null;

    try {
      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在定位豆包已生成视频并重试复制分享链接"
      });
      this.database.updateAccount({ id: account.id, currentStatus: "busy" });

      win = this.createExecutionWindow(account, settings);
      await loadUrl(win, settings.doubaoChatUrl || "https://www.doubao.com/chat");
      await wait(2500);
      await dismissDoubaoDesktopDownloadPrompt(win);

      if (await looksLoggedOut(win)) {
        throw new Error("豆包账号未登录，无法恢复视频结果");
      }

      const recovery = await findGeneratedConversationAndCopyShare(
        win,
        request.prompt,
        request.doubaoThreadUrl
      );
      if (!recovery.shareUrl) {
        throw new Error(
          `未找到可恢复的豆包视频：历史链接 ${recovery.candidateCount} 条，提示词匹配 ${recovery.promptMatchCount} 条，确认已生成 ${recovery.generatedMatchCount} 条，仍未复制到分享链接${recovery.shareFailureReason ? `（${recovery.shareFailureReason}）` : ""}`
        );
      }
      this.recordOperation(
        requestId,
        "复制分享地址",
        "success",
        "已复制并确认豆包分享页包含视频资源",
        recovery.shareUrl
      );
      const resolvedVideo = await this.resolveCleanVideoForVerifiedShare(
        requestId,
        settings,
        recovery.shareUrl
      );
      const shareUrl = resolvedVideo.shareUrl;
      const cleanVideo = resolvedVideo.cleanVideo;
      const cleanVideoUrl = cleanVideo.url;
      const outputVideoPath = await downloadCleanVideoIfNeeded(settings, requestId, cleanVideoUrl);
      await this.updateProgress({
        requestId,
        status: "success",
        message: outputVideoPath
          ? `已恢复结果，去水印 MP4 已验证并保存到本地（${formatWatermarkResolution(cleanVideo)}）`
          : `已恢复结果，去水印 MP4 地址已验证（${formatWatermarkResolution(cleanVideo)}）`,
        doubaoThreadUrl: shareUrl,
        rawVideoUrl: null,
        cleanVideoUrl,
        outputVideoPath
      });
      this.database.updateAccount({ id: account.id, currentStatus: "idle" });
    } catch (error) {
      const message = errorMessage(error);
      await this.failRequest(request, `恢复结果失败：${message}`, false);
      this.database.updateAccount({
        id: account.id,
        currentStatus: /未登录|登录/.test(message) ? "login_required" : "idle"
      });
      this.onDataChanged();
    } finally {
      if (win && !win.isDestroyed()) win.close();
    }
  }

  private async execute(requestId: string) {
    const request = this.database.getApiRequest(requestId);
    if (!request) return;

    if (!request.accountId) {
      await this.failRequest(request, "请求没有分配账号", false);
      return;
    }

    const account = this.database.getAccount(request.accountId);
    if (!account) {
      await this.failRequest(request, "分配账号不存在", false);
      return;
    }

    const settings = this.database.getSettings();
    let win: BrowserWindow | null = null;
    let submittedToDoubao = false;
    let keepWindowOpen = false;

    try {
      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在打开豆包执行窗口"
      });
      this.database.updateAccount({ id: account.id, currentStatus: "busy" });

      win = this.createExecutionWindow(account, settings);
      await loadUrl(win, settings.doubaoChatUrl || "https://www.doubao.com/chat");
      await wait(2500);
      await dismissDoubaoDesktopDownloadPrompt(win);

      if (await looksLoggedOut(win)) {
        this.database.updateAccount({
          id: account.id,
          loginStatus: "logged_out",
          currentStatus: "login_required"
        });
        keepWindowOpen = true;
        if (!win.isVisible()) {
          win.show();
        }
        throw new Error("豆包账号未登录，已打开登录窗口，请登录后重试");
      }

      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在切换豆包视频生成模式"
      });
      await activateVideoMode(win, request.model);

      if (request.referenceImagePath) {
        await this.updateProgress({
          requestId,
          status: "running",
          message: "正在上传参考图"
        });
        await uploadReferenceImage(win, request.referenceImagePath);
      }

      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在填写提示词"
      });
      await fillPrompt(win, request.prompt);

      const selectedBeforeSubmit = await inspectSelectedVideoModel(win);
      const requestedModel = request.model === "seedance_2_0_mini" ? "mini" : "fast";
      if (selectedBeforeSubmit.currentModel !== requestedModel) {
        throw new Error(
          `发送前模型校验失败：要求 ${doubaoVideoModelLabel(requestedModel)}，当前为 ${selectedBeforeSubmit.currentModel ? doubaoVideoModelLabel(selectedBeforeSubmit.currentModel) : "未识别"}`
        );
      }

      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在提交豆包生成"
      });
      const generationBaseline = await inspectGenerationPage(win);
      await submitPromptAndWait(win, request.model, request.prompt);
      submittedToDoubao = true;
      const submittedConversationUrl = await waitForSubmittedConversationUrl(win);
      if (submittedConversationUrl) {
        await this.updateProgress({
          requestId,
          status: "running",
          message: "已记录本次豆包会话地址，等待视频完成",
          doubaoThreadUrl: submittedConversationUrl
        });
      }

      await this.updateProgress({
        requestId,
        status: "running",
        message: "已提交豆包，等待视频完成并复制分享链接"
      });

      const generationResult = await waitForGenerationResult(
        win,
        settings.generationTimeoutSeconds,
        generationBaseline.pageText,
        generationBaseline.videoUrls,
        generationBaseline.playableVideoCount,
        generationBaseline.videoCardCount,
        request.prompt,
        submittedConversationUrl,
        async (message) => {
        await this.updateProgress({ requestId, status: "running", message });
        }
      );

      if (!generationResult.shareUrl) {
        throw new Error(
          `视频已生成，但未提取到豆包分享链接，无法获取去水印视频${generationResult.shareFailureReason ? `（${generationResult.shareFailureReason}）` : ""}`
        );
      }

      this.recordOperation(
        requestId,
        "复制分享地址",
        "success",
        "已复制并确认豆包分享页包含视频资源",
        generationResult.shareUrl
      );

      if (!request.removeWatermark) {
        throw new Error("接口仅返回去水印视频，本次请求未启用去水印");
      }

      const resolvedVideo = await this.resolveCleanVideoForVerifiedShare(
        requestId,
        settings,
        generationResult.shareUrl
      );
      const doubaoThreadUrl = resolvedVideo.shareUrl;
      const cleanVideo = resolvedVideo.cleanVideo;
      const cleanVideoUrl = cleanVideo.url;
      const outputVideoPath = await downloadCleanVideoIfNeeded(settings, requestId, cleanVideoUrl);

      await this.updateProgress({
        requestId,
        status: "success",
        message: outputVideoPath
          ? `视频生成完成，去水印 MP4 已验证并保存到本地（${formatWatermarkResolution(cleanVideo)}）`
          : `视频生成完成，去水印 MP4 地址已验证（${formatWatermarkResolution(cleanVideo)}）`,
        doubaoThreadUrl,
        rawVideoUrl: null,
        cleanVideoUrl,
        outputVideoPath
      });
      this.database.updateAccount({ id: account.id, currentStatus: "idle" });

      if (settings.autoCloseExecutorWindow) {
        win.close();
      }
    } catch (error) {
      const shouldRefundQuota = !submittedToDoubao || isRefundableExecutionError(error);
      if (shouldRefundQuota) {
        this.database.refundQuota(account.id, request.model);
      }
      await this.failRequest(request, errorMessage(error), shouldRefundQuota);
      this.database.updateAccount({
        id: account.id,
        currentStatus: keepWindowOpen ? "login_required" : "idle"
      });
      this.onDataChanged();
      if (win && !settings.showExecutorWindow && !keepWindowOpen && !win.isDestroyed()) {
        win.close();
      }
    }
  }

  private async updateProgress(input: Parameters<AppDatabase["updateApiRequest"]>[0]) {
    const updated = this.database.updateApiRequest(input);
    this.database.appendOperationLog({
      requestId: updated.requestId,
      accountId: updated.accountId,
      action: operationAction(input.message || "", input.status),
      status: input.status === "failed" ? "failed" : input.status === "success" ? "success" : "info",
      message: input.message || "",
      targetUrl: input.doubaoThreadUrl || input.rawVideoUrl || input.cleanVideoUrl || null
    });
    this.onDataChanged();
    postCallback(updated);
    return updated;
  }

  private recordOperation(
    requestId: string,
    action: string,
    status: "info" | "success" | "failed",
    message: string,
    targetUrl?: string | null
  ) {
    const request = this.database.getApiRequest(requestId);
    this.database.appendOperationLog({
      requestId,
      accountId: request?.accountId ?? null,
      action,
      status,
      message,
      targetUrl
    });
    this.onDataChanged();
  }

  private resolveCleanVideoWithProgress(
    requestId: string,
    settings: AppSettings,
    shareUrl: string,
    maxAttempts?: number
  ) {
    return (async () => {
      const startedAt = Date.now();
      let retryCount = 0;
      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在请求去水印服务并验证真实 MP4 地址"
      });

      try {
        const url = await resolveCleanVideoUrl(settings, shareUrl, async (retry) => {
          retryCount = retry.nextAttempt - 1;
          const delaySeconds = Math.ceil(retry.delayMs / 1000);
          const elapsedSeconds = Math.max(1, Math.ceil(retry.elapsedMs / 1000));
          await this.updateProgress({
            requestId,
            status: "running",
            message: `去水印第 ${retry.failedAttempt} 次未拿到可播放 MP4，已耗时 ${elapsedSeconds} 秒；${delaySeconds} 秒后进行第 ${retry.nextAttempt}/${retry.maxAttempts} 次解析：${retry.error}`
          });
        }, { maxAttempts });
        return { url, elapsedMs: Date.now() - startedAt, retryCount };
      } catch (error) {
        const elapsedSeconds = Math.max(1, Math.ceil((Date.now() - startedAt) / 1000));
        throw new Error(`${errorMessage(error)}（去水印已耗时 ${elapsedSeconds} 秒，已重试 ${retryCount} 次）`);
      }
    })();
  }

  private async resolveCleanVideoForVerifiedShare(
    requestId: string,
    settings: AppSettings,
    shareUrl: string
  ) {
    await this.updateProgress({
      requestId,
      status: "running",
      message: "分享链接已确认包含视频资源，正在请求去水印服务"
    });

    try {
      const cleanVideo = await this.resolveCleanVideoWithProgress(
        requestId,
        settings,
        shareUrl
      );
      return { shareUrl, cleanVideo };
    } catch (error) {
      throw new Error(`分享链接已确认包含视频资源，但去水印服务未识别：${errorMessage(error)}`);
    }
  }

  private async failRequest(request: ApiRequest, message: string, refunded: boolean) {
    const suffix = refunded ? "，已退回预扣额度" : "";
    return this.updateProgress({
      requestId: request.requestId,
      status: "failed",
      message: `${message}${suffix}`
    });
  }

  private createExecutionWindow(account: Account, settings: AppSettings) {
    const titleName = account.remark || account.name;
    return new BrowserWindow({
      width: 1320,
      height: 860,
      show: settings.showExecutorWindow,
      title: `豆包执行器 - ${titleName}`,
      webPreferences: {
        partition: account.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });
  }
}

async function loadUrl(win: BrowserWindow, url: string, timeoutMs = 30000) {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      win.webContents.removeListener("did-finish-load", onFinish);
      win.webContents.removeListener("did-fail-load", onFail);
      if (timer) clearTimeout(timer);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onFinish = () => {
      finish(resolve);
    };
    const onFail = (_event: Electron.Event, _code: number, description: string) => {
      finish(() => reject(new Error(`豆包页面加载失败：${description}`)));
    };
    win.webContents.once("did-finish-load", onFinish);
    win.webContents.once("did-fail-load", onFail);
    timer = setTimeout(() => {
      finish(() => reject(new Error(`豆包页面加载超时（${Math.ceil(timeoutMs / 1000)} 秒）`)));
      if (!win.isDestroyed()) win.webContents.stop();
    }, timeoutMs);
    void win.loadURL(url).catch((error) => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    });
  });
}

async function looksLoggedOut(win: BrowserWindow) {
  return runPageScript<boolean>(win, `
    (() => {
      const text = document.body?.innerText || "";
      const loginWords = ["扫码登录", "手机号登录", "验证码登录", "登录/注册"];
      return loginWords.some((word) => text.includes(word));
    })()
  `);
}

async function uploadReferenceImage(win: BrowserWindow, imagePath: string) {
  const resolvedPath = path.resolve(imagePath);
  const stat = await fs.stat(resolvedPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`参考图不存在：${resolvedPath}`);
  }

  if (await setFirstFileInput(win, resolvedPath)) {
    await wait(2500);
    return;
  }

  await clickByKeywords(win, ["上传", "参考图", "图片", "添加图片", "附件", "image", "upload"]);
  await wait(1200);

  if (await setFirstFileInput(win, resolvedPath)) {
    await wait(2500);
    return;
  }

  throw new Error("没有找到豆包页面的图片上传控件");
}

async function setFirstFileInput(win: BrowserWindow, filePath: string) {
  const debug = win.webContents.debugger;
  let attachedHere = false;
  try {
    if (!debug.isAttached()) {
      debug.attach("1.3");
      attachedHere = true;
    }
    const documentResult = await debug.sendCommand("DOM.getDocument", { depth: -1, pierce: true }) as {
      root: { nodeId: number };
    };
    const inputs = await debug.sendCommand("DOM.querySelectorAll", {
      nodeId: documentResult.root.nodeId,
      selector: 'input[type="file"]'
    }) as { nodeIds: number[] };

    if (!inputs.nodeIds.length) return false;
    await debug.sendCommand("DOM.setFileInputFiles", {
      nodeId: inputs.nodeIds[0],
      files: [filePath]
    });
    return true;
  } finally {
    if (attachedHere && debug.isAttached()) {
      debug.detach();
    }
  }
}

async function fillPrompt(win: BrowserWindow, prompt: string) {
  const target = await findComposerTarget(win);

  if (!target) {
    throw new Error("没有找到豆包提示词输入框");
  }

  const attempts: Array<{ label: string; run: () => Promise<void> }> = [
    {
      label: "insertText",
      run: async () => {
        await sendMouseClick(win, target.x, target.y);
        await sendKeyboard(win, "A", ["meta"], 100);
        await sendKeyboard(win, "Backspace", undefined, 100);
        await win.webContents.insertText(prompt);
        await wait(900);
      }
    },
    {
      label: "clipboardPaste",
      run: async () => {
        const before = clipboard.readText();
        clipboard.writeText(prompt);
        await sendMouseClick(win, target.x, target.y);
        await sendKeyboard(win, "A", ["meta"], 100);
        await sendKeyboard(win, "Backspace", undefined, 100);
        await sendKeyboard(win, "V", ["meta"], 900);
        if (clipboard.readText() === prompt) {
          clipboard.writeText(before);
        }
      }
    },
    {
      label: "domInput",
      run: async () => {
        await setComposerTextDirectly(win, prompt);
        await wait(900);
      }
    }
  ];

  const tried: string[] = [];
  for (const attempt of attempts) {
    tried.push(attempt.label);
    await attempt.run();
    const diagnostics = await inspectComposer(win, prompt);
    if (diagnostics.promptPresent) return;
  }

  const diagnostics = await inspectComposer(win, prompt);
  throw new Error(`豆包输入框没有真正接收本次提示词（已尝试 ${tried.join("、")}；${formatComposerDiagnostics(diagnostics)}）`);
}

async function findComposerTarget(win: BrowserWindow) {
  return runPageScript<{ x: number; y: number; debug: string } | null>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 20 && rect.height > 20 && style.visibility !== "hidden" && style.display !== "none";
      };
      const candidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]'))
        .filter((el) => visible(el) && !el.disabled && !el.readOnly)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const label = [
            el.getAttribute("placeholder"),
            el.getAttribute("aria-label"),
            el.getAttribute("data-placeholder")
          ].filter(Boolean).join(" ");
          const composerScore = /发送消息|发消息|输入消息|prompt|message/i.test(label) ? 100000 : 0;
          const searchPenalty = /搜索|search/i.test(label) ? 100000 : 0;
          return { el, rect, label, score: composerScore - searchPenalty + rect.bottom };
        })
        .sort((a, b) => b.score - a.score);

      const candidate = candidates[0];
      if (!candidate) return null;

      const el = candidate.el;
      el.focus();
      return {
        x: Math.round(candidate.rect.left + Math.min(120, candidate.rect.width * 0.25)),
        y: Math.round(candidate.rect.top + candidate.rect.height / 2),
        debug: candidate.label || el.tagName.toLowerCase()
      };
    })()
  `);
}

async function setComposerTextDirectly(win: BrowserWindow, prompt: string) {
  return runPageScript<boolean>(win, `
    (() => {
      const prompt = ${JSON.stringify(prompt)};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 20 && rect.height > 20 && style.visibility !== "hidden" && style.display !== "none";
      };
      const editableSelector = 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]';
      const editables = Array.from(document.querySelectorAll(editableSelector))
        .filter((el) => visible(el) && !el.disabled && !el.readOnly)
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const editor = editables[0];
      if (!editor) return false;

      editor.focus();
      if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), "value")?.set;
        setter?.call(editor, prompt);
      } else {
        editor.textContent = prompt;
      }

      editor.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: prompt
      }));
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: prompt
      }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
}

async function activateVideoMode(win: BrowserWindow, model: DoubaoModel) {
  const target = model === "seedance_2_0_mini" ? "mini" : "fast";
  const targetLabel = doubaoVideoModelLabel(target);
  await clickByKeywords(win, ["视频生成"]);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await wait(700 + attempt * 250);
    const current = await inspectSelectedVideoModel(win);
    if (current.currentModel === target) return;

    const opened = await clickDoubaoModelTrigger(win);
    if (!opened) {
      await clickByKeywords(win, ["Seedance", "模型", "model"]);
    }
    await wait(500);
    if (!await clickExactDoubaoModelOption(win, target)) {
      continue;
    }
    await wait(800 + attempt * 200);
    const selected = await inspectSelectedVideoModel(win);
    if (selected.currentModel === target) return;
  }

  const state = await inspectSelectedVideoModel(win);
  throw new Error(
    `豆包模型未确认：要求 ${targetLabel}，当前为 ${state.currentModel ? doubaoVideoModelLabel(state.currentModel) : "未识别"}`
  );
}

async function inspectSelectedVideoModel(win: BrowserWindow) {
  return runPageScript<{
    currentModel: "mini" | "fast" | null;
    labels: string[];
  }>(win, `
    (() => {
      const modelFromText = ${doubaoVideoModelFromText.toString()};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], [role="option"], [aria-selected], [aria-checked], [aria-pressed], [aria-haspopup]'))
        .filter(visible)
        .map((el) => ({
          el,
          text: textOf(el),
          model: modelFromText(textOf(el)),
          selected: el.getAttribute("aria-selected") === "true"
            || el.getAttribute("aria-checked") === "true"
            || el.getAttribute("aria-pressed") === "true"
        }))
        .filter((item) => item.model);
      const selected = nodes.filter((item) => item.selected).sort((a, b) => a.text.length - b.text.length)[0];
      const trigger = nodes
        .filter((item) => item.el.tagName === "BUTTON"
          || item.el.getAttribute("role") === "button"
          || item.el.hasAttribute("aria-haspopup"))
        .sort((a, b) => a.text.length - b.text.length)[0];
      const pageModels = (document.body?.innerText || "")
        .split(/\\n+/)
        .map((line) => modelFromText(line.trim()))
        .filter(Boolean);
      const fallback = pageModels.length === 1 ? pageModels[0] : null;
      return {
        currentModel: selected?.model || trigger?.model || fallback || null,
        labels: nodes.map((item) => item.text).slice(0, 12)
      };
    })()
  `);
}

async function clickDoubaoModelTrigger(win: BrowserWindow) {
  return runPageScript<boolean>(win, `
    (() => {
      const modelFromText = ${doubaoVideoModelFromText.toString()};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], [aria-haspopup], [tabindex]'))
        .filter(visible)
        .map((el) => ({ el, text: textOf(el), model: modelFromText(textOf(el)) }))
        .filter((item) => item.model)
        .sort((a, b) => a.text.length - b.text.length);
      const target = candidates[0]?.el;
      if (!target) return false;
      target.click();
      return true;
    })()
  `);
}

async function clickExactDoubaoModelOption(win: BrowserWindow, model: "mini" | "fast") {
  return runPageScript<boolean>(win, `
    (() => {
      const modelFromText = ${doubaoVideoModelFromText.toString()};
      const target = ${JSON.stringify(model)};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="option"], [tabindex], [aria-label]'))
        .filter(visible)
        .map((el) => ({ el, text: textOf(el), model: modelFromText(textOf(el)) }))
        .filter((item) => item.model === target)
        .sort((a, b) => a.text.length - b.text.length);
      const option = candidates[0]?.el;
      if (!option) return false;
      option.click();
      return true;
    })()
  `);
}

async function submitPromptAndWait(win: BrowserWindow, model: DoubaoModel, prompt: string) {
  const baselineText = await getPageText(win);
  const attempts: Array<{ label: string; run: () => Promise<boolean> }> = [
    {
      label: "Enter",
      run: async () => {
        await sendKeyboard(win, "Enter");
        return true;
      }
    },
    {
      label: "Command+Enter",
      run: async () => {
        await sendKeyboard(win, "Enter", ["meta"]);
        return true;
      }
    },
    {
      label: "Control+Enter",
      run: async () => {
        await sendKeyboard(win, "Enter", ["control"]);
        return true;
      }
    },
    {
      label: "右下角发送图标",
      run: async () => {
        const sendPoint = await findComposerSendButtonPoint(win);
        if (!sendPoint) return false;
        await sendMouseClick(win, sendPoint.x, sendPoint.y);
        return true;
      }
    },
    {
      label: "发送文字按钮",
      run: () => clickByKeywords(win, ["发送", "提交"])
    }
  ];

  const tried: string[] = [];
  for (const attempt of attempts) {
    const didRun = await attempt.run();
    if (!didRun) continue;
    tried.push(attempt.label);
    const result = await waitForSubmissionStarted(win, model, baselineText, prompt, 8000);
    if (result.failureMessage) {
      throw new DoubaoPageFailureError(
        `豆包提交后返回失败：${result.failureMessage}`,
        isQuotaNotChargedFailure(result.failureMessage)
      );
    }
    if (result.confirmed || result.sentEvidence) return;
  }

  const modelLabel = model === "seedance_2_0_mini" ? "Seedance 2.0 Mini" : "Seedance 2.0 Fast";
  const diagnostics = await inspectComposer(win);
  throw new Error(
    `没有看到豆包提交确认文案：本次使用 ${modelLabel} 生成；已尝试 ${tried.join("、") || "无可用发送动作"}；${formatComposerDiagnostics(diagnostics)}`
  );
}

async function sendKeyboard(
  win: BrowserWindow,
  keyCode: string,
  modifiers?: Array<"control" | "meta">,
  settleMs = 700
) {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  await wait(80);
  win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await wait(settleMs);
}

async function inspectComposer(win: BrowserWindow, expectedPrompt = "") {
  return runPageScript<{
    promptPresent: boolean;
    textLength: number;
    activeElement: string;
    sendCandidates: number;
    enabledSendCandidates: number;
  }>(win, `
    (() => {
      const expectedPrompt = ${JSON.stringify(expectedPrompt)};
      const normalizeComparableText = (value) => value.replace(/[^\\p{L}\\p{N}]+/gu, "").trim();
      const expectedSignature = (() => {
        const normalized = normalizeComparableText(expectedPrompt);
        return normalized.slice(0, Math.min(42, Math.max(12, normalized.length)));
      })();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const editableSelector = 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]';
      const active = document.activeElement;
      const activeEditable = active?.closest?.(editableSelector);
      const editables = Array.from(document.querySelectorAll(editableSelector))
        .filter((el) => visible(el) && !el.disabled && !el.readOnly)
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const editor = activeEditable && visible(activeEditable) ? activeEditable : editables[0];
      const editorText = editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement
        ? editor.value
        : (editor?.innerText || editor?.textContent || "");
      const sendNodes = Array.from(document.querySelectorAll('button, [role="button"], [aria-label], [title]'))
        .filter((el) => visible(el))
        .filter((el) => /发送|提交|send/i.test([
          el.innerText,
          el.textContent,
          el.getAttribute("aria-label"),
          el.getAttribute("title")
        ].filter(Boolean).join(" ")));
      const enabled = sendNodes.filter((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true");
      const normalizedText = editorText.replace(/\\s+/g, "").trim();
      const comparableText = normalizeComparableText(editorText);
      return {
        promptPresent: expectedSignature
          ? comparableText.includes(expectedSignature)
          : normalizedText.length > 0,
        textLength: normalizedText.length,
        activeElement: active
          ? active.tagName.toLowerCase() + (active.getAttribute("role") ? "[role=" + active.getAttribute("role") + "]" : "")
          : "none",
        sendCandidates: sendNodes.length,
        enabledSendCandidates: enabled.length
      };
    })()
  `);
}

function formatComposerDiagnostics(input: Awaited<ReturnType<typeof inspectComposer>>) {
  return `输入框实际字数 ${input.textLength}，焦点 ${input.activeElement}，可用发送按钮 ${input.enabledSendCandidates}/${input.sendCandidates}`;
}

async function findComposerSendButtonPoint(win: BrowserWindow) {
  return runPageScript<{ x: number; y: number; debug: string } | null>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const editableSelector = 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]';
      const activeEditable = document.activeElement?.closest?.(editableSelector);
      const editables = Array.from(document.querySelectorAll(editableSelector))
        .filter((el) => visible(el) && !el.disabled && !el.readOnly)
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const editor = activeEditable && visible(activeEditable) ? activeEditable : editables[0];
      if (!editor) return null;

      const editorRect = editor.getBoundingClientRect();
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").trim();
      const isEditorAncestor = (el) => el === editor || editor.contains(el);
      const clickables = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex], span[tabindex], [aria-label]'))
        .filter((el) => visible(el) && !el.disabled && !isEditorAncestor(el))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = textOf(el);
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const nearEditor = cy >= editorRect.top - 40
            && cy <= editorRect.bottom + 90
            && cx >= editorRect.left + editorRect.width * 0.62
            && cx <= Math.max(editorRect.right + 140, window.innerWidth);
          const lowerRight = cy >= window.innerHeight * 0.55 && cx >= window.innerWidth * 0.55;
          const compact = rect.width <= 96 && rect.height <= 96;
          const badText = /视频生成|图像生成|音乐生成|更多|快速|帮我写作|录音转写|翻译|图片|\\+|添加|上传/.test(text);
          const sendText = /发送|提交/.test(text) ? 1000 : 0;
          return { el, rect, text, cx, cy, nearEditor, lowerRight, compact, badText, score: sendText + cx + cy / 10 };
        })
        .filter((item) => (item.nearEditor || item.lowerRight) && item.compact && !item.badText)
        .sort((a, b) => b.score - a.score);

      const target = clickables[0];
      if (!target) return null;
      return {
        x: Math.round(target.cx),
        y: Math.round(target.cy),
        debug: target.text || target.el.tagName
      };
    })()
  `);
}

async function sendMouseClick(win: BrowserWindow, x: number, y: number) {
  win.webContents.sendInputEvent({ type: "mouseMove", x, y });
  await wait(80);
  win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  await wait(80);
  win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
}

async function waitForSubmissionStarted(
  win: BrowserWindow,
  model: DoubaoModel,
  baselineText: string,
  prompt: string,
  timeoutMs = 15000
) {
  const modelLabel = model === "seedance_2_0_mini" ? "Seedance 2.0 Mini" : "Seedance 2.0 Fast";
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await runPageScript<{
      confirmed: boolean;
      sentEvidence: boolean;
      failureMessage: string | null;
      pageTextExcerpt: string;
    }>(win, `
      (() => {
        const modelLabel = ${JSON.stringify(modelLabel)};
        const baselineText = ${JSON.stringify(baselineText)};
        const prompt = ${JSON.stringify(prompt)};
        const extractDoubaoFailureMessage = ${extractDoubaoFailureMessage.toString()};
        const hasNewPromptOccurrence = ${hasNewPromptOccurrence.toString()};
        const hasNewTextOccurrence = ${hasNewTextOccurrence.toString()};
        const pageText = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
        const expected = "本次使用 " + modelLabel + " 生成";
        const failureMessage = extractDoubaoFailureMessage(pageText);
        const newFailureMessage = failureMessage && hasNewTextOccurrence(pageText, baselineText, failureMessage)
          ? failureMessage
          : null;
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 20 && rect.height > 20 && style.visibility !== "hidden" && style.display !== "none";
        };
        const editables = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]'))
          .filter((el) => visible(el) && !el.disabled && !el.readOnly)
          .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
        const editor = editables[0];
        const editorText = editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement
          ? editor.value
          : (editor?.innerText || editor?.textContent || "");
        const normalize = (value) => value.replace(/[^\\p{L}\\p{N}]+/gu, "").trim();
        const normalizedPrompt = normalize(prompt);
        const promptSignature = normalizedPrompt.slice(0, Math.min(42, Math.max(12, normalizedPrompt.length)));
        const normalizedEditorText = normalize(editorText);
        const promptStillInComposer = Boolean(promptSignature && normalizedEditorText.includes(promptSignature));
        const composerCleared = !editor || normalizedEditorText.length === 0 || !promptStillInComposer;
        const pageChanged = pageText !== baselineText;
        const sentEvidence = !newFailureMessage
          && pageChanged
          && (hasNewPromptOccurrence(pageText, baselineText, prompt) || composerCleared);
        return {
          confirmed: hasNewTextOccurrence(pageText, baselineText, expected)
            && pageText.includes("视频生成好后")
            && pageText.includes("本次生成将消耗每日免费额度"),
          sentEvidence,
          failureMessage: newFailureMessage,
          pageTextExcerpt: pageText.slice(-500)
        };
      })()
    `);

    if (state.failureMessage) {
      return { confirmed: false, sentEvidence: false, failureMessage: state.failureMessage };
    }
    if (state.confirmed) {
      return { confirmed: true, sentEvidence: true, failureMessage: null };
    }
    if (state.sentEvidence) {
      return { confirmed: false, sentEvidence: true, failureMessage: null };
    }
    await wait(1000);
  }

  return { confirmed: false, sentEvidence: false, failureMessage: null };
}

interface GenerationPageState {
  generated: boolean;
  failed: boolean;
  failureMessage: string | null;
  pageText: string;
  directVideoUrl: string | null;
  videoUrls: string[];
  visibleVideoCount: number;
  playableVideoCount: number;
  videoCardCount: number;
}

interface GenerationResult {
  shareUrl: string | null;
  directVideoUrl: string | null;
  shareFailureReason?: string | null;
}

async function waitForGenerationResult(
  win: BrowserWindow,
  timeoutSeconds: number,
  baselineText: string,
  baselineVideoUrls: string[],
  baselinePlayableVideoCount: number,
  baselineVideoCardCount: number,
  prompt: string,
  preferredConversationUrl: string | null,
  onProgress: (message: string) => Promise<void> | void
): Promise<GenerationResult> {
  const timeoutMs = Math.max(60, timeoutSeconds || 900) * 1000;
  const historyFallbackMs = Math.max(30000, Math.min(360000, Math.floor(timeoutMs * 0.6)));
  const startedAt = Date.now();
  let generatedAt = 0;
  let completionTextSeenAt = 0;
  let lastProgressAt = 0;
  let directVideoUrl: string | null = null;
  let shareFailureReason: string | null = null;
  let historyFallbackAttempted = false;

  while (Date.now() - startedAt < timeoutMs) {
    const pageState = await inspectGenerationPage(win);
    const newFailureMessage = pageState.failureMessage
      && hasNewTextOccurrence(pageState.pageText, baselineText, pageState.failureMessage)
      ? pageState.failureMessage
      : null;
    if (newFailureMessage) {
      throw new DoubaoPageFailureError(
        `豆包已返回视频生成失败：${newFailureMessage}`,
        isQuotaNotChargedFailure(newFailureMessage)
      );
    }

    const newVideoUrls = getNewDoubaoVideoUrls(pageState.videoUrls, baselineVideoUrls);
    const hasNewVideoSource = newVideoUrls.length > 0;
    const newVideoCount = newVideoUrls.length;
    const newPlayableVideoCount = Math.max(
      0,
      pageState.playableVideoCount - baselinePlayableVideoCount
    );
    const newVideoCardCount = Math.max(0, pageState.videoCardCount - baselineVideoCardCount);
    const completionTextPresent = hasNewGenerationCompletion(pageState.pageText, baselineText);
    if (completionTextPresent && !completionTextSeenAt) {
      completionTextSeenAt = Date.now();
    }
    // Doubao renders the completion text before the finished card. Do not share
    // until a new video card is present; a text-only result is not shareable.
    const generated = isGenerationReadyForShare({
      completionTextPresent,
      hasNewVideoSource,
      newVideoCount,
      newPlayableVideoCount,
      newVideoCardCount,
      completionTextSeenAt,
      now: Date.now()
    });

    if (generated) {
      if (!generatedAt) {
        generatedAt = Date.now();
        await onProgress("视频已生成，正在进入分享模式并复制链接");
      }
      directVideoUrl ||= pageState.directVideoUrl;

      const copied = await tryCopyShareLink(win);
      shareFailureReason = copied.reason;
      if (copied.shareUrl) {
        return { shareUrl: copied.shareUrl, directVideoUrl };
      }

      if (Date.now() - generatedAt > 120000) {
        return { shareUrl: null, directVideoUrl, shareFailureReason };
      }
    }

    if (!generatedAt && !historyFallbackAttempted && Date.now() - startedAt >= historyFallbackMs) {
      historyFallbackAttempted = true;
      await onProgress("当前执行窗口未同步完成状态，正在检查该账号最近对话");
      const originalUrl = win.webContents.getURL();
      const currentConversationUrl = extractDoubaoConversationUrl(win.webContents.getURL());
      const recovery = await findGeneratedConversationAndCopyShare(
        win,
        prompt,
        currentConversationUrl || preferredConversationUrl
      );
      if (recovery.shareUrl) {
        return { shareUrl: recovery.shareUrl, directVideoUrl };
      }
      if (recovery.generatedMatchCount > 0) {
        return { shareUrl: null, directVideoUrl, shareFailureReason: recovery.shareFailureReason };
      }
      if (originalUrl) {
        await loadUrl(win, originalUrl);
        await wait(1500);
        await dismissDoubaoDesktopDownloadPrompt(win);
      }
    }

    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    if (Date.now() - lastProgressAt > 30000) {
      lastProgressAt = Date.now();
      await onProgress(generatedAt
        ? `视频已生成，正在重试复制分享链接 ${Math.floor((Date.now() - generatedAt) / 1000)}s`
        : `已提交豆包，等待生成完成 ${elapsedSeconds}s`);
    }
    await wait(5000);
  }

  if (generatedAt) {
    return { shareUrl: null, directVideoUrl, shareFailureReason };
  }
  await onProgress("当前执行窗口等待超时，正在最后检查该账号最近对话");
  const recovery = await findGeneratedConversationAndCopyShare(
    win,
    prompt,
    extractDoubaoConversationUrl(win.webContents.getURL()) || preferredConversationUrl
  );
  if (recovery.shareUrl) {
    return { shareUrl: recovery.shareUrl, directVideoUrl };
  }
  if (recovery.generatedMatchCount > 0) {
    return { shareUrl: null, directVideoUrl, shareFailureReason: recovery.shareFailureReason };
  }
  throw new Error(
    `等待豆包视频生成超时；历史链接 ${recovery.candidateCount} 条，提示词匹配 ${recovery.promptMatchCount} 条，未找到已生成视频`
  );
}

async function inspectGenerationPage(win: BrowserWindow, scrollToLatest = true) {
  return runPageScript<GenerationPageState>(win, `
    (() => {
      if (${scrollToLatest}) {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      }
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 20 && rect.height > 20 && style.visibility !== "hidden" && style.display !== "none";
      };
      const pageText = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
      const extractDoubaoFailureMessage = ${extractDoubaoFailureMessage.toString()};
      const isDoubaoGenerationComplete = ${isDoubaoGenerationComplete.toString()};
      const isDoubaoPromptRewritePage = ${isDoubaoPromptRewritePage.toString()};
      const videos = Array.from(document.querySelectorAll("video")).filter(visible);
      const videoCardImages = Array.from(document.querySelectorAll("img")).filter((image) => {
        if (!visible(image)) return false;
        const source = [
          image.currentSrc,
          image.src,
          image.getAttribute("src"),
          image.getAttribute("data-src")
        ].filter(Boolean).join(" ");
        return /video[_-]|video.*watermark|video_dsz|tplv[^ ]*video/i.test(source);
      });
      const videoSourceLists = videos.map((video) => [
        video.currentSrc,
        video.src,
        video.getAttribute("data-src"),
        video.getAttribute("data-url"),
        video.getAttribute("data-video-url"),
        video.getAttribute("data-download-url"),
        ...Array.from(video.querySelectorAll("source[src]")).map((source) => source.src)
      ].filter(Boolean));
      const videoSources = videoSourceLists.flat();
      const videoUrls = videoSources.filter((value) => /^https?:\\/\\//i.test(value || ""));
      const completedByText = isDoubaoGenerationComplete(pageText);
      const promptRewrite = isDoubaoPromptRewritePage(pageText);
      const playableVideoCount = videos.filter((video, index) => (
        video.readyState >= 1 || videoSourceLists[index].length > 0
      )).length;
      const playableVideo = playableVideoCount > 0;
      const failureMessage = extractDoubaoFailureMessage(pageText);
      return {
        generated: completedByText || (!promptRewrite && playableVideo),
        failed: Boolean(failureMessage),
        failureMessage,
        pageText,
        directVideoUrl: videoUrls[videoUrls.length - 1] || null,
        videoUrls,
        visibleVideoCount: videos.length,
        playableVideoCount,
        videoCardCount: videos.length + videoCardImages.length
      };
    })()
  `);
}

async function findGeneratedConversationAndCopyShare(
  win: BrowserWindow,
  prompt: string,
  preferredConversationUrl: string | null = null
) {
  const normalizedPrompt = normalizeComparableText(prompt);
  const candidates = await runPageScript<string[]>(win, `
    (() => {
      const prompt = ${JSON.stringify(normalizedPrompt)};
      const normalize = (value) => value.replace(/[^\\p{L}\\p{N}]+/gu, "").trim();
      const scoreLabel = (label) => {
        const normalizedLabel = normalize(label);
        if (!normalizedLabel) return 0;
        if (prompt.includes(normalizedLabel)) return 10000 + normalizedLabel.length;
        let bigramMatches = 0;
        for (let index = 0; index < normalizedLabel.length - 1; index += 1) {
          if (prompt.includes(normalizedLabel.slice(index, index + 2))) bigramMatches += 1;
        }
        return bigramMatches * 100 + Math.min(normalizedLabel.length, 20);
      };
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map((link, index) => ({
          href: link.href,
          label: [link.innerText, link.textContent, link.getAttribute("aria-label"), link.getAttribute("title")]
            .filter(Boolean).join(" "),
          index
        }))
        .filter(({ href }) => {
          try {
            const url = new URL(href);
            return /^(?:www\\.)?doubao\\.com$/i.test(url.hostname)
              && /^\\/chat\\/[A-Za-z0-9._~-]+/i.test(url.pathname);
          } catch {
            return false;
          }
        })
        .map((item) => ({ ...item, score: scoreLabel(item.label) }));
      const unique = Array.from(new Map(links.map((item) => [item.href, item])).values());
      return unique
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((item) => item.href)
        .slice(0, 30);
    })()
  `);
  const preferredUrl = extractDoubaoConversationUrl(preferredConversationUrl);
  const orderedCandidates = Array.from(new Set([
    preferredUrl,
    ...candidates
  ].filter((value): value is string => Boolean(value))));
  const signatureLength = Math.min(42, normalizedPrompt.length);
  const signatureSpan = Math.max(0, normalizedPrompt.length - signatureLength);
  const signatures = Array.from(new Set([0, 0.25, 0.5, 0.75, 1]
    .map((position) => normalizedPrompt.slice(
      Math.floor(signatureSpan * position),
      Math.floor(signatureSpan * position) + signatureLength
    ))
    .filter((value) => value.length >= 12)));
  const requiredSignatureMatches = Math.max(1, Math.ceil(signatures.length * 0.8));
  let promptMatchCount = 0;
  let generatedMatchCount = 0;
  let shareFailureReason: string | null = null;

  for (const candidate of orderedCandidates) {
    try {
      // A stale conversation link must not block recovery indefinitely. The
      // newest conversation is normally near the front of this list.
      await loadUrl(win, candidate, 8000);
    } catch (error) {
      console.warn("跳过无法加载的豆包历史对话", candidate, error);
      continue;
    }
    await wait(600);
    await dismissDoubaoDesktopDownloadPrompt(win);

    let pageText = "";
    let matchedPrompt = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      pageText = await runPageScript<string>(win, `document.body?.innerText || ""`);
      const normalizedPageText = normalizeComparableText(pageText);
      const signatureMatches = signatures.filter((signature) => normalizedPageText.includes(signature)).length;
      matchedPrompt = normalizedPageText.includes(normalizedPrompt)
        || signatureMatches >= requiredSignatureMatches;
      if (matchedPrompt) break;
      await wait(350);
    }
    if (!matchedPrompt) continue;
    promptMatchCount += 1;

    const pageState = await waitForGeneratedVideoCard(win, VIDEO_CARD_WAIT_MS);
    if (!pageState.generated || pageState.failed) continue;
    if (pageState.videoCardCount <= 0) {
      shareFailureReason = "匹配对话已完成，但视频卡片仍未渲染";
      continue;
    }
    generatedMatchCount += 1;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const copied = await tryCopyShareLink(win);
      shareFailureReason = copied.reason;
      if (copied.shareUrl) {
        return {
          shareUrl: copied.shareUrl,
          candidateCount: orderedCandidates.length,
          promptMatchCount,
          generatedMatchCount,
          shareFailureReason: null
        };
      }
      await wait(1000);
    }
  }

  return {
    shareUrl: null,
    candidateCount: orderedCandidates.length,
    promptMatchCount,
    generatedMatchCount,
    shareFailureReason
  };
}

async function waitForGeneratedVideoCard(win: BrowserWindow, timeoutMs: number) {
  const startedAt = Date.now();
  let state = await inspectGenerationPage(win);
  while (Date.now() - startedAt < timeoutMs) {
    if (state.failureMessage || (state.generated && state.videoCardCount > 0)) return state;
    await wait(500);
    state = await inspectGenerationPage(win);
  }
  return state;
}

async function tryCopyShareLink(win: BrowserWindow) {
  return clipboardMutex.runExclusive(async () => {
    if (win.isDestroyed()) return { shareUrl: null, reason: "执行窗口已关闭" } satisfies ShareCopyResult;

    const before = clipboard.readText();
    const clipboardSentinel = `__doubao_share_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    clipboard.writeText(clipboardSentinel);
    let result: ShareCopyResult = { shareUrl: null, reason: "未找到分享面板" };

    try {
      await dismissDoubaoDesktopDownloadPrompt(win);

      const generationState = await inspectGenerationPage(win, false);
      if (generationState.failureMessage) {
        result = {
          shareUrl: null,
          reason: `当前任务未产生视频：${generationState.failureMessage}`
        };
        return result;
      }
      if (!generationState.generated) {
        result = { shareUrl: null, reason: "当前对话尚未确认视频生成完成" };
        return result;
      }

      await primeGeneratedVideoCard(win);

      const acceptCopiedShareUrl = async (shareUrl: string) => {
        try {
          await verifyDoubaoShareVideoResource(shareUrl);
          result = { shareUrl, reason: null };
          return true;
        } catch (error) {
          result = { shareUrl: null, reason: errorMessage(error) };
          return false;
        }
      };

      let shareState = await inspectShareSelection(win);

      if (!shareState.active) {
        await openShareSelection(win);
        const directlyCopiedUrl = extractDoubaoShareUrl(clipboard.readText());
        if (directlyCopiedUrl) {
          if (await acceptCopiedShareUrl(directlyCopiedUrl)) return result;
        }
        shareState = await waitForShareSelection(win, SHARE_PANEL_WAIT_MS);
      }

      if (!shareState.active) {
        if (!result.reason || result.reason === "未找到分享面板") {
          result = { shareUrl: null, reason: "未打开分享面板" };
        }
        return result;
      }

      if (!shareState.allSelected) {
        const selectAllPoint = await waitForTextControlPoint(win, ["全选"], [], 1800);
        if (selectAllPoint) {
          await sendMouseClick(win, selectAllPoint.x, selectAllPoint.y);
          shareState = await waitForShareSelection(win, 1200);
        }
      }

      // The copy button starts disabled while the share panel settles or until
      // the target content is selected. Poll for it instead of failing on the
      // first inspection so a slow panel is not treated as a failed copy.
      if (!shareState.copyEnabled) {
        shareState = await waitForShareCopyEnabled(win, SHARE_PANEL_WAIT_MS);
      }

      const copyPoint = await waitForTextControlPoint(win, ["复制链接"], [], 1800);
      if (!copyPoint) {
        result = { shareUrl: null, reason: "未找到复制链接控件" };
        return result;
      }
      if (!shareState.copyEnabled && shareState.checkboxCount > 0) {
        result = { shareUrl: null, reason: "复制链接按钮未启用" };
        return result;
      }

      // A native input event is the reliable path for Doubao's clipboard handler.
      await sendMouseClick(win, copyPoint.x, copyPoint.y);
      const nativeCopiedUrl = await waitForClipboardShareUrl(CLIPBOARD_WAIT_MS);
      if (nativeCopiedUrl) {
        if (await acceptCopiedShareUrl(nativeCopiedUrl)) return result;
      }

      // Keep a DOM click as a bounded fallback for versions that render the
      // clickable label separately from the visible button surface.
      await clickByKeywords(win, ["复制链接"]);
      const domCopiedUrl = await waitForClipboardShareUrl(CLIPBOARD_WAIT_MS);
      if (domCopiedUrl) {
        await acceptCopiedShareUrl(domCopiedUrl);
      } else if (!result.reason) {
        result = { shareUrl: null, reason: "点击复制链接后剪贴板未出现豆包分享地址" };
      }
      return result;
    } catch (error) {
      // Share panels are animated and can be replaced while the generation card
      // updates. Treat a transient inspection error as a retryable miss.
      console.warn("豆包复制分享链接暂时失败", error);
      result = { shareUrl: null, reason: `复制控件检查异常：${errorMessage(error)}` };
      return result;
    } finally {
      if (!result.shareUrl) restoreClipboardAfterFailedShare(before, clipboardSentinel);
    }
  });
}

async function dismissDoubaoDesktopDownloadPrompt(win: BrowserWindow) {
  if (win.isDestroyed()) return false;

  const prompt = await runPageScript<{
    detected: boolean;
    action: "remind_later" | "close" | null;
  }>(win, `
    (() => {
      const isDoubaoDesktopDownloadPrompt = ${isDoubaoDesktopDownloadPrompt.toString()};
      const pageText = document.body?.innerText || "";
      if (!isDoubaoDesktopDownloadPrompt(pageText)) {
        return { detected: false, action: null };
      }

      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4
          && rect.height > 4
          && style.visibility !== "hidden"
          && style.display !== "none"
          && style.pointerEvents !== "none";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const controls = Array.from(document.querySelectorAll('button, [role="button"], a, [tabindex]'))
        .filter(visible);
      const clickTarget = (el) => el.closest('button, [role="button"], a, [tabindex]') || el;
      const remindLater = controls.find((el) => textOf(el).replace(/\\s+/g, "") === "下次提醒我");
      if (remindLater) {
        clickTarget(remindLater).click();
        return { detected: true, action: "remind_later" };
      }

      const closeButton = controls.find((el) => {
        const label = [el.getAttribute("aria-label"), el.getAttribute("title")]
          .filter(Boolean).join(" ");
        const text = textOf(el).replace(/\\s+/g, "");
        return /关闭|close|dismiss/i.test(label) || text === "×" || text === "✕";
      });
      if (closeButton) {
        clickTarget(closeButton).click();
        return { detected: true, action: "close" };
      }

      return { detected: true, action: null };
    })()
  `);

  if (!prompt.detected) return false;
  if (!prompt.action) {
    await sendKeyboard(win, "ESC", undefined, 250);
  } else {
    await wait(450);
  }

  // Some Doubao builds accept the click but leave the modal mounted for a
  // short period. Verify the marker is gone before trying the share controls.
  // Esc is harmless when the modal has already closed and prevents a stale
  // overlay from swallowing the next click when it has not.
  try {
    const stillVisible = await runPageScript<boolean>(win, `
      (() => {
        const isDoubaoDesktopDownloadPrompt = ${isDoubaoDesktopDownloadPrompt.toString()};
        const pageText = document.body?.innerText || "";
        if (!isDoubaoDesktopDownloadPrompt(pageText)) return false;
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 4
            && rect.height > 4
            && style.visibility !== "hidden"
            && style.display !== "none"
            && style.pointerEvents !== "none";
        };
        const textOf = (el) => [
          el.innerText,
          el.textContent,
          el.getAttribute("aria-label"),
          el.getAttribute("title")
        ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
        return Array.from(document.querySelectorAll('button, [role="button"], a, [tabindex]'))
          .filter(visible)
          .some((el) => textOf(el).replace(/\\s+/g, "") === "下次提醒我");
      })()
    `);
    if (stillVisible) await sendKeyboard(win, "ESC", undefined, 250);
  } catch {
    // The click can trigger a route update; the next page operation will
    // handle a newly mounted prompt if needed.
  }
  return true;
}

async function waitForClipboardShareUrl(timeoutMs = CLIPBOARD_WAIT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const shareUrl = extractDoubaoShareUrl(clipboard.readText());
    if (shareUrl) return shareUrl;
    await wait(Math.min(150, Math.max(25, timeoutMs - (Date.now() - startedAt))));
  }
  return extractDoubaoShareUrl(clipboard.readText());
}

async function primeGeneratedVideoCard(win: BrowserWindow) {
  const revealed = await runPageScript<boolean>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 80
          && rect.height > 60
          && style.visibility !== "hidden"
          && style.display !== "none";
      };
      const posters = Array.from(document.querySelectorAll("img"))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const source = [
            el.currentSrc,
            el.src,
            el.getAttribute("src"),
            el.getAttribute("data-src")
          ].filter(Boolean).join(" ");
          return { el, rect, source };
        })
        .filter((item) => /video[_-]|video.*watermark|video_dsz|tplv[^ ]*video/i.test(item.source))
        .sort((a, b) => b.rect.bottom - a.rect.bottom);
      const target = posters[0];
      if (!target) return false;
      target.el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      target.el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      return true;
    })()
  `);
  if (!revealed) return false;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    await wait(500);
    const state = await inspectGenerationPage(win, false);
    if (state.playableVideoCount > 0 || state.videoUrls.length > 0) {
      await wait(700);
      break;
    }
  }
  await sendKeyboard(win, "ESC", undefined, 350);
  await wait(800);
  return true;
}

async function waitForShareSelection(win: BrowserWindow, timeoutMs: number) {
  const startedAt = Date.now();
  let state = await inspectShareSelection(win);
  while (!state.active && Date.now() - startedAt < timeoutMs) {
    await wait(180);
    state = await inspectShareSelection(win);
  }
  return state;
}

async function waitForShareCopyEnabled(win: BrowserWindow, timeoutMs: number) {
  const startedAt = Date.now();
  let state = await inspectShareSelection(win);
  while (!state.copyEnabled && Date.now() - startedAt < timeoutMs) {
    await wait(180);
    state = await inspectShareSelection(win);
  }
  return state;
}

async function waitForTextControlPoint(
  win: BrowserWindow,
  keywords: string[],
  excluded: string[] = [],
  timeoutMs = 1800
) {
  const startedAt = Date.now();
  let point = await findTextControlPoint(win, keywords, excluded);
  while (!point && Date.now() - startedAt < timeoutMs) {
    await wait(150);
    point = await findTextControlPoint(win, keywords, excluded);
  }
  return point;
}

function restoreClipboardAfterFailedShare(before: string, sentinel: string) {
  const current = clipboard.readText();
  if (current === sentinel || !extractDoubaoShareUrl(current)) {
    clipboard.writeText(before);
  }
}

async function inspectShareSelection(win: BrowserWindow) {
  return runPageScript<{
    active: boolean;
    hasSelection: boolean;
    allSelected: boolean;
    checkboxCount: number;
    checkedCount: number;
    copyEnabled: boolean;
  }>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const controls = Array.from(document.querySelectorAll('button, [role="button"], [aria-label], [title], [tabindex]'))
        .filter(visible);
      const copyControls = controls.filter((el) => textOf(el).includes("复制链接"));
      const allText = (document.body?.innerText || "").replace(/\\s+/g, " ");
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')).filter(visible);
      const checked = checkboxes.filter((el) => el.checked === true || el.getAttribute("aria-checked") === "true");
      const copyEnabled = copyControls.some((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true");
      return {
        active: copyControls.length > 0 && allText.includes("全选"),
        hasSelection: checked.length > 0 || (checkboxes.length === 0 && copyEnabled),
        allSelected: checkboxes.length === 0 ? copyEnabled : checked.length === checkboxes.length,
        checkboxCount: checkboxes.length,
        checkedCount: checked.length,
        copyEnabled
      };
    })()
  `);
}

async function openShareSelection(win: BrowserWindow) {
  const cardSharePoint = await waitForVideoCardSharePoint(win, 5000);
  if (cardSharePoint) {
    await sendMouseClick(win, cardSharePoint.x, cardSharePoint.y);
    if ((await waitForShareSelection(win, SHARE_PANEL_WAIT_MS)).active) return true;
    await sendKeyboard(win, "ESC", undefined, 250);
  }

  // Some Doubao builds label the video-card entry as “分享图片”. It is the
  // share entry for the current media card, not a page-level share action.
  const sharePoint = await waitForTextControlPoint(win, ["分享图片", "分享"], [], 1800);
  if (sharePoint) {
    await sendMouseClick(win, sharePoint.x, sharePoint.y);
    if ((await waitForShareSelection(win, SHARE_PANEL_WAIT_MS)).active) return true;
  }

  const menuPoint = await findOverflowMenuPoint(win);
  if (menuPoint) {
    await sendMouseClick(win, menuPoint.x, menuPoint.y);
    const menuSharePoint = await waitForTextControlPoint(win, ["分享"], ["分享图片"], 1800);
    if (menuSharePoint) {
      await sendMouseClick(win, menuSharePoint.x, menuSharePoint.y);
      if ((await waitForShareSelection(win, SHARE_PANEL_WAIT_MS)).active) return true;
    }
    // A wrong header candidate can open an unrelated popover. Close it before
    // trying the icon-only fallback so the next click is not swallowed.
    await sendKeyboard(win, "ESC", undefined, 250);
  }

  // On some Doubao builds the message toolbar is icon-only. Its action order is
  // copy, share, edit, more; use the button immediately before edit when labels
  // are absent as a final fallback after the verified header menu path.
  const shareIconPoint = await findShareIconPoint(win);
  if (shareIconPoint) {
    await sendMouseClick(win, shareIconPoint.x, shareIconPoint.y);
    if ((await waitForShareSelection(win, SHARE_PANEL_WAIT_MS)).active) return true;
  }

  return false;
}

async function waitForVideoCardSharePoint(win: BrowserWindow, timeoutMs: number) {
  const startedAt = Date.now();
  let point = await findVideoCardSharePoint(win);
  while (!point && Date.now() - startedAt < timeoutMs) {
    await wait(180);
    point = await findVideoCardSharePoint(win);
  }
  return point;
}

async function findVideoCardSharePoint(win: BrowserWindow) {
  return runPageScript<{ x: number; y: number } | null>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4
          && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const media = Array.from(document.querySelectorAll("video, img"))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const source = [
            el.currentSrc,
            el.src,
            el.getAttribute("src"),
            el.getAttribute("data-src"),
            el.getAttribute("data-video-url"),
            el.getAttribute("data-download-url")
          ].filter(Boolean).join(" ");
          return { el, rect, source };
        })
        .filter((item) => /video[_-]|video.*watermark|video_dsz|tplv[^ ]*video/i.test(item.source))
        .sort((a, b) => b.rect.bottom - a.rect.bottom)[0];
      if (!media) return null;

      let ancestor = media.el.parentElement;
      for (let level = 0; ancestor && level < 9; level += 1, ancestor = ancestor.parentElement) {
        const controls = Array.from(ancestor.querySelectorAll('button, [role="button"], [tabindex], [aria-label], [title]'))
          .filter(visible)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return { el, rect, text: textOf(el) };
          })
          .filter((item) => item.rect.width <= 240 && item.rect.height <= 100
            && item.rect.bottom >= media.rect.top - 100
            && item.rect.top <= media.rect.bottom + 180);
        const labeled = controls
          .filter((item) => /分享/.test(item.text) && !/下载|电脑版/.test(item.text))
          .sort((a, b) => Number(/分享图片|分享/.test(b.text)) - Number(/分享图片|分享/.test(a.text)));
        if (labeled[0]) {
          const rect = labeled[0].rect;
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        }

        const iconControls = controls
          .filter((item) => !item.text && item.rect.width <= 64 && item.rect.height <= 64)
          .sort((a, b) => a.rect.left - b.rect.left);
        const unique = [];
        for (const item of iconControls) {
          if (!unique.some((existing) => Math.abs(existing.rect.left - item.rect.left) < 8)) unique.push(item);
        }
        if (unique.length >= 3) {
          const target = unique[unique.length - 3].rect;
          return { x: Math.round(target.left + target.width / 2), y: Math.round(target.top + target.height / 2) };
        }
      }
      return null;
    })()
  `);
}

async function findTextControlPoint(win: BrowserWindow, keywords: string[], excluded: string[] = []) {
  return runPageScript<{ x: number; y: number; debug: string } | null>(win, `
    (() => {
      const keywords = ${JSON.stringify(keywords)};
      const excluded = ${JSON.stringify(excluded)};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], a, label, [tabindex], [aria-label], [title], div, span'))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = textOf(el);
          const exact = keywords.some((word) => text === word);
          const contains = keywords.some((word) => text.includes(word));
          const blocked = excluded.some((word) => text.includes(word));
          const enabled = !el.disabled && el.getAttribute("aria-disabled") !== "true";
          return { el, rect, text, exact, contains, blocked, enabled };
        })
        .filter((item) => item.contains
          && !item.blocked
          && item.rect.width <= 480
          && item.rect.height <= 140)
        .sort((a, b) => Number(b.enabled) - Number(a.enabled)
          || Number(b.exact) - Number(a.exact)
          || b.rect.bottom - a.rect.bottom);
      const target = nodes[0];
      if (!target) return null;
      return {
        x: Math.round(target.rect.left + target.rect.width / 2),
        y: Math.round(target.rect.top + target.rect.height / 2),
        debug: target.text
      };
    })()
  `);
}

async function findOverflowMenuPoint(win: BrowserWindow) {
  return runPageScript<{ x: number; y: number } | null>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => [el.innerText, el.textContent, el.getAttribute("aria-label"), el.getAttribute("title")]
        .filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const allNodes = Array.from(document.querySelectorAll('button, [role="button"], [tabindex], [aria-label], [title]'))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return { rect, text: textOf(el) };
        });
      const headerNodes = allNodes.filter((item) => {
        const centerX = item.rect.left + item.rect.width / 2;
        const centerY = item.rect.top + item.rect.height / 2;
        return centerY >= 0
          && centerY <= 120
          && centerX >= window.innerWidth * 0.65
          && item.rect.width <= 180
          && item.rect.height <= 80;
      });
      const labeledNodes = headerNodes
        .filter((item) => /更多|操作|^\\.{3}$|^…$|^⋯$/.test(item.text)
          && !/下载电脑版|播报|朗读|静音/.test(item.text)
          && item.rect.width <= 80
          && item.rect.height <= 80)
        .sort((a, b) => b.rect.right - a.rect.right || a.rect.top - b.rect.top);
      const downloadNode = headerNodes
        .filter((item) => /下载电脑版/.test(item.text))
        .sort((a, b) => a.rect.width - b.rect.width)[0];
      const smallHeaderNodes = headerNodes
        .filter((item) => !/下载电脑版|播报|朗读|静音/.test(item.text)
          && item.rect.width <= 80
          && item.rect.height <= 80);
      const adjacentToDownload = downloadNode
        ? smallHeaderNodes
          .filter((item) => item.rect.right <= downloadNode.rect.left + 12
            && item.rect.right >= downloadNode.rect.left - 120
            && Math.abs((item.rect.top + item.rect.height / 2)
              - (downloadNode.rect.top + downloadNode.rect.height / 2)) <= 26)
          .sort((a, b) => {
            const distanceA = downloadNode.rect.left - a.rect.right;
            const distanceB = downloadNode.rect.left - b.rect.right;
            return distanceA - distanceB;
          })
        : [];
      const target = labeledNodes[0]
        || adjacentToDownload[0]
        || smallHeaderNodes.sort((a, b) => b.rect.right - a.rect.right)[0];
      return target ? {
        x: Math.round(target.rect.left + target.rect.width / 2),
        y: Math.round(target.rect.top + target.rect.height / 2)
      } : null;
    })()
  `);
}

async function waitForSubmittedConversationUrl(win: BrowserWindow, timeoutMs = 2600) {
  let conversationUrl = extractDoubaoConversationUrl(win.webContents.getURL());
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs
    && (!conversationUrl || /\/chat\/local_/i.test(conversationUrl))) {
    await wait(200);
    const currentUrl = extractDoubaoConversationUrl(win.webContents.getURL());
    if (currentUrl) conversationUrl = currentUrl;
  }
  return conversationUrl;
}

async function findShareIconPoint(win: BrowserWindow) {
  const overflowPoint = await findOverflowMenuPoint(win);
  if (!overflowPoint) return null;

  return runPageScript<{ x: number; y: number } | null>(win, `
    (() => {
      const anchor = ${JSON.stringify(overflowPoint)};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], [tabindex], [aria-label], [title]'))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            width: rect.width,
            height: rect.height
          };
        })
        .filter((item) => item.width <= 64
          && item.height <= 64
          && Math.abs(item.y - anchor.y) <= 26
          && item.x <= anchor.x + 12
          && item.x >= anchor.x - 170)
        .sort((a, b) => a.x - b.x);

      const unique = [];
      for (const item of nodes) {
        if (!unique.some((existing) => Math.abs(existing.x - item.x) < 8)) unique.push(item);
      }

      const target = unique.length >= 3 ? unique[unique.length - 3] : null;
      return target ? { x: Math.round(target.x), y: Math.round(target.y) } : null;
    })()
  `);
}

async function clickByKeywords(win: BrowserWindow, keywords: string[]) {
  return runPageScript<boolean>(win, `
    (() => {
      const keywords = ${JSON.stringify(keywords.map((item) => item.toLowerCase()))};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("placeholder")
      ].filter(Boolean).join(" ").trim();
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, label, div[tabindex], span[tabindex]'))
        .filter((el) => visible(el));
      const scored = nodes
        .map((el) => {
          const text = textOf(el).toLowerCase();
          const score = keywords.reduce((sum, keyword) => sum + (text.includes(keyword) ? 1 : 0), 0);
          const tagScore = el.tagName === "BUTTON" ? 3 : el.getAttribute("role") === "button" ? 2 : 1;
          return { el, text, score, tagScore };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || b.tagScore - a.tagScore);
      const target = scored[0]?.el;
      if (!target) return false;
      target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      target.click();
      return true;
    })()
  `);
}

async function downloadCleanVideoIfNeeded(settings: AppSettings, requestId: string, cleanVideoUrl: string) {
  if (!settings.outputDir.trim()) return null;
  await fs.mkdir(settings.outputDir, { recursive: true });
  const response = await fetch(cleanVideoUrl);
  if (!response.ok) {
    throw new Error(`下载去水印视频失败：HTTP ${response.status}`);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("video/") && !contentType.includes("application/octet-stream")) {
    throw new Error(`下载结果不是视频文件：Content-Type ${contentType || "unknown"}`);
  }

  const outputPath = path.join(settings.outputDir, `${requestId}.mp4`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) {
    throw new Error("下载到的去水印 MP4 文件为空");
  }
  await fs.writeFile(outputPath, bytes);
  return outputPath;
}

function postCallback(request: ApiRequest) {
  if (!request.callbackUrl) return;

  const previous = callbackQueues.get(request.requestId) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      await fetch(request.callbackUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toPublicApiRequest(request)),
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS)
      }).catch(() => undefined);
    });
  callbackQueues.set(request.requestId, current);
  void current.then(() => {
    if (callbackQueues.get(request.requestId) === current) callbackQueues.delete(request.requestId);
  });
}

async function runPageScript<T>(win: BrowserWindow, script: string) {
  return win.webContents.executeJavaScript(script, true) as Promise<T>;
}

async function getPageText(win: BrowserWindow) {
  return runPageScript<string>(win, `(document.body?.innerText || "").replace(/\\s+/g, " ").trim()`);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "执行器未知错误";
}

function operationAction(message: string, status?: ApiRequestStatus) {
  if (status === "success") return "任务完成";
  if (status === "failed") return "任务失败";
  if (message.includes("上传参考图")) return "上传参考图";
  if (message.includes("填写提示词")) return "填写提示词";
  if (message.includes("切换豆包视频生成模式")) return "切换视频生成模式";
  if (message.includes("提交豆包")) return "提交视频任务";
  if (message.includes("复制分享")) return "复制分享地址";
  if (message.includes("去水印")) return "去水印解析";
  if (message.includes("等待视频") || message.includes("定位豆包")) return "等待视频结果";
  return "任务进度";
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  return `${seconds} 秒`;
}

function formatWatermarkResolution(input: { elapsedMs: number; retryCount: number }) {
  return `耗时 ${formatElapsed(input.elapsedMs)}，第 ${input.retryCount + 1} 次解析`;
}

function isRefundableExecutionError(error: unknown) {
  return error instanceof DoubaoPageFailureError && error.refundQuota;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
