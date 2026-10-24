import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, powerMonitor, session } from "electron";
import { DailyQuotaTimer } from "./quota-clock.js";
import { doubaoDailyQuotaError } from "./doubao-quota-state.js";
import log from "electron-log/main.js";
import { AppDatabase } from "./database.js";
import { DoubaoExecutor } from "./executor.js";
import { toPublicApiRequest } from "./public-api.js";
import type {
  AccountUpdateInput,
  ApiRequest,
  ApiServerStatus,
  AppSettings,
  AppSettingsUpdateInput,
  DoubaoAspectRatio,
  DoubaoModel,
  GenerateRequestBody
} from "./types.js";
import { resolveCleanVideoUrl, WatermarkError } from "./watermark.js";
import type { WatermarkProviderObserver } from "./watermark-state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let db: AppDatabase;
let executor: DoubaoExecutor;
let apiServer: LocalApiServer;
let quotaTimer: DailyQuotaTimer | null = null;

const observeWatermarkResponse: WatermarkProviderObserver = (settings, event) => {
  db.recordWatermarkResponse(settings, event);
  notifyDataChanged();
};

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

class LocalApiServer {
  private server: Server | null = null;
  private status: ApiServerStatus = {
    version: app.getVersion(),
    enabled: false,
    running: false,
    port: 0,
    url: null,
    message: "未启动"
  };

  constructor(
    private readonly database: AppDatabase,
    private readonly requestExecutor: DoubaoExecutor
  ) {}

  async applySettings(settings: AppSettings) {
    await this.stop();

    this.status = {
      version: app.getVersion(),
      enabled: settings.apiServiceEnabled,
      running: false,
      port: settings.apiPort,
      url: null,
      message: settings.apiServiceEnabled ? "启动中" : "已关闭"
    };

    if (!settings.apiServiceEnabled) return this.status;

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve) => {
      this.server!.once("error", (error) => {
        this.status = {
          version: app.getVersion(),
          enabled: true,
          running: false,
          port: settings.apiPort,
          url: null,
          message: `启动失败：${error.message}`
        };
        resolve();
      });

      this.server!.listen(settings.apiPort, "127.0.0.1", () => {
        this.status = {
          version: app.getVersion(),
          enabled: true,
          running: true,
          port: settings.apiPort,
          url: `http://127.0.0.1:${settings.apiPort}`,
          message: "运行中"
        };
        resolve();
      });
    });

    return this.status;
  }

  async stop() {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  getStatus() {
    return this.status;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const settings = this.database.getSettings();

    try {
      if (request.method === "OPTIONS") {
        sendJson(response, 204, null);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          service: "doubao-account-pool",
          api: this.getStatus()
        });
        return;
      }

      if (!isAuthorized(request, settings.apiKey)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/accounts") {
        refreshQuotas();
        sendJson(response, 200, { accounts: this.database.listAccounts() });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/watermark/status") {
        sendJson(response, 200, this.database.getWatermarkStatus());
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/generate") {
        const requestId = `doubao-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const body = await readGenerateRequest(request, requestId);
        const prompt = body.prompt?.trim();
        if (!prompt) {
          sendJson(response, 400, { error: "prompt is required" });
          return;
        }

        const model = normalizeModel(body.model || settings.defaultModel);
        if (!model) {
          sendJson(response, 400, { error: "unsupported model" });
          return;
        }

        const aspectRatio = normalizeAspectRatio(body.aspectRatio) || "16:9";
        const rawAspectRatio = typeof body.aspectRatio === "string" ? body.aspectRatio.trim() : body.aspectRatio;
        if (rawAspectRatio !== undefined && rawAspectRatio !== null && rawAspectRatio !== "" && !normalizeAspectRatio(body.aspectRatio)) {
          sendJson(response, 400, { error: "aspectRatio must be 9:16 or 16:9" });
          return;
        }

        const duration = normalizeDuration(body.duration) || 10;
        const rawDuration = body.duration;
        if (rawDuration !== undefined && rawDuration !== null && rawDuration !== "" && !normalizeDuration(body.duration)) {
          sendJson(response, 400, { error: "duration must be an integer between 4 and 15 (seconds)" });
          return;
        }

        const accountId = body.accountId === undefined ? undefined : Number(body.accountId);
        if (accountId !== undefined && (!Number.isSafeInteger(accountId) || accountId < 1)) {
          sendJson(response, 400, { error: "accountId must be a positive integer" });
          return;
        }
        const referenceImagePath = await prepareReferenceImage(body, requestId);
        refreshQuotas();
        const created = this.database.acceptApiRequest({ requestId, source: body.source, model, aspectRatio, duration,
          prompt, referenceImagePath, removeWatermark: true, callbackUrl: body.callbackUrl }, accountId);

        if (!created) {
          const pinnedExhausted = accountId ? this.database.getAccount(accountId)?.dailyQuotaExhausted : false;
          const failed = this.database.createApiRequest({
            requestId,
            source: body.source,
            model,
            aspectRatio,
            duration,
            status: "failed",
            message: pinnedExhausted ? "豆包今日免费次数已用完；本任务指定了账号，不自动换号" : accountId ? "指定账号未登录、不存在或该模型剩余额度不足" : "没有可用账号，或该模型剩余额度不足",
            accountId: pinnedExhausted ? accountId : undefined,
            requestedAccountId: accountId,
            prompt,
            referenceImagePath,
            removeWatermark: true,
            callbackUrl: body.callbackUrl
          });
          if (pinnedExhausted) this.database.updateApiRequest({ requestId, error: doubaoDailyQuotaError(this.database.getAccount(accountId!)?.quotaExhaustedReason || failed.message) });
          this.database.appendOperationLog({
            requestId,
            action: "分配账号",
            status: "failed",
            message: failed.message
          });
          notifyDataChanged();
          const finalFailure = this.database.getApiRequest(requestId)!;
          void postCallback(finalFailure);
          sendJson(response, 409, toPublicApiRequest(finalFailure));
          return;
        }

        this.requestExecutor.enqueue(created.requestId);
        this.database.appendOperationLog({
          requestId,
          accountId: created.accountId,
          action: "接收接口请求",
          status: "success",
          message: created.message
        });
        notifyDataChanged();
        void postCallback(created);
        sendJson(response, 202, toPublicApiRequest(created));
        return;
      }

      const recoveryMatch = requestUrl.pathname.match(/^\/api\/requests\/([^/]+)\/retry-result$/);
      if (request.method === "POST" && recoveryMatch) {
        const requestId = decodeURIComponent(recoveryMatch[1]);
        const apiRequest = this.database.getApiRequest(requestId);
        if (!apiRequest) {
          sendJson(response, 404, { error: "request not found" });
          return;
        }
        if (!apiRequest.accountId) {
          sendJson(response, 409, { error: "request has no assigned account" });
          return;
        }
        if (apiRequest.status === "running" || apiRequest.status === "accepted" && apiRequest.executionPhase !== "paused") {
          sendJson(response, 409, { error: "request is already active; stop or wait before retrying its result" });
          return;
        }
        this.requestExecutor.enqueueRecovery(requestId);
        this.database.appendOperationLog({
          requestId,
          accountId: apiRequest.accountId,
          action: "恢复视频结果",
          status: "info",
          message: "已进入结果恢复队列，不会重新提交视频生成"
        });
        sendJson(response, 202, {
          requestId,
          status: "accepted",
          message: "已进入结果恢复队列，不会重新提交视频生成"
        });
        return;
      }

      const stopMatch = requestUrl.pathname.match(/^\/api\/requests\/([^/]+)\/stop$/);
      if (request.method === "POST" && stopMatch) {
        const requestId = decodeURIComponent(stopMatch[1]);
        const result = this.requestExecutor.stop(requestId);
        if (!result.stopped) {
          sendJson(response, 409, {
            ...toPublicApiRequest(result.request),
            error: "only accepted or running requests can be stopped"
          });
          return;
        }
        sendJson(response, 200, toPublicApiRequest(result.request));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname.startsWith("/api/requests/")) {
        const requestId = decodeURIComponent(requestUrl.pathname.replace("/api/requests/", ""));
        const apiRequest = this.database.getApiRequest(requestId);
        if (!apiRequest) {
          sendJson(response, 404, { error: "request not found" });
          return;
        }
        sendJson(response, 200, toPublicApiRequest(apiRequest));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/watermark/parse") {
        const body = await readJsonBody<{ url?: string }>(request);
        const sourceUrl = body.url?.trim();
        if (!sourceUrl) {
          sendJson(response, 400, { error: "url is required" });
          return;
        }
        try {
          const cleanVideoUrl = await resolveCleanVideoUrl(settings, sourceUrl, undefined, { onProviderResponse: observeWatermarkResponse, getSettings: () => this.database.getSettings() });
          recordOperation(null, null, "独立去水印解析", "success", "已验证真实 MP4 地址", sourceUrl);
          sendJson(response, 200, {
            status: "success",
            message: "去水印 MP4 地址已验证",
            cleanVideoUrl,
            outputVideoPath: null
          });
        } catch (error) {
          recordOperation(
            null,
            null,
            "独立去水印解析",
            "failed",
            error instanceof Error ? error.message : "去水印解析失败",
            sourceUrl
          );
          sendJson(response, 422, {
            status: "failed",
            error: error instanceof WatermarkError ? error.info : null,
            message: error instanceof Error ? error.message : "去水印解析失败",
            cleanVideoUrl: null,
            outputVideoPath: null
          });
        }
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      sendJson(response, 500, { error: message });
    }
  }
}

function setupChineseMenu() {
  // 与 Electron 默认菜单同构（role 保留全部快捷键与行为），仅标签中文化。
  const menu = Menu.buildFromTemplate([
    {
      label: "文件",
      submenu: [
        { label: "关闭窗口", role: "close" }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { label: "撤销", role: "undo" },
        { label: "重做", role: "redo" },
        { type: "separator" },
        { label: "剪切", role: "cut" },
        { label: "复制", role: "copy" },
        { label: "粘贴", role: "paste" },
        { label: "全选", role: "selectAll" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { label: "重新加载", role: "reload" },
        { label: "强制重新加载", role: "forceReload" },
        { type: "separator" },
        { label: "进入/退出全屏", role: "togglefullscreen" },
        { type: "separator" },
        { label: "实际大小", role: "resetZoom" },
        { label: "放大", role: "zoomIn" },
        { label: "缩小", role: "zoomOut" },
        { type: "separator" },
        { label: "切换开发者工具", role: "toggleDevTools" }
      ]
    },
    {
      label: "窗口",
      submenu: [
        { label: "最小化", role: "minimize" },
        { label: "关闭窗口", role: "close" }
      ]
    },
    {
      label: "帮助",
      submenu: [
        { label: "关于豆包账号池", role: "about" }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    title: "豆包账号池接口服务",
    webPreferences: {
      preload: path.join(__dirname, "preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

function createDoubaoWindow(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const titleName = account.remark || account.name;
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    title: `豆包 - ${titleName}`,
    webPreferences: {
      partition: account.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  void win.loadURL("https://www.doubao.com/chat");
}

async function detectLoginStatus(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const accountSession = session.fromPartition(account.partition);
  const cookies = await accountSession.cookies.get({ url: "https://www.doubao.com" });
  const activeRequest = account.runningTaskCount + account.queuedTaskCount > 0;
  return db.updateAccount({
    id: accountId,
    loginStatus: cookies.length > 0 ? "logged_in" : "logged_out",
    currentStatus: cookies.length > 0
      ? activeRequest
        ? "busy"
        : "idle"
      : "login_required"
  });
}

async function detectAllLoginStatuses() {
  const accounts = db.listAccounts();
  for (const account of accounts) {
    await detectLoginStatus(account.id);
  }
  return db.listAccounts();
}

async function clearAccountSession(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const accountSession = session.fromPartition(account.partition);
  await accountSession.clearStorageData();
  await accountSession.clearCache();
  return db.updateAccount({
    id: accountId,
    loginStatus: "logged_out",
    currentStatus: "login_required"
  });
}

function registerIpc() {
  ipcMain.handle("accounts:list", () => { refreshQuotas(); return db.listAccounts(); });
  ipcMain.handle("accounts:create", (_event, remark?: string) => {
    const account = db.createAccount({ remark });
    recordOperation(null, account.id, "创建账号", "success", `已创建 ${account.partition}`);
    return account;
  });
  ipcMain.handle("accounts:update", (_event, input: AccountUpdateInput) => {
    const account = db.updateAccount(input);
    recordOperation(null, account.id, "修改账号设置", "success", "已保存账号备注和额度设置");
    return account;
  });
  ipcMain.handle("accounts:delete", async (_event, id: number) => {
    const account = db.getAccount(id);
    await clearAccountSession(id);
    db.deleteAccount(id);
    recordOperation(null, id, "删除账号", "success", `已删除 ${account?.partition || id}`);
    return true;
  });
  ipcMain.handle("accounts:open", (_event, id: number) => {
    const result = createDoubaoWindow(id);
    recordOperation(null, id, "打开豆包窗口", "success", "已打开独立账号窗口");
    return result;
  });
  ipcMain.handle("accounts:relogin", async (_event, id: number) => {
    await clearAccountSession(id);
    createDoubaoWindow(id);
    recordOperation(null, id, "重新登录账号", "success", "已清空登录状态并打开登录窗口");
    return true;
  });
  ipcMain.handle("accounts:detect-login", async (_event, id: number) => {
    const account = await detectLoginStatus(id);
    recordOperation(null, id, "检测登录状态", "success", `当前状态：${account.loginStatus}`);
    return account;
  });
  ipcMain.handle("accounts:detect-all", async () => {
    const accounts = await detectAllLoginStatuses();
    recordOperation(null, null, "检测全部账号", "success", `已检测 ${accounts.length} 个账号`);
    return accounts;
  });
  ipcMain.handle("accounts:reset-quota", (_event, id: number) => {
    const accounts = db.resetAccountQuota(id);
    recordOperation(null, id, "重置账号额度", "success", "已重置今日额度");
    return accounts;
  });
  ipcMain.handle("accounts:reset-all-quotas", () => {
    const accounts = db.resetAllQuotas();
    recordOperation(null, null, "重置全部额度", "success", `已重置 ${accounts.length} 个账号`);
    return accounts;
  });

  ipcMain.handle("settings:get", () => db.getSettings());
  ipcMain.handle("settings:update", async (_event, input: AppSettingsUpdateInput) => {
    const previous = db.getSettings();
    const settings = db.updateSettings(input);
    executor.wake();
    if (previous.apiPort !== settings.apiPort || previous.apiServiceEnabled !== settings.apiServiceEnabled || previous.apiKey !== settings.apiKey) {
      await apiServer.applySettings(settings);
    }
    const watermarkChanged = previous.watermarkApiUrl !== settings.watermarkApiUrl || previous.watermarkApiToken !== settings.watermarkApiToken;
    recordOperation(null, null, "保存配置", "success", watermarkChanged ? "去水印配置已保存，后续解析尝试使用新配置；已发出的请求不撤回，已失败任务可恢复结果" : "配置已保存并应用");
    return settings;
  });

  ipcMain.handle("api-server:status", () => apiServer.getStatus());
  ipcMain.handle("api-server:restart", async () => apiServer.applySettings(db.getSettings()));

  ipcMain.handle("api-requests:list", (_event, limit?: number) => db.listApiRequests(limit || 100));
  ipcMain.handle("watermark:status", () => db.getWatermarkStatus());
  ipcMain.handle("api-requests:stats", (_event, startIso: string, endIso: string) => db.getRequestStats(startIso, endIso));
  ipcMain.handle("api-requests:recover", (_event, requestId: string) => {
    const request = db.getApiRequest(requestId);
    if (!request?.accountId || request.status === "running" || request.status === "accepted" && request.executionPhase !== "paused") throw new Error("任务当前无法恢复结果");
    executor.enqueueRecovery(requestId);
    return true;
  });
  ipcMain.handle("api-requests:stop", (_event, requestId: string) => executor.stop(requestId));
  ipcMain.handle("api-requests:today-success-count", (_event, startIso: string, endIso: string) =>
    db.countSuccessfulVideosBetween(startIso, endIso)
  );
  ipcMain.handle("api-requests:clear", () => {
    db.clearApiRequests();
    return true;
  });
  ipcMain.handle("operation-logs:list", (_event, limit?: number) => db.listOperationLogs(limit || 500));
  ipcMain.handle("operation-logs:clear", () => {
    db.clearOperationLogs();
    return true;
  });
}

function recordOperation(
  requestId: string | null,
  accountId: number | null,
  action: string,
  status: "info" | "success" | "failed",
  message: string,
  targetUrl?: string | null
) {
  db.appendOperationLog({ requestId, accountId, action, status, message, targetUrl });
  notifyDataChanged();
}

function refreshQuotas() {
  if (db.refreshDailyQuotas() > 0) {
    executor.wake();
    notifyDataChanged();
  }
}

function notifyDataChanged() {
  mainWindow?.webContents.send("data:changed");
}

function normalizeModel(model: string): DoubaoModel | null {
  if (model === "seedance_2_0_mini" || model === "seedance_2_0_fast") return model;
  return null;
}

function normalizeAspectRatio(value: unknown): DoubaoAspectRatio | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).replace(/\s+/g, "").trim();
  if (normalized === "9:16" || normalized === "16:9") return normalized;
  return null;
}

function normalizeDuration(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = typeof value === "number"
    ? value
    : Number(String(value).replace(/\s+/g, "").replace(/(?:s|秒)$/i, ""));
  if (!Number.isInteger(normalized) || normalized < 4 || normalized > 15) return null;
  return normalized;
}

function isAuthorized(request: IncomingMessage, apiKey: string) {
  if (!apiKey.trim()) return true;
  return request.headers.authorization === `Bearer ${apiKey}`;
}

async function readGenerateRequest(request: IncomingMessage, requestId: string): Promise<GenerateRequestBody> {
  const contentType = String(request.headers["content-type"] || "");
  if (contentType.includes("multipart/form-data")) {
    return parseMultipartGenerateRequest(await readBufferBody(request), contentType, requestId);
  }
  return readJsonBody<GenerateRequestBody>(request);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const raw = (await readBufferBody(request)).toString("utf8");
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

async function readBufferBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function parseMultipartGenerateRequest(buffer: Buffer, contentType: string, requestId: string): Promise<GenerateRequestBody> {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) throw new Error("multipart boundary is required");

  const fields: Record<string, string> = {};
  let uploadedReferenceImagePath: string | null = null;
  const delimiter = Buffer.from(`--${boundary}`);

  for (const rawPart of splitBuffer(buffer, delimiter)) {
    let part = rawPart;
    if (part.length === 0 || part.subarray(0, 2).toString() === "--") continue;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, part.length - 2);

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) continue;

    const headerText = part.subarray(0, headerEnd).toString("utf8");
    const body = part.subarray(headerEnd + 4);
    const headers = parsePartHeaders(headerText);
    const disposition = parseContentDisposition(headers["content-disposition"] || "");
    if (!disposition.name) continue;

    if (disposition.filename) {
      if (!uploadedReferenceImagePath && body.length > 0) {
        uploadedReferenceImagePath = await saveUploadedFile({
          requestId,
          fieldName: disposition.name,
          filename: disposition.filename,
          contentType: headers["content-type"],
          bytes: body
        });
      }
      continue;
    }

    fields[disposition.name] = body.toString("utf8");
  }

  return {
    accountId: fields.accountId,
    model: fields.model as DoubaoModel | undefined,
    aspectRatio: fields.aspectRatio || null,
    duration: fields.duration || null,
    prompt: fields.prompt || "",
    referenceImagePath: uploadedReferenceImagePath || fields.referenceImagePath || null,
    referenceImageUrl: fields.referenceImageUrl || null,
    removeWatermark: parseOptionalBoolean(fields.removeWatermark),
    callbackUrl: fields.callbackUrl || null,
    source: fields.source || "multipart-api"
  };
}

async function prepareReferenceImage(body: GenerateRequestBody, requestId: string) {
  if (body.referenceImagePath?.trim()) return body.referenceImagePath.trim();
  const imageUrl = body.referenceImageUrl?.trim();
  if (!imageUrl) return null;

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`参考图下载失败：HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const urlExt = path.extname(new URL(imageUrl).pathname);
  const ext = urlExt || extensionFromContentType(contentType) || ".png";
  const uploadDir = path.join(app.getPath("userData"), "uploads", new Date().toISOString().slice(0, 10));
  await fs.mkdir(uploadDir, { recursive: true });
  const imagePath = path.join(uploadDir, `${requestId}-reference${ext}`);
  await fs.writeFile(imagePath, Buffer.from(await response.arrayBuffer()));
  return imagePath;
}

async function saveUploadedFile(input: {
  requestId: string;
  fieldName: string;
  filename: string;
  contentType?: string;
  bytes: Buffer;
}) {
  const safeName = sanitizeFilename(input.filename || `${input.fieldName}${extensionFromContentType(input.contentType) || ".png"}`);
  const uploadDir = path.join(app.getPath("userData"), "uploads", new Date().toISOString().slice(0, 10));
  await fs.mkdir(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, `${input.requestId}-${input.fieldName}-${safeName}`);
  await fs.writeFile(filePath, input.bytes);
  return filePath;
}

function splitBuffer(buffer: Buffer, delimiter: Buffer) {
  const parts: Buffer[] = [];
  let start = 0;
  let index = buffer.indexOf(delimiter, start);
  while (index !== -1) {
    if (index > start) {
      parts.push(buffer.subarray(start, index));
    }
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

function parsePartHeaders(value: string) {
  const headers: Record<string, string> = {};
  for (const line of value.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function parseContentDisposition(value: string) {
  const result: { name?: string; filename?: string } = {};
  for (const item of value.split(";")) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    const key = rawKey.trim().toLowerCase();
    const unquoted = rawValue.join("=").trim().replace(/^"|"$/g, "");
    if (key === "name") result.name = unquoted;
    if (key === "filename") result.filename = unquoted;
  }
  return result;
}

function parseOptionalBoolean(value: string | undefined) {
  if (value == null || value === "") return undefined;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function extensionFromContentType(contentType?: string) {
  if (!contentType) return null;
  if (contentType.includes("jpeg")) return ".jpg";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  return null;
}

function sanitizeFilename(value: string) {
  const cleaned = value.replace(/[/\\?%*:|"<>]/g, "_").trim();
  return cleaned.slice(0, 120) || "reference-image";
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  });
  if (statusCode === 204) {
    response.end();
    return;
  }
  response.end(JSON.stringify(payload, null, 2));
}

async function postCallback(payload: ApiRequest) {
  if (!payload.callbackUrl) return;
  await fetch(payload.callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toPublicApiRequest(payload))
  }).catch(() => undefined);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    log.initialize();
    setupChineseMenu();
    db = new AppDatabase();
    executor = new DoubaoExecutor(db, notifyDataChanged, observeWatermarkResponse);
    apiServer = new LocalApiServer(db, executor);
    const queuedRequests = db.prepareQueueAfterRestart();
    quotaTimer = new DailyQuotaTimer(refreshQuotas);
    quotaTimer.start();
    powerMonitor.on("resume", () => quotaTimer?.refresh());
    registerIpc();
    await apiServer.applySettings(db.getSettings());
    for (const requestId of queuedRequests) executor.enqueue(requestId);
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  }).catch((error) => {
    log.error(error);
  });
}

app.on("before-quit", async () => {
  quotaTimer?.stop();
  await apiServer?.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
