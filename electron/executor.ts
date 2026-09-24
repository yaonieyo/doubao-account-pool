import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, clipboard } from "electron";
import type { AppDatabase } from "./database.js";
import { AccountTaskScheduler } from "./account-scheduler.js";
import {
  extractDoubaoConversationUrl,
  extractDoubaoFailureMessage,
  extractNewDoubaoReply,
  extractDoubaoWatermarkShareUrl,
  doubaoAspectRatioFromText,
  isDoubaoAspectRatioTriggerText,
  doubaoVideoModelFromText,
  doubaoVideoModelLabel,
  isDoubaoVideoModelTriggerText,
  getNewDoubaoVideoUrls,
  hasStrongSubmissionEvidence,
  hasNewDoubaoSubmissionConfirmation,
  hasNewGenerationCompletion,
  hasNewPromptOccurrence,
  hasNewTextOccurrence,
  isDoubaoDesktopDownloadPrompt,
  isDoubaoCongestionReply,
  isDoubaoGenerationComplete,
  isDoubaoGenerationActionText,
  isDoubaoGenerationPending,
  isDoubaoPromptSuggestion,
  isDoubaoPromptRewritePage,
  isDoubaoSafetyConfirmationDialog,
  isGenerationReadyForShare,
  isFormalDoubaoConversationUrl,
  isQuotaNotChargedFailure,
  normalizeComparableText
} from "./doubao-page-state.js";
import { toPublicApiRequest } from "./public-api.js";
import type { Account, ApiRequest, ApiRequestStatus, AppSettings, DoubaoAspectRatio, DoubaoModel } from "./types.js";
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
  pendingMatchCount: number;
  failureMessage: string | null;
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

class DoubaoCongestionError extends DoubaoPageFailureError {
  constructor(readonly reply: string) {
    super(`豆包繁忙，未确认视频生成；页面最新回复：${reply}`, true);
    this.name = "DoubaoCongestionError";
  }
}

class DoubaoGenerationPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoubaoGenerationPendingError";
  }
}

class DoubaoTaskStoppedError extends Error {
  constructor() {
    super("任务已由用户终止");
    this.name = "DoubaoTaskStoppedError";
  }
}

const SHARE_PANEL_WAIT_MS = 3500;
const PAGE_SHARE_CAPTURE_WAIT_MS = 2800;
const CALLBACK_TIMEOUT_MS = 5000;
const VIDEO_CARD_WAIT_MS = 15000;
const DIRECT_GENERATION_FOLLOW_UP = "请直接提交视频生成，不要改写、分析或扩写提示词。";
const DIRECT_GENERATION_SHORT_FOLLOW_UP = "直接生成";
const DIRECT_GENERATION_CONFIRM_FOLLOW_UP = "确认生成";
const PREFERRED_CONVERSATION_RETRY_MS = 75000;
const RECENT_CONVERSATION_FALLBACK_LIMIT = 10;
const callbackQueues = new Map<string, Promise<void>>();

export class DoubaoExecutor {
  private readonly scheduler: AccountTaskScheduler<QueueItem>;
  private readonly stoppedRequestIds = new Set<string>();
  private readonly executionWindows = new Map<string, BrowserWindow>();

  constructor(
    private readonly database: AppDatabase,
    private readonly onDataChanged: DataChangedCallback
  ) {
    this.scheduler = new AccountTaskScheduler(
      () => this.database.getSettings().maxConcurrentAccounts,
      async (item) => {
        try {
          if (item.mode === "recover") {
            await this.recoverResult(item.requestId);
          } else {
            await this.execute(item.requestId);
          }
        } finally {
          this.stoppedRequestIds.delete(item.requestId);
          this.executionWindows.delete(item.requestId);
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

  stop(requestId: string) {
    const request = this.database.getApiRequest(requestId);
    if (!request) throw new Error("Request not found");
    if (request.status !== "accepted" && request.status !== "running") {
      return { request, stopped: false, refunded: false };
    }

    const wasActive = this.scheduler.isActive(requestId);
    this.stoppedRequestIds.add(requestId);
    const win = this.executionWindows.get(requestId);
    if (win && !win.isDestroyed()) win.close();

    const result = this.database.stopApiRequestAndRefund(requestId);
    this.scheduler.cancel(requestId);
    this.database.appendOperationLog({
      requestId,
      accountId: result.request.accountId,
      action: "终止任务",
      status: "success",
      message: result.request.message
    });
    this.onDataChanged();
    void postCallback(result.request);
    if (!wasActive) this.stoppedRequestIds.delete(requestId);
    return result;
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

      win = this.createExecutionWindow(account, settings, requestId);
      await loadUrl(win, settings.doubaoChatUrl || "https://www.doubao.com/chat");
      await wait(2500);
      await dismissDoubaoDesktopDownloadPrompt(win);

      if (await looksLoggedOut(win)) {
        throw new Error("豆包账号未登录，无法恢复视频结果");
      }

      const recovery = await findGeneratedConversationAndCopyShare(
        win,
        request.prompt,
        request.doubaoThreadUrl,
        async (message) => {
          await this.updateProgress({ requestId, status: "running", message });
        }
      );
      if (!recovery.shareUrl) {
        if (recovery.failureMessage) {
          const shouldRefund = isQuotaNotChargedFailure(recovery.failureMessage)
            && !request.message.includes("已退回预扣额度");
          if (shouldRefund) this.database.refundApiRequestQuota(requestId);
          await this.failRequest(
            request,
            `豆包已返回视频生成失败：${recovery.failureMessage}`,
            shouldRefund
          );
          this.database.updateAccount({ id: account.id, currentStatus: "idle" });
          return;
        }
        if (recovery.pendingMatchCount > 0) {
          await this.updateProgress({
            requestId,
            status: "accepted",
            message: "豆包仍在后台生成视频，尚未返回完成结果；稍后可手动恢复结果，不会重新提交"
          });
          this.database.updateAccount({ id: account.id, currentStatus: "idle" });
          return;
        }
        throw new Error(
          `未找到可恢复的豆包视频：历史链接 ${recovery.candidateCount} 条，提示词匹配 ${recovery.promptMatchCount} 条，确认已生成 ${recovery.generatedMatchCount} 条，仍在生成 ${recovery.pendingMatchCount} 条，仍未复制到分享链接${recovery.shareFailureReason ? `（${recovery.shareFailureReason}）` : ""}`
        );
      }
      this.recordOperation(
        requestId,
        "复制分享地址",
        "success",
        "已复制豆包 thread/share 地址，等待去水印接口验证真实 MP4",
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
      if (this.isStopped(requestId, error)) {
        this.database.updateAccount({ id: account.id, currentStatus: "idle" });
        return;
      }
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

      win = this.createExecutionWindow(account, settings, requestId);
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

      const prepareSubmission = async (attempt: number) => {
        await this.updateProgress({
          requestId,
          status: "running",
          message: attempt === 1
            ? "正在切换豆包视频生成模式"
            : `豆包繁忙，正在进行第 ${attempt}/3 次提交`
        });
        await activateVideoMode(win!, request.model);

        if (request.aspectRatio) {
          await this.updateProgress({
            requestId,
            status: "running",
            message: `正在设置豆包画幅：${request.aspectRatio}`
          });
          const aspectRatioResult = await selectDoubaoAspectRatio(win!, request.aspectRatio);
          await this.updateProgress({
            requestId,
            status: "running",
            message: aspectRatioResult.attempts > 0
              ? `豆包画幅已确认：${aspectRatioResult.before || "未识别"} -> ${aspectRatioResult.after}（第 ${aspectRatioResult.attempts} 次）`
              : `豆包画幅已确认：${aspectRatioResult.after}`
          });
        }

        await this.updateProgress({
          requestId,
          status: "running",
          message: formatGenerationSettings(request)
        });

        if (request.referenceImagePath) {
          await this.updateProgress({
            requestId,
            status: "running",
            message: attempt === 1 ? "正在上传参考图" : "正在重新上传参考图"
          });
          await uploadReferenceImage(win!, request.referenceImagePath);
        }

        await this.updateProgress({
          requestId,
          status: "running",
          message: attempt === 1 ? "正在填写提示词" : "正在重新填写提示词"
        });
        await fillPrompt(win!, request.prompt);

        const selectedBeforeSubmit = await inspectSelectedVideoModel(win!);
        const requestedModel = request.model === "seedance_2_0_mini" ? "mini" : "fast";
        if (selectedBeforeSubmit.currentModel !== requestedModel) {
          throw new Error(
            `发送前模型校验失败：要求 ${doubaoVideoModelLabel(requestedModel)}，当前为 ${selectedBeforeSubmit.currentModel ? doubaoVideoModelLabel(selectedBeforeSubmit.currentModel) : "未识别"}`
          );
        }
      };

      let generationBaseline!: Awaited<ReturnType<typeof inspectGenerationPage>>;
      for (let submissionAttempt = 1; submissionAttempt <= 3; submissionAttempt += 1) {
        await prepareSubmission(submissionAttempt);
        await this.updateProgress({
          requestId,
          status: "running",
          message: submissionAttempt === 1
            ? "正在提交豆包生成"
            : `正在重试提交豆包生成（${submissionAttempt}/3）`
        });
        generationBaseline = await inspectGenerationPage(win);
        try {
          await submitPromptAndWait(
            win,
            request.model,
            request.prompt,
            async (message) => {
              await this.updateProgress({ requestId, status: "running", message });
            }
          );
          break;
        } catch (error) {
          if (!(error instanceof DoubaoCongestionError) || submissionAttempt >= 3) {
            throw error;
          }
          const delaySeconds = submissionAttempt === 1 ? 10 : 30;
          await this.updateProgress({
            requestId,
            status: "running",
            message: `豆包返回繁忙提示：${error.reply}；${delaySeconds} 秒后自动重试`
          });
          await wait(delaySeconds * 1000);
          await loadUrl(win, settings.doubaoChatUrl || "https://www.doubao.com/chat");
          await wait(2500);
          await dismissDoubaoDesktopDownloadPrompt(win);
        }
      }
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
        "已复制豆包 thread/share 地址，等待去水印接口验证真实 MP4",
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
      if (this.isStopped(requestId, error)) {
        this.database.updateAccount({ id: account.id, currentStatus: "idle" });
        return;
      }
      if (error instanceof DoubaoGenerationPendingError) {
        await this.updateProgress({
          requestId,
          status: "accepted",
          message: `${error.message}；稍后可手动恢复结果，不会重新提交`
        });
        this.database.updateAccount({ id: account.id, currentStatus: "idle" });
        this.onDataChanged();
        if (win && !win.isDestroyed()) win.close();
        return;
      }
      const shouldRefundQuota = !submittedToDoubao || isRefundableExecutionError(error);
      if (shouldRefundQuota) {
        this.database.refundApiRequestQuota(requestId);
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
    const current = this.database.getApiRequest(input.requestId);
    if (this.stoppedRequestIds.has(input.requestId) || current?.status === "stopped") {
      throw new DoubaoTaskStoppedError();
    }
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

  private createExecutionWindow(account: Account, settings: AppSettings, requestId: string) {
    const titleName = account.remark || account.name;
    const windowTitle = `豆包执行器 - ${titleName} - ${requestId.replace(/^doubao-/, "").slice(0, 6)}`;
    const win = new BrowserWindow({
      width: 1320,
      height: 860,
      show: settings.showExecutorWindow,
      title: windowTitle,
      webPreferences: {
        partition: account.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    win.on("page-title-updated", (event) => {
      event.preventDefault();
      win.setTitle(windowTitle);
    });
    this.executionWindows.set(requestId, win);
    win.once("closed", () => {
      if (this.executionWindows.get(requestId) === win) {
        this.executionWindows.delete(requestId);
      }
    });
    return win;
  }

  private isStopped(requestId: string, error: unknown) {
    return error instanceof DoubaoTaskStoppedError
      || this.stoppedRequestIds.has(requestId)
      || this.database.getApiRequest(requestId)?.status === "stopped";
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
  const diagnostics: string[] = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await sendKeyboard(win, "Escape", undefined, 150);
    let current = await waitForDoubaoVideoModelState(win, (state) => Boolean(state.currentModel), 800);
    if (current.currentModel === target) return;

    if (attempt === 2 && !current.currentModel) {
      const freshConversation = await findExactDoubaoActionPoint(win, "新对话");
      if (freshConversation) {
        await sendMouseClick(win, freshConversation.x, freshConversation.y);
        diagnostics.push("已重置到新对话");
        await wait(1200);
      }
    }

    if (!current.currentModel) {
      const videoMode = await findExactDoubaoActionPoint(win, "视频生成", true);
      if (videoMode) {
        await sendMouseClick(win, videoMode.x, videoMode.y);
        diagnostics.push(`第 ${attempt} 次点击视频入口 ${videoMode.debug}`);
        current = await waitForDoubaoVideoModelState(win, (state) => Boolean(state.currentModel), 3200);
        if (current.currentModel === target) return;
      } else {
        diagnostics.push(`第 ${attempt} 次未找到视频生成入口`);
      }
    }

    if (!current.currentModel) {
      diagnostics.push(`第 ${attempt} 次点击后仍未出现视频模型工具栏`);
      continue;
    }

    const opened = await clickDoubaoModelTrigger(win);
    if (!opened) {
      diagnostics.push(`第 ${attempt} 次未找到模型入口`);
      continue;
    } else {
      await sendMouseClick(win, opened.x, opened.y);
      diagnostics.push(`第 ${attempt} 次点击模型入口 ${opened.debug}`);
    }
    const option = await waitForDoubaoVideoModelOption(win, target, 2600);
    if (!option) {
      diagnostics.push(`第 ${attempt} 次模型菜单未找到 ${targetLabel}`);
      continue;
    }
    await sendMouseClick(win, option.x, option.y);
    const selected = await waitForDoubaoVideoModelState(win, (state) => state.currentModel === target, 3200);
    if (selected.currentModel === target) return;
    diagnostics.push(`第 ${attempt} 次已点击 ${option.debug}，工具栏仍为 ${selected.labels.join(" | ") || "未识别"}`);
  }

  const state = await inspectSelectedVideoModel(win);
  const aspectState = await inspectSelectedDoubaoAspectRatio(win);
  throw new Error(
    `豆包模型未确认：要求 ${targetLabel}，当前为 ${state.currentModel ? doubaoVideoModelLabel(state.currentModel) : "未识别"}`
      + `；页面 ${win.webContents.getURL()}`
      + `；可见模型 ${state.labels.join(" | ") || "无"}`
      + `；画幅控件 ${aspectState.summary || aspectState.labels.join(" | ") || "无"}`
      + `；${diagnostics.join("；")}`
  );
}

async function findExactDoubaoActionPoint(win: BrowserWindow, label: string, allowPrefix = false) {
  return runPageScript<{ x: number; y: number; debug: string } | null>(win, `
    (() => {
      const label = ${JSON.stringify(label)};
      const allowPrefix = ${JSON.stringify(allowPrefix)};
      const compact = (value) => String(value || "").replace(/[^\\p{L}\\p{N}]+/gu, "").trim();
      const targetText = compact(label);
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4
          && rect.bottom > 0 && rect.right > 0
          && rect.top < window.innerHeight && rect.left < window.innerWidth
          && style.visibility !== "hidden" && style.display !== "none"
          && style.pointerEvents !== "none" && Number(style.opacity || "1") > 0.05;
      };
      const textOf = (el) => ([
        el.innerText,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.textContent
      ].find((value) => String(value || "").trim()) || "").replace(/\\s+/g, " ").trim();
      const candidates = Array.from(document.querySelectorAll('body *'))
        .filter(visible)
        .filter((el) => !el.closest('[role="dialog"], [role="menu"], [role="listbox"]'))
        .map((el) => {
          const text = textOf(el);
          const normalized = compact(text);
          const clickable = el.closest('button, [role="button"], a, [tabindex], [aria-label], [title]') || el;
          const rect = clickable.getBoundingClientRect();
          const exact = normalized === targetText;
          const prefix = allowPrefix && normalized.startsWith(targetText)
            && normalized.length <= targetText.length + 24;
          const selected = clickable.getAttribute("aria-selected") === "true"
            || clickable.getAttribute("aria-pressed") === "true"
            || /selected|active|checked/.test(String(clickable.className || "").toLowerCase());
          return { clickable, text, rect, exact, prefix, selected };
        })
        .filter((item) => item.exact || item.prefix)
        .filter((item, index, items) => items.findIndex((candidate) => candidate.clickable === item.clickable) === index)
        .sort((a, b) => Number(b.exact) - Number(a.exact)
          || Number(b.selected) - Number(a.selected)
          || b.rect.bottom - a.rect.bottom
          || a.rect.width * a.rect.height - b.rect.width * b.rect.height);
      const target = candidates[0];
      return target ? {
        x: Math.round(target.rect.left + target.rect.width / 2),
        y: Math.round(target.rect.top + target.rect.height / 2),
        debug: target.text
      } : null;
    })()
  `);
}

type DoubaoVideoModelState = {
  currentModel: "mini" | "fast" | null;
  labels: string[];
};

async function inspectSelectedVideoModel(win: BrowserWindow) {
  return runPageScript<DoubaoVideoModelState>(win, `
    (() => {
      const modelFromText = ${doubaoVideoModelFromText.toString()};
      const isModelTriggerText = ${isDoubaoVideoModelTriggerText.toString()};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4
          && rect.bottom > 0 && rect.right > 0
          && rect.top < window.innerHeight && rect.left < window.innerWidth
          && style.visibility !== "hidden" && style.display !== "none"
          && Number(style.opacity || "1") > 0.05;
      };
      const textOf = (el) => ([
        el.innerText,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.textContent
      ].find((value) => String(value || "").trim()) || "").replace(/\\s+/g, " ").trim();
      const editors = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]'))
        .filter((el) => visible(el) && !el.disabled && !el.readOnly)
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const editor = editors[0] || null;
      const editorRect = editor?.getBoundingClientRect() || null;
      const nodes = Array.from(document.querySelectorAll('body *'))
        .filter(visible)
        .map((el) => {
          const text = textOf(el);
          const rect = el.getBoundingClientRect();
          return {
            text,
            model: modelFromText(text),
            rect,
            toolbarLabel: isModelTriggerText(text),
            nearEditor: Boolean(editorRect
              && rect.bottom >= editorRect.top - 320
              && rect.top <= editorRect.bottom + 40
              && rect.bottom > window.innerHeight * 0.45)
          };
        })
        .filter((item) => item.model && item.toolbarLabel && item.nearEditor)
        .sort((a, b) => b.rect.bottom - a.rect.bottom || a.rect.width * a.rect.height - b.rect.width * b.rect.height);
      const trigger = nodes[0];
      return {
        currentModel: trigger?.model || null,
        labels: nodes.map((item) => item.text).slice(0, 12)
      };
    })()
  `);
}

async function clickDoubaoModelTrigger(win: BrowserWindow) {
  return runPageScript<{ x: number; y: number; debug: string } | null>(win, `
    (() => {
      const modelFromText = ${doubaoVideoModelFromText.toString()};
      const isModelTriggerText = ${isDoubaoVideoModelTriggerText.toString()};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4
          && rect.bottom > 0 && rect.right > 0
          && rect.top < window.innerHeight && rect.left < window.innerWidth
          && style.visibility !== "hidden" && style.display !== "none"
          && style.pointerEvents !== "none" && Number(style.opacity || "1") > 0.05;
      };
      const textOf = (el) => ([
        el.innerText,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.textContent
      ].find((value) => String(value || "").trim()) || "").replace(/\\s+/g, " ").trim();
      const editors = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]'))
        .filter((el) => visible(el) && !el.disabled && !el.readOnly)
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const editor = editors[0] || null;
      const editorRect = editor?.getBoundingClientRect() || null;
      const candidates = Array.from(document.querySelectorAll('body *'))
        .filter(visible)
        .map((el) => {
          const text = textOf(el);
          const clickable = el.closest('button, [role="button"], [aria-haspopup], [tabindex]') || el;
          const rect = clickable.getBoundingClientRect();
          return {
            clickable,
            text,
            model: modelFromText(text),
            rect,
            optionLike: Boolean(el.closest('[role="option"], [role="menuitem"], [role="listbox"]')),
            toolbarLabel: isModelTriggerText(text),
            nearEditor: Boolean(editorRect
              && rect.bottom >= editorRect.top - 320
              && rect.top <= editorRect.bottom + 40
              && rect.bottom > window.innerHeight * 0.45)
          };
        })
        .filter((item) => item.nearEditor && item.toolbarLabel && item.model)
        .filter((item) => !item.optionLike)
        .filter((item, index, items) => items.findIndex((candidate) => candidate.clickable === item.clickable) === index)
        .sort((a, b) => b.rect.bottom - a.rect.bottom || a.rect.width * a.rect.height - b.rect.width * b.rect.height);
      const target = candidates[0];
      if (!target) return null;
      return {
        x: Math.round(target.rect.left + target.rect.width / 2),
        y: Math.round(target.rect.top + target.rect.height / 2),
        debug: target.text
      };
    })()
  `);
}

async function clickExactDoubaoModelOption(win: BrowserWindow, model: "mini" | "fast") {
  return runPageScript<{ x: number; y: number; debug: string } | null>(win, `
    (() => {
      const modelFromText = ${doubaoVideoModelFromText.toString()};
      const target = ${JSON.stringify(model)};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4
          && rect.bottom > 0 && rect.right > 0
          && rect.top < window.innerHeight && rect.left < window.innerWidth
          && style.visibility !== "hidden" && style.display !== "none"
          && style.pointerEvents !== "none" && Number(style.opacity || "1") > 0.05;
      };
      const textOf = (el) => ([
        el.innerText,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.textContent
      ].find((value) => String(value || "").trim()) || "").replace(/\\s+/g, " ").trim();
      const compactText = (el) => textOf(el).replace(/\\s+/g, "");
      const insideModelMenu = (el) => {
        let parent = el.parentElement;
        for (let depth = 0; parent && depth < 12; depth += 1, parent = parent.parentElement) {
          if (!visible(parent)) continue;
          const rect = parent.getBoundingClientRect();
          const text = compactText(parent);
          if (rect.width <= 800 && rect.height <= 800
            && text.includes("Seedance2.0Mini")
            && text.includes("Seedance2.0Fast")) {
            return true;
          }
        }
        return false;
      };
      const candidates = Array.from(document.querySelectorAll('body *'))
        .filter(visible)
        .map((el) => {
          const text = textOf(el);
          const clickable = el.closest('button, [role="button"], [role="option"], [role="menuitem"], [tabindex]') || el;
          const rect = clickable.getBoundingClientRect();
          return {
            clickable,
            text,
            model: modelFromText(text),
            rect,
            insideModelMenu: insideModelMenu(el)
          };
        })
        .filter((item) => item.model === target)
        .filter((item) => item.insideModelMenu)
        .filter((item, index, items) => items.findIndex((candidate) => candidate.clickable === item.clickable) === index)
        .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height || b.rect.bottom - a.rect.bottom);
      const option = candidates[0];
      if (!option) return null;
      return {
        x: Math.round(option.rect.left + option.rect.width / 2),
        y: Math.round(option.rect.top + option.rect.height / 2),
        debug: option.text
      };
    })()
  `);
}

async function waitForDoubaoVideoModelState(
  win: BrowserWindow,
  predicate: (state: DoubaoVideoModelState) => boolean,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;
  let latest: DoubaoVideoModelState = { currentModel: null, labels: [] };
  while (Date.now() < deadline) {
    try {
      latest = await inspectSelectedVideoModel(win);
      if (predicate(latest)) return latest;
    } catch {
      // The composer can be replaced briefly while switching creation modes.
    }
    await wait(250);
  }
  return latest;
}

async function waitForDoubaoVideoModelOption(
  win: BrowserWindow,
  model: "mini" | "fast",
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const option = await clickExactDoubaoModelOption(win, model);
      if (option) return option;
    } catch {
      // Retry while the model popover mounts.
    }
    await wait(200);
  }
  return null;
}

type DoubaoAspectRatioState = {
  currentAspectRatio: DoubaoAspectRatio | null;
  summary: string | null;
  labels: string[];
};

async function inspectSelectedDoubaoAspectRatio(win: BrowserWindow) {
  return runPageScript<DoubaoAspectRatioState>(win, `
    (() => {
      const ratioFromText = ${doubaoAspectRatioFromText.toString()};
      const isTriggerText = ${isDoubaoAspectRatioTriggerText.toString()};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4
          && rect.height > 4
          && rect.bottom > 0
          && rect.right > 0
          && rect.top < window.innerHeight
          && rect.left < window.innerWidth
          && style.visibility !== "hidden"
          && style.display !== "none"
          && Number(style.opacity || "1") > 0.05
          && el.getAttribute("aria-hidden") !== "true";
      };
      const textOf = (el) => ([
        el.innerText,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("data-value"),
        el.textContent
      ].find((value) => String(value || "").trim()) || "").replace(/\\s+/g, " ").trim();
      const editors = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]'))
        .filter((el) => visible(el) && !el.disabled && !el.readOnly)
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const editor = editors[0] || null;
      let composerRoot = editor;
      for (let parent = editor?.parentElement, depth = 0; parent && depth < 10; parent = parent.parentElement, depth += 1) {
        const rect = parent.getBoundingClientRect();
        if (rect.height > 520) break;
        if (rect.width >= 260 && rect.bottom > window.innerHeight * 0.5) composerRoot = parent;
      }
      const sourceNodes = composerRoot
        ? [composerRoot, ...Array.from(composerRoot.querySelectorAll('*'))]
        : Array.from(document.querySelectorAll('body *'));
      const items = sourceNodes
        .filter(visible)
        .map((el) => {
          const interactive = el.closest('button, [role="button"], [aria-haspopup], [aria-expanded], [tabindex]');
          const clickable = interactive || (getComputedStyle(el).cursor === "pointer" ? el : null);
          const rect = (clickable || el).getBoundingClientRect();
          const text = textOf(el);
          return {
            el,
            text,
            ratio: ratioFromText(text),
            summary: Boolean(clickable) && isTriggerText(text)
              && (!composerRoot || composerRoot.contains(clickable)),
            rect
          };
        })
        .filter((item) => item.ratio);
      const trigger = items
        .filter((item) => item.summary)
        .sort((a, b) => b.rect.bottom - a.rect.bottom || a.text.length - b.text.length)[0];
      return {
        // Only the collapsed toolbar summary is authoritative. A highlighted
        // option in an open popover does not prove that Doubao applied it.
        currentAspectRatio: trigger?.ratio || null,
        summary: trigger?.text || null,
        labels: items.map((item) => item.text).slice(0, 12)
      };
    })()
  `);
}

async function clickDoubaoAspectRatioTrigger(win: BrowserWindow) {
  return runPageScript<{ x: number; y: number; debug: string } | null>(win, `
    (() => {
      const isTriggerText = ${isDoubaoAspectRatioTriggerText.toString()};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4
          && rect.height > 4
          && rect.bottom > 0
          && rect.right > 0
          && rect.top < window.innerHeight
          && rect.left < window.innerWidth
          && style.visibility !== "hidden"
          && style.display !== "none"
          && style.pointerEvents !== "none"
          && Number(style.opacity || "1") > 0.05
          && el.getAttribute("aria-hidden") !== "true";
      };
      const textOf = (el) => ([
        el.innerText,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("data-value"),
        el.textContent
      ].find((value) => String(value || "").trim()) || "").replace(/\\s+/g, " ").trim();
      const editors = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]'))
        .filter((el) => visible(el) && !el.disabled && !el.readOnly)
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const editor = editors[0] || null;
      let composerRoot = editor;
      for (let parent = editor?.parentElement, depth = 0; parent && depth < 10; parent = parent.parentElement, depth += 1) {
        const rect = parent.getBoundingClientRect();
        if (rect.height > 520) break;
        if (rect.width >= 260 && rect.bottom > window.innerHeight * 0.5) composerRoot = parent;
      }
      const sourceNodes = composerRoot
        ? [composerRoot, ...Array.from(composerRoot.querySelectorAll('*'))]
        : Array.from(document.querySelectorAll('body *'));
      const candidates = sourceNodes
        .filter(visible)
        .map((el) => {
          const text = textOf(el);
          const clickable = el.closest('button, [role="button"], [aria-haspopup], [aria-expanded], [tabindex]')
            || (getComputedStyle(el).cursor === "pointer" ? el : null);
          if (!clickable) return null;
          const rect = clickable.getBoundingClientRect();
          return {
            text,
            clickable,
            inToolbarRegion: !composerRoot || composerRoot.contains(clickable),
            rect
          };
        })
        .filter(Boolean)
        .filter((item) => item.inToolbarRegion && isTriggerText(item.text))
        .filter((item, index, items) => items.findIndex((candidate) => candidate.clickable === item.clickable) === index)
        .sort((a, b) => b.rect.bottom - a.rect.bottom || a.rect.width * a.rect.height - b.rect.width * b.rect.height);
      const target = candidates[0];
      if (!target) return null;
      return {
        x: Math.round(target.rect.left + target.rect.width / 2),
        y: Math.round(target.rect.top + target.rect.height / 2),
        debug: target.text
      };
    })()
  `);
}

async function clickExactDoubaoAspectRatioOption(win: BrowserWindow, targetRatio: DoubaoAspectRatio) {
  return runPageScript<{ x: number; y: number; debug: string } | null>(win, `
    (() => {
      const targetRatio = ${JSON.stringify(targetRatio)};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4
          && rect.height > 4
          && rect.bottom > 0
          && rect.right > 0
          && rect.top < window.innerHeight
          && rect.left < window.innerWidth
          && style.visibility !== "hidden"
          && style.display !== "none"
          && style.pointerEvents !== "none"
          && Number(style.opacity || "1") > 0.05
          && el.getAttribute("aria-hidden") !== "true";
      };
      const textOf = (el) => ([
        el.innerText,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("data-value"),
        el.textContent
      ].find((value) => String(value || "").trim()) || "").replace(/\\s+/g, " ").trim();
      const compactText = (el) => textOf(el).replace(/\s+/g, "");
      const insideRatioMenu = (el) => {
        let parent = el.parentElement;
        for (let depth = 0; parent && depth < 9; depth += 1, parent = parent.parentElement) {
          if (!visible(parent)) continue;
          const rect = parent.getBoundingClientRect();
          const text = compactText(parent);
          if (rect.width <= 720
            && rect.height <= 720
            && text.includes("比例")
            && text.includes("自动")
            && text.includes("9:16")
            && text.includes("16:9")) {
            return true;
          }
        }
        return false;
      };
      const candidates = Array.from(document.querySelectorAll('body *'))
        .filter(visible)
        .map((el) => {
          const text = textOf(el);
          const clickable = el.closest('button, [role="button"], [role="option"], [role="menuitem"], [tabindex]') || el;
          const rect = clickable.getBoundingClientRect();
          return {
            text,
            exact: text.replace(/\s+/g, "") === targetRatio,
            insideRatioMenu: insideRatioMenu(el),
            clickable,
            rect
          };
        })
        .filter((item) => item.exact && item.insideRatioMenu)
        .filter((item, index, items) => items.findIndex((candidate) => candidate.clickable === item.clickable) === index)
        .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height || b.rect.bottom - a.rect.bottom);
      const target = candidates[0];
      if (!target) return null;
      return {
        x: Math.round(target.rect.left + target.rect.width / 2),
        y: Math.round(target.rect.top + target.rect.height / 2),
        debug: target.text
      };
    })()
  `);
}

async function waitForDoubaoAspectRatioState(
  win: BrowserWindow,
  predicate: (state: DoubaoAspectRatioState) => boolean,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;
  let latest: DoubaoAspectRatioState = { currentAspectRatio: null, summary: null, labels: [] };
  while (Date.now() < deadline) {
    try {
      latest = await inspectSelectedDoubaoAspectRatio(win);
      if (predicate(latest)) return latest;
    } catch {
      // The page can briefly replace the composer while video mode initializes.
    }
    await wait(250);
  }
  return latest;
}

async function waitForDoubaoAspectRatioOption(
  win: BrowserWindow,
  targetRatio: DoubaoAspectRatio,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const option = await clickExactDoubaoAspectRatioOption(win, targetRatio);
      if (option) return option;
    } catch {
      // Retry while the popover mounts or the page replaces a transient node.
    }
    await wait(200);
  }
  return null;
}

async function selectDoubaoAspectRatio(win: BrowserWindow, targetRatio: DoubaoAspectRatio) {
  const initial = await waitForDoubaoAspectRatioState(win, (state) => Boolean(state.summary), 2500);
  if (initial.currentAspectRatio === targetRatio) {
    return { before: initial.currentAspectRatio, after: initial.currentAspectRatio, attempts: 0 };
  }

  const diagnostics: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await sendKeyboard(win, "Escape", undefined, 180);
    const before = await waitForDoubaoAspectRatioState(win, (state) => Boolean(state.summary), 1800);
    if (before.currentAspectRatio === targetRatio) {
      return { before: initial.currentAspectRatio, after: before.currentAspectRatio, attempts: attempt - 1 };
    }

    let trigger: Awaited<ReturnType<typeof clickDoubaoAspectRatioTrigger>> = null;
    try {
      trigger = await clickDoubaoAspectRatioTrigger(win);
    } catch {
      // Retry from a clean menu state below.
    }
    if (!trigger) {
      diagnostics.push(`第 ${attempt} 次未找到工具栏画幅入口（当前 ${before.summary || "未识别"}）`);
      continue;
    }

    await sendMouseClick(win, trigger.x, trigger.y);
    const option = await waitForDoubaoAspectRatioOption(win, targetRatio, 2600);
    if (!option) {
      diagnostics.push(`第 ${attempt} 次已点击入口 ${trigger.debug}，但比例弹窗内未找到 ${targetRatio}`);
      continue;
    }

    await sendMouseClick(win, option.x, option.y);
    const selected = await waitForDoubaoAspectRatioState(
      win,
      (state) => state.currentAspectRatio === targetRatio,
      3200
    );
    if (selected.currentAspectRatio === targetRatio) {
      await sendKeyboard(win, "Escape", undefined, 150);
      return { before: initial.currentAspectRatio, after: selected.currentAspectRatio, attempts: attempt };
    }
    diagnostics.push(
      `第 ${attempt} 次入口 ${trigger.debug}，已点击选项 ${option.debug}，点击后 ${selected.summary || selected.currentAspectRatio || "未识别"}`
    );
  }

  const state = await waitForDoubaoAspectRatioState(win, () => false, 600);
  throw new Error(
    `豆包画幅未确认：要求 ${targetRatio}，当前为 ${state.currentAspectRatio || "未识别"}`
      + `；页面 ${win.webContents.getURL()}`
      + `；可见画幅 ${state.labels.join(" | ") || "无"}`
      + `；${diagnostics.join("；") || "未取得有效操作诊断"}`
  );
}

async function submitPromptAndWait(
  win: BrowserWindow,
  model: DoubaoModel,
  prompt: string,
  onProgress: (message: string) => Promise<void> | void = () => undefined,
  suggestionFollowUpCount = 0
): Promise<"confirmed"> {
  const baselineText = await getRawPageText(win);
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
    const result = await waitForSubmissionStarted(win, model, baselineText, prompt, 12000);
    if (result.safetyConfirmationClicked) {
      await onProgress("检测到豆包素材安全确认，已点击确认");
    }
    if (result.failureMessage) {
      throw new DoubaoPageFailureError(
        `豆包提交后返回失败：${result.failureMessage}`,
        isQuotaNotChargedFailure(result.failureMessage)
      );
    }
    if (result.confirmationClicked) {
      await onProgress(`已点击豆包“${result.confirmationLabel || "确认生成"}”，等待视频任务启动`);
    }
    if (result.confirmed || result.pending) return "confirmed";
    if (result.responseMessage) {
      if (isDoubaoCongestionReply(result.responseMessage)) {
        throw new DoubaoCongestionError(result.responseMessage);
      }
      if (isDoubaoGenerationPending(result.responseMessage)) {
        await onProgress("豆包已确认视频任务，当前正在生成或渲染，继续等待结果");
        return "confirmed";
      }
      if (isDoubaoPromptSuggestion(result.responseMessage)) {
        if (suggestionFollowUpCount >= 3) {
          throw new DoubaoPageFailureError(
            `豆包连续返回提示词建议，已尝试明确生成指令但仍未确认视频生成：${result.responseMessage}`,
            true
          );
        }
        // Doubao now commonly presents a short action reply with a visible
        // “确认生成” action. Use that exact action first; only fall back to
        // the longer direct-generation wording when the first response does
        // not start the video task.
        const followUp = suggestionFollowUpCount === 0
          ? DIRECT_GENERATION_CONFIRM_FOLLOW_UP
          : suggestionFollowUpCount === 1
            ? DIRECT_GENERATION_FOLLOW_UP
            : DIRECT_GENERATION_SHORT_FOLLOW_UP;
        await onProgress(suggestionFollowUpCount === 0
          ? `豆包先返回了提示词建议，优先回复“${followUp}”并继续提交`
          : suggestionFollowUpCount === 1
            ? `豆包未按“确认生成”启动任务，正在回复“${followUp}”并继续提交`
            : `豆包仍未执行视频生成，正在发送备用指令“${followUp}”`);
        await fillPrompt(win, followUp);
        return submitPromptAndWait(win, model, followUp, onProgress, suggestionFollowUpCount + 1);
      }
      throw new DoubaoPageFailureError(
        `豆包没有确认视频生成；页面最新回复：${result.responseMessage}`,
        true
      );
    }
    if (result.sentEvidence) {
      throw new DoubaoPageFailureError(
        "豆包已收到消息，但没有确认已启动视频生成；为避免误判成功和重复提交，本次已停止等待",
        true
      );
    }
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

async function findDoubaoGenerationActionPoint(win: BrowserWindow, baselineText: string) {
  return runPageScript<{ x: number; y: number; debug: string } | null>(win, `
    (() => {
      const baselineText = ${JSON.stringify(baselineText)};
      const isDoubaoGenerationActionText = ${isDoubaoGenerationActionText.toString()};
      const pageText = document.body?.innerText || "";
      if (baselineText && pageText === baselineText) return null;
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 20
          && rect.height > 10
          && style.visibility !== "hidden"
          && style.display !== "none"
          && style.pointerEvents !== "none"
          && !el.disabled
          && el.getAttribute("aria-disabled") !== "true";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const candidates = Array.from(document.querySelectorAll(
        'button, [role="button"], a, [tabindex], [aria-label], [title], [class*="button"], [class*="Button"], [class*="btn"], div, span'
      ))
        .filter(visible)
        .map((el, index) => {
          const rect = el.getBoundingClientRect();
          const text = textOf(el);
          const style = getComputedStyle(el);
          const className = typeof el.className === "string" ? el.className : "";
          const interactive = el.matches('button, [role="button"], a, [tabindex], [aria-label], [title], [onclick]')
            || style.cursor === "pointer"
            || /button|btn|confirm|action/i.test(className);
          return { el, index, rect, text, interactive, area: rect.width * rect.height };
        })
        .filter((item) => item.interactive && isDoubaoGenerationActionText(item.text))
        .sort((a, b) => Number(b.interactive) - Number(a.interactive)
          || a.area - b.area
          || b.rect.bottom - a.rect.bottom
          || b.index - a.index);
      const target = candidates[0];
      if (!target) return null;
      return {
        x: Math.round(target.rect.left + target.rect.width / 2),
        y: Math.round(target.rect.top + target.rect.height / 2),
        debug: target.text
      };
    })()
  `);
}

async function findDoubaoSafetyConfirmationPoint(win: BrowserWindow) {
  return runPageScript<{ x: number; y: number; debug: string } | null>(win, `
    (() => {
      const isDoubaoSafetyConfirmationDialog = ${isDoubaoSafetyConfirmationDialog.toString()};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 20
          && rect.height > 20
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
      const hasExactText = (el, expected) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).some((value) => String(value).replace(/[^\\p{L}\\p{N}]+/gu, "") === expected);
      const safetyHeadingNodes = Array.from(document.querySelectorAll('body *'))
        .filter(visible)
        .filter((el) => /安全确认/.test(textOf(el)));
      const contexts = [];
      for (const heading of safetyHeadingNodes) {
        let context = heading;
        for (let level = 0; context && level < 12; level += 1, context = context.parentElement) {
          const text = textOf(context);
          if (isDoubaoSafetyConfirmationDialog(text)) {
            contexts.push({ el: context, text });
          }
        }
      }
      const dialogs = contexts
        .filter((item, index, all) => all.findIndex((other) => other.el === item.el) === index)
        .sort((a, b) => a.text.length - b.text.length);
      const dialog = dialogs[0];
      if (!dialog) return null;
      // Doubao may render these actions as div/span pseudo-buttons without a
      // role or tabindex. The exact text and the bounded safety context keep
      // this from clicking unrelated page-level “确认” actions.
      const buttons = Array.from(dialog.el.querySelectorAll('button, [role="button"], [tabindex], [aria-label], [title], a, label, div, span'))
        .filter(visible)
        .map((el) => ({ el, text: textOf(el), rect: el.getBoundingClientRect() }))
        .filter((item) => !item.el.disabled
          && item.el.getAttribute("aria-disabled") !== "true"
          && hasExactText(item.el, "确认"))
        .sort((a, b) => {
          const aRole = a.el.matches('button, [role="button"], [tabindex], a, label') ? 1 : 0;
          const bRole = b.el.matches('button, [role="button"], [tabindex], a, label') ? 1 : 0;
          return bRole - aRole
            || a.rect.width * a.rect.height - b.rect.width * b.rect.height
            || a.rect.top - b.rect.top;
        });
      const target = buttons[0];
      if (!target) return null;
      return {
        x: Math.round(target.rect.left + target.rect.width / 2),
        y: Math.round(target.rect.top + target.rect.height / 2),
        debug: target.text
      };
    })()
  `);
}

async function sendMouseClick(win: BrowserWindow, x: number, y: number) {
  await sendMouseMove(win, x, y);
  await wait(80);
  win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  await wait(80);
  win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
}

async function sendMouseMove(win: BrowserWindow, x: number, y: number) {
  win.webContents.sendInputEvent({ type: "mouseMove", x, y });
  await wait(80);
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
  let sentEvidenceSeen = false;
  let latestResponseMessage: string | null = null;
  let confirmationClicked = false;
  let confirmationLabel: string | null = null;
  let safetyConfirmationClicked = false;
  while (Date.now() - startedAt < timeoutMs) {
    if (!safetyConfirmationClicked) {
      try {
        const safetyPoint = await findDoubaoSafetyConfirmationPoint(win);
        if (safetyPoint) {
          await sendMouseClick(win, safetyPoint.x, safetyPoint.y);
          safetyConfirmationClicked = true;
          await wait(900);
        }
      } catch (error) {
        console.warn("豆包素材安全确认暂时无法检查", error);
      }
    }
    if (!confirmationClicked) {
      try {
        const actionPoint = await findDoubaoGenerationActionPoint(win, baselineText);
        if (actionPoint) {
          await sendMouseClick(win, actionPoint.x, actionPoint.y);
          confirmationClicked = true;
          confirmationLabel = actionPoint.debug;
          await wait(900);
        }
      } catch (error) {
        console.warn("豆包确认生成按钮暂时无法检查", error);
      }
    }

    const state = await runPageScript<{
      confirmed: boolean;
      pending: boolean;
      sentEvidence: boolean;
      failureMessage: string | null;
      responseMessage: string | null;
      pageTextExcerpt: string;
    }>(win, `
      (() => {
        const modelLabel = ${JSON.stringify(modelLabel)};
        const baselineText = ${JSON.stringify(baselineText)};
        const prompt = ${JSON.stringify(prompt)};
        const extractDoubaoFailureMessage = ${extractDoubaoFailureMessage.toString()};
        const extractNewDoubaoReply = ${extractNewDoubaoReply.toString()};
        const hasNewDoubaoSubmissionConfirmation = ${hasNewDoubaoSubmissionConfirmation.toString()};
        const isDoubaoSafetyConfirmationDialog = ${isDoubaoSafetyConfirmationDialog.toString()};
        const hasNewPromptOccurrence = ${hasNewPromptOccurrence.toString()};
        const hasNewTextOccurrence = ${hasNewTextOccurrence.toString()};
        const hasStrongSubmissionEvidence = ${hasStrongSubmissionEvidence.toString()};
        const isFormalDoubaoConversationUrl = ${isFormalDoubaoConversationUrl.toString()};
        const safetyConfirmationClicked = ${JSON.stringify(safetyConfirmationClicked)};
        const pageText = (document.body?.innerText || "").trim();
        const failureMessage = extractDoubaoFailureMessage(pageText);
        const newFailureMessage = failureMessage && hasNewTextOccurrence(pageText, baselineText, failureMessage)
          ? failureMessage
          : null;
        const rawResponseMessage = extractNewDoubaoReply(pageText, baselineText, prompt);
        const responseMessage = rawResponseMessage
          && !(safetyConfirmationClicked
            && (isDoubaoSafetyConfirmationDialog(rawResponseMessage)
              || rawResponseMessage.includes("安全确认")))
          ? rawResponseMessage
          : null;
        const normalizedResponseMessage = (rawResponseMessage || "").replace(/\\s+/g, " ").replace(/\\*+/g, "").trim();
        const pendingResponse = Boolean(
          normalizedResponseMessage
          && !extractDoubaoFailureMessage(normalizedResponseMessage)
          && !/你的视频(?:已经|已)?生成好[了啦]|视频(?:已经|已)?生成(?:完成|成功|好[了啦])|生成视频(?:已经|已)?完成/.test(normalizedResponseMessage)
          && (/正在为您生成一段|视频生成中|视频生成已提交|已提交视频生成任务|已提交生成任务|生成任务已提交|正在渲染|等待(?:视频)?(?:生成|渲染)(?:完成|结果)/.test(normalizedResponseMessage)
            || (/本次使用\\s+Seedance\\s+2\\.0\\s+(?:Mini|Fast)\\s+生成/.test(normalizedResponseMessage)
              && /预计等待\\s*\\d+\\s*分钟|视频生成好后|本次生成将消耗每日免费额度/.test(normalizedResponseMessage)))
        );
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
        const confirmationTextAdded = hasNewDoubaoSubmissionConfirmation(pageText, baselineText, modelLabel);
        const promptMessageAdded = hasNewPromptOccurrence(pageText, baselineText, prompt);
        const sentEvidence = !newFailureMessage && hasStrongSubmissionEvidence({
          confirmationTextAdded,
          promptMessageAdded,
          formalConversationUrl: isFormalDoubaoConversationUrl(location.href),
          composerCleared,
          pageChanged
        });
        return {
          confirmed: confirmationTextAdded,
          // Keep a direct fallback when reply extraction contains the accepted
          // status sentence but baseline counting is ambiguous.
          pending: pendingResponse,
          sentEvidence,
          failureMessage: newFailureMessage,
          responseMessage,
          pageTextExcerpt: pageText.slice(-500)
        };
      })()
    `);

    if (state.failureMessage) {
      return {
        confirmed: false,
        pending: false,
        sentEvidence: false,
        failureMessage: state.failureMessage,
        responseMessage: null,
        confirmationClicked,
        confirmationLabel,
        safetyConfirmationClicked
      };
    }
    if (state.confirmed || state.pending) {
      return {
        confirmed: state.confirmed,
        pending: state.pending,
        sentEvidence: true,
        failureMessage: null,
        responseMessage: null,
        confirmationClicked,
        confirmationLabel,
        safetyConfirmationClicked
      };
    }
    sentEvidenceSeen ||= state.sentEvidence;
    if (!confirmationClicked) {
      latestResponseMessage = state.responseMessage || latestResponseMessage;
    }
    await wait(1000);
  }

  return {
    confirmed: false,
    pending: false,
    sentEvidence: sentEvidenceSeen,
    failureMessage: null,
    responseMessage: confirmationClicked ? null : latestResponseMessage,
    confirmationClicked,
    confirmationLabel,
    safetyConfirmationClicked
  };
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
  let generatedRecoveryAttempted = false;

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

      if (!generatedRecoveryAttempted) {
        generatedRecoveryAttempted = true;
        await onProgress("当前分享页尚未同步视频，正在回到本次豆包会话自动恢复结果");
        const originalUrl = win.webContents.getURL();
        const recovery = await findGeneratedConversationAndCopyShare(
          win,
          prompt,
          extractDoubaoConversationUrl(originalUrl) || preferredConversationUrl,
          onProgress
        );
        if (recovery.shareUrl) {
          return { shareUrl: recovery.shareUrl, directVideoUrl };
        }
        shareFailureReason = recovery.shareFailureReason || recovery.failureMessage || shareFailureReason;
        if (originalUrl) {
          await loadUrl(win, originalUrl);
          await wait(1500);
          await dismissDoubaoDesktopDownloadPrompt(win);
        }
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
        currentConversationUrl || preferredConversationUrl,
        onProgress
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
    extractDoubaoConversationUrl(win.webContents.getURL()) || preferredConversationUrl,
    onProgress
  );
  if (recovery.shareUrl) {
    return { shareUrl: recovery.shareUrl, directVideoUrl };
  }
  if (recovery.generatedMatchCount > 0) {
    return { shareUrl: null, directVideoUrl, shareFailureReason: recovery.shareFailureReason };
  }
  if (recovery.failureMessage) {
    throw new DoubaoPageFailureError(
      `豆包已返回视频生成失败：${recovery.failureMessage}`,
      isQuotaNotChargedFailure(recovery.failureMessage)
    );
  }
  if (recovery.pendingMatchCount > 0) {
    throw new DoubaoGenerationPendingError("等待时间已到，但豆包页面仍明确显示视频生成中");
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
      const generatedMedia = [];
      const completionTextNodes = Array.from(document.querySelectorAll("*"))
        .filter((el) => {
          const ownText = Array.from(el.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent || "")
            .join(" ")
            .replace(/\\s+/g, " ")
            .trim();
          return /你的视频(?:已经|已)?生成好[了啦]|视频(?:已经|已)?生成(?:完成|成功|好[了啦])|生成视频(?:已经|已)?完成/.test(ownText);
        });
      for (const node of completionTextNodes) {
        let ancestor = node;
        for (let level = 0; ancestor && level < 8; level += 1, ancestor = ancestor.parentElement) {
          const media = Array.from(ancestor.querySelectorAll("video, img, canvas"))
            .filter((el) => {
              const rect = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              return rect.width > 80
                && rect.height > 60
                && style.visibility !== "hidden"
                && style.display !== "none";
            })
            .filter((el) => {
              if (el.tagName !== "IMG") return true;
              const source = [el.currentSrc, el.src, el.getAttribute("src"), el.getAttribute("data-src")]
                .filter(Boolean).join(" ");
              return !/^data:image\\/svg\\+xml/i.test(source);
            });
          if (media.length) {
            generatedMedia.push(...media);
            break;
          }
        }
      }
      const uniqueVideoCardImages = Array.from(new Set([...videoCardImages, ...generatedMedia]));
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
        videoCardCount: videos.length + uniqueVideoCardImages.length
      };
    })()
  `);
}

async function findGeneratedConversationAndCopyShare(
  win: BrowserWindow,
  prompt: string,
  preferredConversationUrl: string | null = null,
  onProgress: (message: string) => Promise<void> | void = () => undefined
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
              && /^\\/chat\\/[A-Za-z0-9._~-]+/i.test(url.pathname)
              && !/^\\/chat\\/local_/i.test(url.pathname);
          } catch {
            return false;
          }
        })
        .map((item) => ({ ...item, score: scoreLabel(item.label) }));
      const unique = Array.from(new Map(links.map((item) => [item.href, item])).values());
      return unique
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, ${RECENT_CONVERSATION_FALLBACK_LIMIT})
        .map((item) => item.href)
    })()
  `);
  const preferredUrl = isFormalDoubaoConversationUrl(preferredConversationUrl)
    ? extractDoubaoConversationUrl(preferredConversationUrl)
    : null;
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
  let pendingMatchCount = 0;
  let failureMessage: string | null = null;
  let shareFailureReason: string | null = null;

  for (let candidateIndex = 0; candidateIndex < orderedCandidates.length; candidateIndex += 1) {
    const candidate = orderedCandidates[candidateIndex];
    const isPreferred = Boolean(preferredUrl && candidate === preferredUrl);
    await onProgress(isPreferred
      ? "正在检查已记录的本次豆包对话"
      : `正在检查最近对话 ${candidateIndex - (preferredUrl ? 0 : -1)}/${candidates.length}`);
    try {
      await loadUrl(win, candidate, 8000);
    } catch (error) {
      console.warn("跳过无法加载的豆包历史对话", candidate, error);
      continue;
    }
    await wait(600);
    await dismissDoubaoDesktopDownloadPrompt(win);

    let pageText = "";
    let matchedPrompt = false;
    const promptMatchAttempts = isPreferred ? 10 : 4;
    for (let attempt = 0; attempt < promptMatchAttempts; attempt += 1) {
      pageText = await runPageScript<string>(win, `document.body?.innerText || ""`);
      const normalizedPageText = normalizeComparableText(pageText);
      const signatureMatches = signatures.filter((signature) => normalizedPageText.includes(signature)).length;
      matchedPrompt = normalizedPageText.includes(normalizedPrompt)
        || signatureMatches >= requiredSignatureMatches;
      if (matchedPrompt) break;
      await wait(350);
    }
    if (matchedPrompt) promptMatchCount += 1;
    if (!isPreferred && !matchedPrompt) continue;
    await onProgress(isPreferred
      ? matchedPrompt
        ? "已锁定本次正式会话并匹配提示词，正在确认视频结果"
        : "已锁定本次正式会话，页面未完整渲染原提示词，直接按会话确认视频结果"
      : "已匹配本次提示词，正在确认视频结果");

    const pageState = await waitForGeneratedVideoCard(
      win,
      isPreferred ? PREFERRED_CONVERSATION_RETRY_MS : VIDEO_CARD_WAIT_MS
    );
    if (pageState.failureMessage) {
      failureMessage ||= pageState.failureMessage;
      continue;
    }
    if (!pageState.generated) {
      if (isDoubaoGenerationPending(pageState.pageText)) pendingMatchCount += 1;
      continue;
    }
    if (pageState.videoCardCount <= 0) {
      await onProgress("已识别完成文案，等待新版视频卡片渲染");
      shareFailureReason = "匹配对话已完成，但视频卡片仍未渲染";
      continue;
    }
    generatedMatchCount += 1;
    await onProgress("已检测到新版视频卡片，正在复制当前视频分享链接");

    const shareStartedAt = Date.now();
    let shareAttempt = 0;
    do {
      shareAttempt += 1;
      await onProgress(isPreferred
        ? `已锁定本次对话，等待分享资源同步（第 ${shareAttempt} 次）`
        : `最近对话 ${candidateIndex - (preferredUrl ? 0 : -1)} 已匹配，正在复制分享链接`);
      const copied = await tryCopyShareLink(win);
      shareFailureReason = copied.reason;
      if (copied.shareUrl) {
        return {
          shareUrl: copied.shareUrl,
          candidateCount: orderedCandidates.length,
          promptMatchCount,
          generatedMatchCount,
          pendingMatchCount,
          failureMessage,
          shareFailureReason: null
        };
      }
      const shouldRetryPreferred = isPreferred
        && Date.now() - shareStartedAt < PREFERRED_CONVERSATION_RETRY_MS;
      if (!shouldRetryPreferred || win.isDestroyed()) break;
      await wait(5000);
    } while (Date.now() - shareStartedAt < PREFERRED_CONVERSATION_RETRY_MS);

    if (isPreferred && candidates.some((item) => item !== preferredUrl)) {
      await onProgress(`已记录对话暂未同步有效分享资源，改为检查同账号最近 ${Math.min(candidates.length, RECENT_CONVERSATION_FALLBACK_LIMIT)} 条对话`);
    }
  }

  return {
    shareUrl: null,
    candidateCount: orderedCandidates.length,
    promptMatchCount,
    generatedMatchCount,
    pendingMatchCount,
    failureMessage,
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
  if (win.isDestroyed()) return { shareUrl: null, reason: "执行窗口已关闭" } satisfies ShareCopyResult;

  let result: ShareCopyResult = { shareUrl: null, reason: "未找到分享面板" };
  try {
    await dismissDoubaoDesktopDownloadPrompt(win);

    const generationState = await inspectGenerationPage(win, false);
    if (generationState.failureMessage) {
      return {
        shareUrl: null,
        reason: `当前任务未产生视频：${generationState.failureMessage}`
      };
    }
    if (!generationState.generated) {
      return { shareUrl: null, reason: "当前对话尚未确认视频生成完成" };
    }

    await primeGeneratedVideoCard(win);

    // Doubao's “复制链接” button writes a ClipboardItem to navigator.clipboard.
    // Capture that write inside the page so the user's OS clipboard is untouched.
    const captureInstalled = await installDoubaoPageClipboardCapture(win);
    if (!captureInstalled) {
      return { shareUrl: null, reason: "无法安装页面分享链接捕获器，未触碰系统剪贴板" };
    }

    const acceptCapturedShareUrl = async (shareUrl: string) => {
      try {
        await verifyDoubaoShareVideoResource(shareUrl);
        result = { shareUrl, reason: null };
        return true;
      } catch (error) {
        // New Doubao share pages are often a client-rendered shell when
        // fetched from the main process, even though the page is valid and
        // the watermark provider can resolve its video resource. Keep the
        // formal thread/share URL and let the downstream MP4 validation be
        // the final success gate instead of rejecting the dynamic shell.
        if (errorMessage(error) === "复制出的豆包分享页没有包含当前视频资源") {
          result = { shareUrl, reason: null };
          return true;
        }
        result = { shareUrl: null, reason: errorMessage(error) };
        return false;
      }
    };

    let shareState = await inspectShareSelection(win);

    if (!shareState.active) {
      await openShareSelection(win);
      const directlyCapturedUrl = await waitForPageCapturedShareUrl(win, 450);
      if (directlyCapturedUrl) {
        if (await acceptCapturedShareUrl(directlyCapturedUrl)) return result;
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
      return { shareUrl: null, reason: "未找到复制链接控件" };
    }
    if (!shareState.copyEnabled && shareState.checkboxCount > 0) {
      return { shareUrl: null, reason: "复制链接按钮未启用" };
    }

    // Native mouse click remains the reliable trigger, but the generated URL is
    // read from the page capture instead of Electron's process-wide clipboard.
    await clearPageCapturedShareUrl(win);
    await sendMouseClick(win, copyPoint.x, copyPoint.y);
    const nativeCapturedUrl = await waitForPageCapturedShareUrl(win, PAGE_SHARE_CAPTURE_WAIT_MS);
    if (nativeCapturedUrl) {
      if (await acceptCapturedShareUrl(nativeCapturedUrl)) return result;
    }

    // Keep a DOM click as a bounded fallback for versions that render the
    // clickable label separately from the visible button surface.
    await clearPageCapturedShareUrl(win);
    await clickByKeywords(win, ["复制链接"]);
    const domCapturedUrl = await waitForPageCapturedShareUrl(win, PAGE_SHARE_CAPTURE_WAIT_MS);
    if (domCapturedUrl) {
      await acceptCapturedShareUrl(domCapturedUrl);
    } else if (!result.reason) {
      result = { shareUrl: null, reason: await getPageShareLinkFailureReason(win) };
    }
    return result;
  } catch (error) {
    // Share panels are animated and can be replaced while the generation card
    // updates. Treat a transient inspection error as a retryable miss.
    console.warn("豆包复制分享链接暂时失败", error);
    result = { shareUrl: null, reason: `复制控件检查异常：${errorMessage(error)}` };
    return result;
  }
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

async function installDoubaoPageClipboardCapture(win: BrowserWindow) {
  return runPageScript<boolean>(win, `
    (() => {
      const stateKey = "__doubaoShareCapture";
      const previousState = window[stateKey];
      if (previousState?.installed) {
        previousState.url = null;
        previousState.sawChatUrl = false;
        previousState.lastWriteAt = 0;
        return true;
      }

      const extractWatermarkShareUrl = (value) => {
        const matched = String(value || "").match(/https?:\\/\\/(?:www\\.)?doubao\\.com\\/(?:thread|share)\\/[A-Za-z0-9._~-]+(?:[\\/?#][^\\s"'<>]*)?/i)?.[0];
        return matched?.replace(/[)\\]}>，。！？；;]+$/, "") || null;
      };
      const isChatUrl = (value) => /https?:\\/\\/(?:www\\.)?doubao\\.com\\/chat\\//i.test(String(value || ""));
      const originalClipboard = navigator.clipboard;
      const state = {
        installed: true,
        url: null,
        sawChatUrl: false,
        lastWriteAt: 0
      };
      const captureText = (value) => {
        const text = String(value || "");
        const shareUrl = extractWatermarkShareUrl(text);
        if (shareUrl) state.url = shareUrl;
        if (isChatUrl(text)) state.sawChatUrl = true;
        state.lastWriteAt = Date.now();
      };
      const captureItem = async (item) => {
        for (const type of Array.from(item?.types || [])) {
          try {
            const blob = await item.getType(type);
            captureText(await blob.text());
            if (state.url) return;
          } catch {
            // A ClipboardItem can expose image or HTML types that are not text.
          }
        }
      };
      const wrapper = {
        writeText: async (text) => {
          captureText(text);
        },
        write: async (items) => {
          for (const item of Array.from(items || [])) {
            await captureItem(item);
            if (state.url) break;
          }
        },
        readText: originalClipboard?.readText?.bind(originalClipboard) || (async () => ""),
        read: originalClipboard?.read?.bind(originalClipboard) || (async () => [])
      };
      try {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: wrapper
        });
        Object.defineProperty(window, stateKey, {
          configurable: true,
          value: state
        });
        return true;
      } catch {
        return false;
      }
    })()
  `);
}

async function waitForPageCapturedShareUrl(win: BrowserWindow, timeoutMs = PAGE_SHARE_CAPTURE_WAIT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const shareUrl = await readPageCapturedShareUrl(win);
    if (shareUrl) return shareUrl;
    await wait(Math.min(150, Math.max(25, timeoutMs - (Date.now() - startedAt))));
  }
  return readPageCapturedShareUrl(win);
}

async function readPageCapturedShareUrl(win: BrowserWindow) {
  if (win.isDestroyed()) return null;
  return runPageScript<string | null>(win, `
    (() => window.__doubaoShareCapture?.url || null)()
  `);
}

async function clearPageCapturedShareUrl(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  await runPageScript<void>(win, `
    (() => {
      if (window.__doubaoShareCapture) {
        window.__doubaoShareCapture.url = null;
        window.__doubaoShareCapture.sawChatUrl = false;
      }
    })()
  `);
}

async function getPageShareLinkFailureReason(win: BrowserWindow) {
  const state = await runPageScript<{ sawChatUrl?: boolean } | null>(win, `
    (() => window.__doubaoShareCapture || null)()
  `).catch(() => null);
  if (state?.sawChatUrl) {
    return "豆包复制的是 chat 对话地址，不是可去水印的 thread/share 分享地址";
  }
  return "点击复制链接后页面未捕获到可去水印的豆包 thread/share 分享地址";
}

async function primeGeneratedVideoCard(win: BrowserWindow) {
  const cardPoint = await runPageScript<{ x: number; y: number; needsClick: boolean } | null>(win, `
    (() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      const scrollContainers = Array.from(document.querySelectorAll("*"))
        .filter((el) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return rect.width > 120
            && rect.height > 120
            && rect.bottom >= 0
            && rect.top <= window.innerHeight
            && el.scrollHeight > el.clientHeight + 80
            && /(auto|scroll)/i.test(style.overflowY);
        })
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      for (const container of scrollContainers.slice(0, 4)) {
        container.scrollTop = container.scrollHeight;
      }
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 80
          && rect.height > 60
          && style.visibility !== "hidden"
          && style.display !== "none";
      };
      const mediaCandidates = Array.from(document.querySelectorAll(
        "video, img, canvas, [class*='block-video'], [class*='video-card'], [data-video-url], [data-download-url]"
      ))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const className = typeof el.className === "string" ? el.className : "";
          const source = [
            el.currentSrc,
            el.src,
            el.getAttribute("src"),
            el.getAttribute("data-src")
          ].filter(Boolean).join(" ");
          return { el, rect, source, className };
        })
        .filter((item) => /video[_-]|video.*watermark|video_dsz|tplv[^ ]*video/i.test(item.source)
          || /block-video|video-card/i.test(item.className))
        .sort((a, b) => Number(/block-video|video-card/i.test(b.className))
          - Number(/block-video|video-card/i.test(a.className))
          || b.rect.bottom - a.rect.bottom);
      const target = mediaCandidates[0];
      if (!target) return null;
      target.el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      target.el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      const visibleVideoCount = Array.from(document.querySelectorAll("video")).filter(visible).length;
      return {
        x: Math.round(target.rect.left + target.rect.width / 2),
        y: Math.round(target.rect.top + target.rect.height / 2),
        // New Doubao cards render the actual <video> and toolbar after the
        // card is physically clicked. Avoid toggling playback when it is
        // already mounted, but always move the native pointer onto the card
        // so the hover-only toolbar is actually rendered.
        needsClick: visibleVideoCount === 0
      };
    })()
  `);
  if (!cardPoint) return false;
  await sendMouseMove(win, cardPoint.x, cardPoint.y);
  if (cardPoint.needsClick) {
    await sendMouseClick(win, cardPoint.x, cardPoint.y);
    await wait(900);
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    await wait(500);
    const state = await inspectGenerationPage(win, false);
    if (state.playableVideoCount > 0 || state.videoUrls.length > 0) {
      await wait(700);
      break;
    }
  }
  // The current Doubao video card exposes its share toolbar only while the
  // card remains hovered. Do not press Escape here: it dismisses that toolbar
  // on newer builds before openShareSelection can click it.
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
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')).filter(visible);
      const checked = checkboxes.filter((el) => el.checked === true || el.getAttribute("aria-checked") === "true");
      const copyEnabled = copyControls.some((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true");
      return {
        // A conversation containing one video can open a share panel without
        // rendering the multi-select “全选” control. The visible “复制链接”
        // control is the reliable panel marker in both layouts.
        active: copyControls.length > 0,
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
  // The current Doubao build places the share action in the message toolbar,
  // outside the video element's DOM subtree. Its share SVG starts with the
  // stable path used by the native share action. Search this toolbar first so
  // we do not click a page-level header action or an unrelated message.
  const knownSharePoint = await waitForDoubaoVideoToolbarSharePoint(win, 3000);
  if (knownSharePoint) {
    await sendMouseClick(win, knownSharePoint.x, knownSharePoint.y);
    if ((await waitForShareSelection(win, SHARE_PANEL_WAIT_MS)).active) return true;
  }

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

async function waitForDoubaoVideoToolbarSharePoint(win: BrowserWindow, timeoutMs: number) {
  const startedAt = Date.now();
  let point = await findDoubaoVideoToolbarSharePoint(win);
  while (!point && Date.now() - startedAt < timeoutMs) {
    await wait(180);
    point = await findDoubaoVideoToolbarSharePoint(win);
  }
  return point;
}

async function findDoubaoVideoToolbarSharePoint(win: BrowserWindow) {
  return runPageScript<{ x: number; y: number } | null>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4
          && rect.bottom >= 0 && rect.top <= window.innerHeight
          && style.visibility !== "hidden" && style.display !== "none"
          && style.pointerEvents !== "none";
      };
      const media = Array.from(document.querySelectorAll(
        "video, img, canvas, [class*='block-video'], [class*='video-card'], [data-video-url], [data-download-url]"
      ))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const className = typeof el.className === "string" ? el.className : "";
          const source = [
            el.currentSrc,
            el.src,
            el.getAttribute("src"),
            el.getAttribute("data-src"),
            el.getAttribute("data-video-url"),
            el.getAttribute("data-download-url")
          ].filter(Boolean).join(" ");
          return { el, rect, className, source };
        })
        .filter((item) => /block-video|video-card/i.test(item.className)
          || /video[_-]|video.*watermark|video_dsz|tplv[^ ]*video/i.test(item.source))
        .sort((a, b) => b.rect.bottom - a.rect.bottom)[0];
      if (!media) return null;

      const mediaRect = media.rect;
      const mediaRoot = (() => {
        let current = media.el;
        for (let level = 0; current && level < 14; level += 1, current = current.parentElement) {
          const text = (current.innerText || "").replace(/\\s+/g, " ");
          if (/你的视频(?:已经|已)?生成好[了啦]|视频(?:已经|已)?生成(?:完成|成功|好[了啦])/.test(text)) {
            return current;
          }
        }
        return media.el.parentElement;
      })();
      const rootRect = mediaRoot?.getBoundingClientRect();
      const paths = Array.from(document.querySelectorAll("svg path[d]"))
        .filter(visible)
        .filter((path) => /^M11\\.052/.test(path.getAttribute("d") || ""))
        .map((path) => {
          const button = path.closest("button, [role=\\"button\\"], [tabindex], a") || path;
          const rect = button.getBoundingClientRect();
          return { rect };
        })
        .filter((item) => item.rect.width <= 80 && item.rect.height <= 80)
        .filter((item) => item.rect.bottom >= Math.max(0, mediaRect.top - 220)
          && item.rect.top <= mediaRect.bottom + 280)
        .filter((item) => !rootRect
          || (item.rect.left + item.rect.width / 2 >= rootRect.left - 40
            && item.rect.right - item.rect.width / 2 <= rootRect.right + 40));
      const target = paths
        .sort((a, b) => {
          const aDistance = Math.abs((a.rect.top + a.rect.height / 2) - mediaRect.bottom);
          const bDistance = Math.abs((b.rect.top + b.rect.height / 2) - mediaRect.bottom);
          return aDistance - bDistance;
        })[0];
      if (!target) return null;
      return {
        x: Math.round(target.rect.left + target.rect.width / 2),
        y: Math.round(target.rect.top + target.rect.height / 2)
      };
    })()
  `);
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
      const mediaCandidates = Array.from(document.querySelectorAll(
        "video, img, canvas, [class*='block-video'], [class*='video-card'], [data-video-url], [data-download-url]"
      ))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const className = typeof el.className === "string" ? el.className : "";
          const source = [
            el.currentSrc,
            el.src,
            el.getAttribute("src"),
            el.getAttribute("data-src"),
            el.getAttribute("data-video-url"),
            el.getAttribute("data-download-url")
          ].filter(Boolean).join(" ");
          return { el, rect, source, className };
        });
      const knownVideoMedia = mediaCandidates
        .filter((item) => /video[_-]|video.*watermark|video_dsz|tplv[^ ]*video/i.test(item.source)
          || /block-video|video-card/i.test(item.className));
      const completionMedia = [];
      const completionTextNodes = Array.from(document.querySelectorAll("*"))
        .filter((el) => {
          const ownText = Array.from(el.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent || "")
            .join(" ")
            .replace(/\\s+/g, " ")
            .trim();
          return /你的视频(?:已经|已)?生成好[了啦]|视频(?:已经|已)?生成(?:完成|成功|好[了啦])|生成视频(?:已经|已)?完成/.test(ownText);
        });
      for (const node of completionTextNodes) {
        let ancestor = node;
        for (let level = 0; ancestor && level < 8; level += 1, ancestor = ancestor.parentElement) {
          const media = mediaCandidates.filter((item) => ancestor.contains(item.el));
          if (media.length) {
            completionMedia.push(...media);
            break;
          }
        }
      }
      const media = Array.from(new Map([...knownVideoMedia, ...completionMedia]
        .map((item) => [item.el, item])).values())
        .sort((a, b) => b.rect.bottom - a.rect.bottom)[0];
      if (!media) return null;

      let ancestor = media.el.parentElement;
      for (let level = 0; ancestor && level < 9; level += 1, ancestor = ancestor.parentElement) {
        const controls = Array.from(ancestor.querySelectorAll('button, [role="button"], [tabindex], [aria-label], [title]'))
          .filter(visible)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const sharePath = Array.from(el.querySelectorAll("svg path"))
              .some((path) => /^M11\\.052/.test(path.getAttribute("d") || ""));
            return { el, rect, text: textOf(el), sharePath };
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

        const iconShare = controls.find((item) => item.sharePath);
        if (iconShare) {
          const rect = iconShare.rect;
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

async function waitForSubmittedConversationUrl(win: BrowserWindow, timeoutMs = 8000) {
  let conversationUrl = extractDoubaoConversationUrl(win.webContents.getURL());
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs && !isFormalDoubaoConversationUrl(conversationUrl)) {
    await wait(200);
    const currentUrl = extractDoubaoConversationUrl(win.webContents.getURL());
    if (currentUrl) conversationUrl = currentUrl;
  }
  return isFormalDoubaoConversationUrl(conversationUrl) ? conversationUrl : null;
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

async function getRawPageText(win: BrowserWindow) {
  return runPageScript<string>(win, `(document.body?.innerText || "").trim()`);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "执行器未知错误";
}

function formatGenerationSettings(request: Pick<ApiRequest, "model" | "aspectRatio" | "prompt">) {
  const model = request.model === "seedance_2_0_mini" ? "mini" : "fast";
  return `模型：${doubaoVideoModelLabel(model)} 画幅：${request.aspectRatio || "未指定"} 时长：${extractPromptDuration(request.prompt) || "未指定"}`;
}

function extractPromptDuration(prompt: string) {
  const text = prompt.replace(/\s+/g, " ");
  const explicit = text.match(/(?:总?时长|视频时长|持续时间)\s*[:：]?\s*(\d+(?:\s*[-—–~至]\s*\d+)?)\s*(?:秒|s)(?![a-z])/i);
  if (explicit?.[1]) return `${explicit[1].replace(/\s+/g, "")}秒`;

  // Prompts often contain segment timings such as "留 1 秒" and put the
  // actual total duration at the end. Prefer the final complete duration
  // marker when there is no explicit duration label.
  const durations = Array.from(text.matchAll(/(?<!\d)(\d+(?:\s*[-—–~至]\s*\d+)?)\s*(?:秒|s)(?![a-z])/gi));
  const last = durations.at(-1);
  if (last?.[1]) return `${last[1].replace(/\s+/g, "")}秒`;
  return null;
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
