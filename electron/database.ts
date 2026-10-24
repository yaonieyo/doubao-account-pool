import path from "node:path";
import Database from "better-sqlite3";
import { app } from "electron";
import { diagnoseRequest } from "./request-diagnostics.js";
import { nextQuotaReset, quotaDate } from "./quota-clock.js";
import { quotaAmount } from "./quota-amount.js";
import { doubaoDailyQuotaError, isDoubaoDailyQuotaExhausted } from "./doubao-quota-state.js";
import { mergeWatermarkStatus, watermarkScope, type WatermarkProviderEvent } from "./watermark-state.js";
import type {
  Account,
  AccountCreateInput,
  AccountUpdateInput,
  ApiRequest,
  ApiRequestCreateInput,
  ApiRequestStatus,
  ApiRequestUpdateInput,
  AppSettings,
  AppSettingsUpdateInput,
  DoubaoModel,
  OperationLog,
  OperationLogCreateInput,
  RequestStats,
  WatermarkStatus
} from "./types.js";

const now = () => new Date().toISOString();
const OPERATION_LOG_RETENTION_DAYS = 3;

export class AssignmentChangedError extends Error {
  constructor() { super("任务已换号，忽略旧执行的迟到反馈"); this.name = "AssignmentChangedError"; }
}

const DEFAULT_SETTINGS: AppSettings = {
  apiServiceEnabled: true,
  apiPort: 17888,
  apiKey: "local-doubao-key",
  executorEnabled: true,
  showExecutorWindow: false,
  autoCloseExecutorWindow: true,
  doubaoChatUrl: "https://www.doubao.com/chat",
  defaultModel: "seedance_2_0_mini",
  dailyQuotaLimit: 10,
  miniCost: 2,
  fastCost: 3,
  dailyResetTime: "00:00",
  generationTimeoutSeconds: 900,
  maxConcurrentAccounts: 5,
  maxConcurrentTasksPerAccount: 3,
  retryCount: 1,
  autoRemoveWatermark: true,
  watermarkApiUrl: "https://nologo.code24.top/api/water-mask/parse",
  watermarkApiToken: "",
  outputDir: ""
};

export class AppDatabase {
  private readonly db: Database.Database;

  constructor(private readonly clock: () => Date = () => new Date()) {
    const dbPath = path.join(app.getPath("userData"), "doubao-manager.sqlite3");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close() { this.db.close(); }

  prepareQueueAfterRestart(): string[] {
    this.db.prepare(`UPDATE api_requests SET status = 'accepted', execution_phase = 'paused',
      message = '程序已重启，原执行已暂停；请恢复已有结果，不会重新提交提示词', updated_at = ? WHERE status = 'running'`)
      .run(this.clock().toISOString());
    return (this.db.prepare("SELECT request_id AS requestId FROM api_requests WHERE status = 'accepted' AND execution_phase = 'queued' ORDER BY id ASC")
      .all() as Array<{ requestId: string }>).map(item => item.requestId);
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        partition TEXT NOT NULL UNIQUE,
        remark TEXT NOT NULL DEFAULT '',
        login_status TEXT NOT NULL DEFAULT 'unknown',
        current_status TEXT NOT NULL DEFAULT 'idle',
        daily_quota_limit INTEGER NOT NULL DEFAULT 10,
        quota_remaining INTEGER NOT NULL DEFAULT 10,
        quota_used_today INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS service_state (
        scope TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL DEFAULT 'local',
        model TEXT NOT NULL,
        aspect_ratio TEXT NOT NULL DEFAULT '16:9',
        duration_seconds INTEGER NOT NULL DEFAULT 10,
        account_id INTEGER,
        status TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
        reference_image_path TEXT,
        remove_watermark INTEGER NOT NULL DEFAULT 1,
        callback_url TEXT,
        doubao_thread_url TEXT,
        raw_video_url TEXT,
        clean_video_url TEXT,
        output_video_path TEXT,
        quota_cost INTEGER NOT NULL DEFAULT 0,
        quota_refunded INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS operation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT,
        account_id INTEGER,
        action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL DEFAULT '',
        target_url TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_operation_logs_request_id ON operation_logs(request_id);
    `);

    this.ensureAccountColumns();
    this.ensureApiRequestColumns();
    this.pruneOperationLogs();
    this.cleanInvalidSuccessfulResults();
    this.ensureDefaultSettings();
    this.migrateExecutorConcurrency();
    this.initializeQuotaPeriods();
    this.repairDailyQuotaFailures();
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_requests_account_status ON api_requests(account_id, status)");
  }

  listAccounts(): Account[] {
    return this.db.prepare(`
      SELECT
        id,
        name,
        partition,
        remark,
        login_status AS loginStatus,
        current_status AS currentStatus,
        daily_quota_limit AS dailyQuotaLimit,
        quota_remaining AS quotaRemaining,
        quota_used_today AS quotaUsedToday,
        quota_date AS quotaDate,
        quota_exhausted_date AS quotaExhaustedDate,
        quota_exhausted_reason AS quotaExhaustedReason,
        last_used_at AS lastUsedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM accounts
      ORDER BY id ASC
    `).all().map((row) => this.decorateAccount(row as Account));
  }

  getAccount(id: number): Account | undefined {
    const row = this.db.prepare(`
      SELECT
        id,
        name,
        partition,
        remark,
        login_status AS loginStatus,
        current_status AS currentStatus,
        daily_quota_limit AS dailyQuotaLimit,
        quota_remaining AS quotaRemaining,
        quota_used_today AS quotaUsedToday,
        quota_date AS quotaDate,
        quota_exhausted_date AS quotaExhaustedDate,
        quota_exhausted_reason AS quotaExhaustedReason,
        last_used_at AS lastUsedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM accounts
      WHERE id = ?
    `).get(id) as Account | undefined;
    return row ? this.decorateAccount(row) : undefined;
  }

  createAccount(input: AccountCreateInput = {}): Account {
    const timestamp = now();
    const settings = this.getSettings();
    const nextNumber = this.nextAccountNumber();
    const name = `账号 ${String(nextNumber).padStart(3, "0")}`;
    const partition = `persist:doubao_account_${String(nextNumber).padStart(3, "0")}`;

    const result = this.db.prepare(`
      INSERT INTO accounts (
        name,
        partition,
        remark,
        login_status,
        current_status,
        daily_quota_limit,
        quota_remaining,
        quota_used_today,
        quota_date,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, 'unknown', 'login_required', ?, ?, 0, ?, ?, ?)
    `).run(
      name,
      partition,
      input.remark?.trim() || "",
      settings.dailyQuotaLimit,
      settings.dailyQuotaLimit,
      quotaDate(this.clock()),
      timestamp,
      timestamp
    );

    return this.getAccount(Number(result.lastInsertRowid))!;
  }

  updateAccount(input: AccountUpdateInput): Account {
    const existing = this.getAccount(input.id);
    if (!existing) throw new Error("Account not found");

    const updated = {
      remark: input.remark ?? existing.remark,
      loginStatus: input.loginStatus ?? existing.loginStatus,
      currentStatus: input.currentStatus ?? existing.currentStatus,
      dailyQuotaLimit: input.dailyQuotaLimit ?? existing.dailyQuotaLimit,
      quotaRemaining: input.quotaRemaining ?? existing.quotaRemaining,
      quotaUsedToday: input.quotaUsedToday ?? existing.quotaUsedToday,
      updatedAt: now()
    };

    this.db.prepare(`
      UPDATE accounts
      SET
        remark = ?,
        login_status = ?,
        current_status = ?,
        daily_quota_limit = ?,
        quota_remaining = ?,
        quota_used_today = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      updated.remark.trim(),
      updated.loginStatus,
      updated.currentStatus,
      clampInt(updated.dailyQuotaLimit),
      quotaAmount(updated.quotaRemaining),
      quotaAmount(updated.quotaUsedToday),
      updated.updatedAt,
      input.id
    );

    return this.getAccount(input.id)!;
  }

  deleteAccount(id: number) {
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  }

  resetAccountQuota(id: number): Account {
    this.refreshDailyQuotas();
    const account = this.getAccount(id);
    if (account && account.runningTaskCount + account.queuedTaskCount > 0) throw new Error("账号还有执行或排队任务，不能手动覆盖预扣额度；自动跨日重置不受影响");
    this.db.prepare(`
      UPDATE accounts
      SET
        mini_remaining = mini_daily_limit,
        mini_used_today = 0,
        fast_remaining = fast_daily_limit,
        fast_used_today = 0,
        quota_remaining = daily_quota_limit,
        quota_used_today = 0,
        updated_at = ?
      WHERE id = ?
    `).run(now(), id);
    return this.getAccount(id)!;
  }

  resetAllQuotas(): Account[] {
    this.refreshDailyQuotas();
    if (this.listAccounts().some(account => account.runningTaskCount + account.queuedTaskCount > 0)) throw new Error("仍有执行或排队任务，不能手动覆盖全部额度；自动跨日重置不受影响");
    this.db.prepare(`
      UPDATE accounts
      SET
        mini_remaining = mini_daily_limit,
        mini_used_today = 0,
        fast_remaining = fast_daily_limit,
        fast_used_today = 0,
        quota_remaining = daily_quota_limit,
        quota_used_today = 0,
        updated_at = ?
    `).run(now());
    return this.listAccounts();
  }

  findAvailableAccount(model: DoubaoModel, accountId?: number, storedCost?: number): Account | undefined {
    const settings = this.getSettings();
    const requiredQuota = storedCost ?? (model === "seedance_2_0_mini" ? settings.miniCost : settings.fastCost);
    const row = this.db.prepare(`
      SELECT
        id
      FROM accounts
      WHERE login_status = 'logged_in'
        AND current_status <> 'login_required'
        AND quota_remaining >= ?
        AND quota_date = ?
        AND (quota_exhausted_date IS NULL OR quota_exhausted_date <> ?)
        AND (? IS NULL OR id = ?)
      ORDER BY
        (SELECT COUNT(*) FROM api_requests r WHERE r.account_id = accounts.id AND r.status IN ('accepted', 'running')) ASC,
        CASE WHEN last_used_at IS NULL THEN 0 ELSE 1 END ASC,
        last_used_at ASC,
        id ASC
      LIMIT 1
    `).get(requiredQuota, quotaDate(this.clock()), quotaDate(this.clock()), accountId ?? null, accountId ?? null) as { id: number } | undefined;
    return row ? this.getAccount(row.id) : undefined;
  }

  acceptApiRequest(input: Omit<ApiRequestCreateInput, "accountId" | "status" | "quotaCost" | "quotaDay" | "quotaReserved">, accountId?: number): ApiRequest | undefined {
    return this.db.transaction(() => {
      this.refreshDailyQuotas();
      const account = this.findAvailableAccount(input.model, accountId);
      if (!account) return undefined;
      const settings = this.getSettings();
      const cost = input.model === "seedance_2_0_mini" ? settings.miniCost : settings.fastCost;
      const changed = this.db.prepare(`UPDATE accounts SET quota_remaining = ROUND(quota_remaining - ?, 1), quota_used_today = ROUND(quota_used_today + ?, 1), last_used_at = ?, updated_at = ? WHERE id = ? AND quota_remaining >= ?`)
        .run(cost, cost, this.clock().toISOString(), this.clock().toISOString(), account.id, cost);
      if (!changed.changes) return undefined;
      return this.createApiRequest({ ...input, accountId: account.id, requestedAccountId: accountId ?? null, status: "accepted", quotaCost: cost, quotaDay: account.quotaDate, quotaReserved: true, executionPhase: "queued",
        message: settings.executorEnabled ? `已接收，已预扣 ${cost} 额度，已进入执行队列` : `已接收，已预扣 ${cost} 额度，自动执行已关闭` });
    })();
  }

  assertAssignment(request: ApiRequest | undefined, revision?: number) {
    if (revision !== undefined && request?.assignmentRevision !== revision) throw new AssignmentChangedError();
  }

  beginRecoveryAssignment(requestId: string): ApiRequest | undefined {
    const request = this.getApiRequest(requestId);
    if (!request) return undefined;
    this.db.prepare("UPDATE api_requests SET assignment_revision = assignment_revision + 1 WHERE request_id = ?").run(requestId);
    return this.getApiRequest(requestId);
  }

  markDailyQuotaExhausted(accountId: number, reason: string) {
    if (!isDoubaoDailyQuotaExhausted(reason)) throw new Error("不是明确的豆包每日次数耗尽回复");
    const account = this.getAccount(accountId);
    if (!account) throw new Error("Account not found");
    this.db.prepare("UPDATE accounts SET quota_exhausted_date = ?, quota_exhausted_reason = ?, updated_at = ? WHERE id = ?")
      .run(quotaDate(this.clock()), reason, this.clock().toISOString(), accountId);
    if (!account.dailyQuotaExhausted) this.appendOperationLog({ accountId, action: "豆包今日次数已用完", status: "failed", message: reason });
  }

  handleDailyQuotaExhaustion(requestId: string, revision: number, reason: string): ApiRequest[] {
    return this.db.transaction(() => {
      const request = this.getApiRequest(requestId);
      this.assertAssignment(request, revision);
      if (!request?.accountId || !["accepted", "running"].includes(request.status)) return [];
      this.markDailyQuotaExhausted(request.accountId, reason);
      const queued = this.db.prepare(`SELECT request_id AS requestId FROM api_requests WHERE account_id = ?
        AND status = 'accepted' AND execution_phase = 'queued' AND submission_sent_at IS NULL AND request_id <> ? ORDER BY id`)
        .all(request.accountId, requestId) as Array<{ requestId: string }>;
      const changed = request.generationAcceptedAt ? [] : [this.rerouteUnacceptedRequest(requestId, revision, true)];
      for (const item of queued) {
        const pending = this.getApiRequest(item.requestId)!;
        changed.push(this.rerouteUnacceptedRequest(item.requestId, pending.assignmentRevision));
      }
      return changed;
    })();
  }

  rerouteUnacceptedRequest(requestId: string, revision: number, confirmedRejection = false): ApiRequest {
    return this.db.transaction(() => {
      this.refreshDailyQuotas();
      const request = this.getApiRequest(requestId);
      this.assertAssignment(request, revision);
      if (!request?.accountId || !["accepted", "running"].includes(request.status)) throw new AssignmentChangedError();
      const previous = this.getAccount(request.accountId)!;
      if (!previous.dailyQuotaExhausted) return request;
      if (request.generationAcceptedAt || request.submissionSentAt && !confirmedRejection) {
        throw new Error("已发送或受理的任务不能根据其他任务的反馈自动换号");
      }
      const reason = previous.quotaExhaustedReason || "今日视频生成免费次数已用完";
      const next = request.requestedAccountId ? undefined : this.findAvailableAccount(request.model, undefined, request.quotaCost);
      if (!next) return this.failExhaustedRequest(request, reason);

      this.refundApiRequestQuota(requestId, revision);
      const reserved = this.db.prepare(`UPDATE accounts SET quota_remaining = ROUND(quota_remaining - ?, 1), quota_used_today = ROUND(quota_used_today + ?, 1),
        last_used_at = ?, updated_at = ? WHERE id = ? AND quota_date = ? AND quota_remaining >= ?
        AND (quota_exhausted_date IS NULL OR quota_exhausted_date <> ?)`)
        .run(request.quotaCost, request.quotaCost, this.clock().toISOString(), this.clock().toISOString(), next.id,
          quotaDate(this.clock()), request.quotaCost, quotaDate(this.clock()));
      if (!reserved.changes) throw new Error("换号预扣失败，已回滚原分配");
      const message = `账号 ${previous.name} 今日免费次数已用完，已自动换至 ${next.name} 继续，等待执行`;
      this.db.prepare(`UPDATE api_requests SET account_id = ?, assignment_revision = assignment_revision + 1,
        quota_date = ?, quota_reserved = 1, quota_refunded = 0, status = 'accepted', execution_phase = 'queued',
        submission_sent_at = NULL, generation_accepted_at = NULL, source_conversation_url = NULL, doubao_thread_url = NULL,
        raw_video_url = NULL, clean_video_url = NULL, output_video_path = NULL, error_json = NULL,
        message = ?, updated_at = ?, finished_at = NULL WHERE request_id = ?`)
        .run(next.id, quotaDate(this.clock()), message, this.clock().toISOString(), requestId);
      this.refreshAccountStatus(previous.id);
      this.refreshAccountStatus(next.id);
      this.appendOperationLog({ requestId, accountId: next.id, action: "额度耗尽自动换号", status: "success",
        message: `${message}；分配版本 ${revision} -> ${revision + 1}，已释放原预扣并在新账号预扣 ${request.quotaCost} 点` });
      return this.getApiRequest(requestId)!;
    })();
  }

  private failExhaustedRequest(request: ApiRequest, reason: string): ApiRequest {
    const refunded = this.refundApiRequestQuota(request.requestId, request.assignmentRevision);
    const outcome = request.requestedAccountId ? "本任务指定了账号，不自动换号" : request.generationAcceptedAt
      ? "本任务已记录受理，不自动重复生成" : "暂无其他有额度的可用账号";
    const updated = this.updateApiRequest({ requestId: request.requestId, assignmentRevision: request.assignmentRevision, status: "failed",
      message: `豆包今日免费次数已用完；${outcome}${refunded ? "；已退回预扣额度" : ""}。豆包原文：${reason}`,
      error: doubaoDailyQuotaError(reason) });
    this.appendOperationLog({ requestId: request.requestId, accountId: request.accountId, action: "任务失败", status: "failed", message: updated.message });
    return updated;
  }

  refreshDailyQuotas(): number {
    return this.db.transaction(() => {
      const day = quotaDate(this.clock());
      const timestamp = this.clock().toISOString();
      const expired = this.db.prepare("SELECT id FROM accounts WHERE quota_date < ?").all(day) as Array<{ id: number }>;
      for (const { id } of expired) {
        this.db.prepare(`UPDATE accounts SET quota_date = ?, quota_remaining = daily_quota_limit, quota_used_today = 0,
          mini_remaining = mini_daily_limit, mini_used_today = 0, fast_remaining = fast_daily_limit, fast_used_today = 0,
          quota_exhausted_reason = CASE WHEN quota_exhausted_date = ? THEN quota_exhausted_reason ELSE NULL END,
          quota_exhausted_date = CASE WHEN quota_exhausted_date = ? THEN quota_exhausted_date ELSE NULL END,
          updated_at = ? WHERE id = ?`).run(day, day, day, timestamp, id);
        this.db.prepare(`UPDATE api_requests SET quota_reserved = 0 WHERE account_id = ? AND status IN ('accepted', 'running')
          AND generation_accepted_at IS NULL AND execution_phase <> 'paused' AND quota_refunded = 0`).run(id);
        this.appendOperationLog({ accountId: id, action: "自动重置每日额度", status: "success", message: `北京时间 ${day} 00:00 已切换额度账期；已受理的旧任务仍归原账期` });
      }
      const waiting = this.db.prepare(`SELECT request_id AS requestId, account_id AS accountId, quota_cost AS cost FROM api_requests
        WHERE status IN ('accepted', 'running') AND quota_refunded = 0 AND quota_reserved = 0 AND quota_cost > 0
          AND generation_accepted_at IS NULL AND execution_phase <> 'paused' ORDER BY id ASC`).all() as Array<{ requestId: string; accountId: number; cost: number }>;
      let funded = 0;
      for (const task of waiting) {
        const result = this.db.prepare(`UPDATE accounts SET quota_remaining = ROUND(quota_remaining - ?, 1), quota_used_today = ROUND(quota_used_today + ?, 1), updated_at = ?
          WHERE id = ? AND quota_date = ? AND quota_remaining >= ? AND (quota_exhausted_date IS NULL OR quota_exhausted_date <> ?)`).run(task.cost, task.cost, timestamp, task.accountId, day, task.cost, day);
        if (!result.changes) continue;
        this.db.prepare("UPDATE api_requests SET quota_reserved = 1, quota_date = ?, updated_at = ? WHERE request_id = ?").run(day, timestamp, task.requestId);
        funded++;
      }
      return expired.length + funded;
    })();
  }

  ensureRequestQuota(requestId: string): boolean {
    this.refreshDailyQuotas();
    const task = this.getApiRequest(requestId);
    if (!task || task.status === "stopped") return false;
    if (task.generationAcceptedAt) return true;
    return task.quotaReserved && !task.quotaRefunded && task.quotaDay === quotaDate(this.clock());
  }

  markGenerationAccepted(requestId: string, assignmentRevision?: number) {
    return this.db.transaction(() => {
      this.refreshDailyQuotas();
      const task = this.getApiRequest(requestId);
      this.assertAssignment(task, assignmentRevision);
      if (!task?.accountId || task.status === "stopped") throw new Error("任务已终止，不能登记生成受理");
      if (task.generationAcceptedAt) return task;
      if (!task.quotaReserved) {
        // Preserve a real platform acceptance even if the clock/limit changed during the reply.
        this.db.prepare(`UPDATE accounts SET quota_remaining = MAX(0, ROUND(quota_remaining - ?, 1)), quota_used_today = ROUND(quota_used_today + ?, 1) WHERE id = ?`)
          .run(task.quotaCost, task.quotaCost, task.accountId);
      }
      this.db.prepare(`UPDATE api_requests SET generation_accepted_at = ?, quota_date = ?, quota_reserved = 1, execution_phase = 'generating' WHERE request_id = ?`)
        .run(this.clock().toISOString(), quotaDate(this.clock()), requestId);
      return this.getApiRequest(requestId)!;
    })();
  }

  refreshAccountStatus(accountId: number) {
    this.db.prepare(`UPDATE accounts SET current_status = CASE WHEN login_status <> 'logged_in' THEN 'login_required'
      WHEN EXISTS(SELECT 1 FROM api_requests WHERE account_id = ? AND status IN ('accepted','running')) THEN 'busy' ELSE 'idle' END WHERE id = ?`)
      .run(accountId, accountId);
  }

  getOtherBoundConversations(accountId: number, requestId: string): string[] {
    return (this.db.prepare("SELECT source_conversation_url AS url FROM api_requests WHERE account_id = ? AND request_id <> ? AND source_conversation_url IS NOT NULL")
      .all(accountId, requestId) as Array<{ url: string }>).map(row => row.url);
  }

  getSettings(): AppSettings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    const data = { ...DEFAULT_SETTINGS } as Record<keyof AppSettings, unknown>;
    for (const row of rows) {
      if (isSettingsKey(row.key)) {
        data[row.key] = parseSettingValue(row.key, row.value);
      }
    }
    return data as AppSettings;
  }

  updateSettings(input: AppSettingsUpdateInput): AppSettings {
    const current = this.getSettings();
    const next: AppSettings = {
      ...current,
      ...input,
      apiPort: clampPort(input.apiPort ?? current.apiPort),
      executorEnabled: Boolean(input.executorEnabled ?? current.executorEnabled),
      showExecutorWindow: Boolean(input.showExecutorWindow ?? current.showExecutorWindow),
      autoCloseExecutorWindow: Boolean(input.autoCloseExecutorWindow ?? current.autoCloseExecutorWindow),
      doubaoChatUrl: String(input.doubaoChatUrl || current.doubaoChatUrl || DEFAULT_SETTINGS.doubaoChatUrl),
      dailyQuotaLimit: clampInt(input.dailyQuotaLimit ?? current.dailyQuotaLimit),
      miniCost: Math.max(1, quotaAmount(input.miniCost ?? current.miniCost)),
      fastCost: Math.max(1, quotaAmount(input.fastCost ?? current.fastCost)),
      generationTimeoutSeconds: clampInt(input.generationTimeoutSeconds ?? current.generationTimeoutSeconds),
      maxConcurrentAccounts: Math.max(1, clampInt(input.maxConcurrentAccounts ?? current.maxConcurrentAccounts)),
      maxConcurrentTasksPerAccount: Math.min(5, Math.max(1, clampInt(input.maxConcurrentTasksPerAccount ?? current.maxConcurrentTasksPerAccount))),
      dailyResetTime: "00:00",
      retryCount: clampInt(input.retryCount ?? current.retryCount)
    };

    const timestamp = now();
    const statement = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      WHERE settings.value <> excluded.value
    `);

    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
      const value = next[key];
      statement.run(key, stringifySettingValue(value), timestamp);
    }

    return this.getSettings();
  }

  getWatermarkStatus(settings = this.getSettings()): WatermarkStatus {
    const empty: WatermarkStatus = {
      configured: Boolean(settings.watermarkApiToken.trim()), usage: null, checkedAt: null, usageUpdatedAt: null, error: null
    };
    if (!empty.configured) return empty;
    const row = this.db.prepare("SELECT value FROM service_state WHERE scope = ?").get(watermarkScope(settings)) as { value: string } | undefined;
    if (!row) return empty;
    try { return { ...empty, ...JSON.parse(row.value) }; } catch { return empty; }
  }

  recordWatermarkResponse(settings: AppSettings, event: WatermarkProviderEvent) {
    const state = mergeWatermarkStatus(this.getWatermarkStatus(settings), event);
    this.db.prepare("INSERT INTO service_state(scope, value) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET value = excluded.value")
      .run(watermarkScope(settings), JSON.stringify(state));
  }

  getRequestStats(startIso: string, endIso: string): RequestStats {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'failed' AND finished_at >= ? AND finished_at < ? THEN 1 ELSE 0 END), 0) AS todayFailed,
        COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running,
        COALESCE(SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END), 0) AS queued
      FROM api_requests
    `).get(startIso, endIso) as Omit<RequestStats, "todaySuccess">;
    return { ...row, todaySuccess: this.countSuccessfulVideosBetween(startIso, endIso) };
  }

  listApiRequests(limit = 100): ApiRequest[] {
    return this.db.prepare(`
      SELECT
        api_requests.id,
        api_requests.request_id AS requestId,
        api_requests.source,
        api_requests.model,
        api_requests.aspect_ratio AS aspectRatio,
        api_requests.duration_seconds AS duration,
        api_requests.account_id AS accountId,
        api_requests.requested_account_id AS requestedAccountId,
        api_requests.assignment_revision AS assignmentRevision,
        api_requests.submission_sent_at AS submissionSentAt,
        accounts.name AS accountName,
        accounts.partition AS accountPartition,
        api_requests.status,
        api_requests.message,
        api_requests.error_json AS errorJson,
        api_requests.prompt,
        api_requests.reference_image_path AS referenceImagePath,
        api_requests.remove_watermark AS removeWatermark,
        api_requests.callback_url AS callbackUrl,
        api_requests.doubao_thread_url AS doubaoThreadUrl,
        api_requests.source_conversation_url AS sourceConversationUrl,
        api_requests.execution_phase AS executionPhase,
        api_requests.quota_date AS quotaDay,
        api_requests.quota_cost AS quotaCost,
        api_requests.quota_reserved AS quotaReserved,
        api_requests.generation_accepted_at AS generationAcceptedAt,
        api_requests.raw_video_url AS rawVideoUrl,
        api_requests.clean_video_url AS cleanVideoUrl,
        api_requests.output_video_path AS outputVideoPath,
        api_requests.quota_refunded AS quotaRefunded,
        api_requests.created_at AS createdAt,
        api_requests.updated_at AS updatedAt,
        api_requests.finished_at AS finishedAt
      FROM api_requests
      LEFT JOIN accounts ON accounts.id = api_requests.account_id
      ORDER BY api_requests.id DESC
      LIMIT ?
    `).all(limit).map(normalizeApiRequest);
  }

  countSuccessfulVideosBetween(startIso: string, endIso: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM api_requests
      WHERE status = 'success'
        AND finished_at >= ?
        AND finished_at < ?
        AND (
          (clean_video_url IS NOT NULL AND TRIM(clean_video_url) <> '')
          OR LOWER(COALESCE(output_video_path, '')) LIKE '%.mp4'
        )
    `).get(startIso, endIso) as { count: number };

    return Number(row.count || 0);
  }

  getApiRequest(requestId: string): ApiRequest | undefined {
    const row = this.db.prepare(`
      SELECT
        api_requests.id,
        api_requests.request_id AS requestId,
        api_requests.source,
        api_requests.model,
        api_requests.aspect_ratio AS aspectRatio,
        api_requests.duration_seconds AS duration,
        api_requests.account_id AS accountId,
        api_requests.requested_account_id AS requestedAccountId,
        api_requests.assignment_revision AS assignmentRevision,
        api_requests.submission_sent_at AS submissionSentAt,
        accounts.name AS accountName,
        accounts.partition AS accountPartition,
        api_requests.status,
        api_requests.message,
        api_requests.error_json AS errorJson,
        api_requests.prompt,
        api_requests.reference_image_path AS referenceImagePath,
        api_requests.remove_watermark AS removeWatermark,
        api_requests.callback_url AS callbackUrl,
        api_requests.doubao_thread_url AS doubaoThreadUrl,
        api_requests.source_conversation_url AS sourceConversationUrl,
        api_requests.execution_phase AS executionPhase,
        api_requests.quota_date AS quotaDay,
        api_requests.quota_cost AS quotaCost,
        api_requests.quota_reserved AS quotaReserved,
        api_requests.generation_accepted_at AS generationAcceptedAt,
        api_requests.raw_video_url AS rawVideoUrl,
        api_requests.clean_video_url AS cleanVideoUrl,
        api_requests.output_video_path AS outputVideoPath,
        api_requests.quota_refunded AS quotaRefunded,
        api_requests.created_at AS createdAt,
        api_requests.updated_at AS updatedAt,
        api_requests.finished_at AS finishedAt
      FROM api_requests
      LEFT JOIN accounts ON accounts.id = api_requests.account_id
      WHERE api_requests.request_id = ?
    `).get(requestId);
    return row ? normalizeApiRequest(row) : undefined;
  }

  createApiRequest(input: ApiRequestCreateInput): ApiRequest {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO api_requests (
        request_id,
        source,
        model,
        aspect_ratio,
        duration_seconds,
        account_id,
        requested_account_id,
        status,
        message,
        prompt,
        reference_image_path,
        remove_watermark,
        callback_url,
        quota_cost,
        quota_date,
        quota_reserved,
        execution_phase,
        created_at,
        updated_at,
        finished_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.requestId,
      input.source || "local-api",
      input.model,
      input.aspectRatio || "16:9",
      clampInt(input.duration || 10),
      input.accountId ?? null,
      input.requestedAccountId ?? null,
      input.status,
      input.message || "",
      input.prompt,
      input.referenceImagePath || null,
      input.removeWatermark === false ? 0 : 1,
      input.callbackUrl || null,
      quotaAmount(input.quotaCost || 0),
      input.quotaDay || null,
      input.quotaReserved ? 1 : 0,
      input.executionPhase || (input.status === "accepted" || input.status === "running" ? "paused" : "finished"),
      timestamp,
      timestamp,
      input.status === "failed" || input.status === "success" || input.status === "stopped" ? timestamp : null
    );
    if (input.accountId) this.refreshAccountStatus(input.accountId);
    return this.getApiRequest(input.requestId)!;
  }

  updateApiRequestStatus(requestId: string, status: ApiRequestStatus, message: string) {
    const finishedAt = status === "success" || status === "failed" || status === "stopped" ? now() : null;
    this.db.prepare(`
      UPDATE api_requests
      SET status = ?, message = ?, updated_at = ?, finished_at = COALESCE(?, finished_at)
      WHERE request_id = ?
    `).run(status, message, now(), finishedAt, requestId);
    return this.getApiRequest(requestId)!;
  }

  stopApiRequestAndRefund(requestId: string): { request: ApiRequest; stopped: boolean; refunded: boolean } {
    this.refreshDailyQuotas();
    return this.db.transaction(() => {
      const row = this.getApiRequest(requestId);
      if (!row) throw new Error("Request not found");
      if (row.status !== "accepted" && row.status !== "running") {
        return { request: this.getApiRequest(requestId)!, stopped: false, refunded: false };
      }

      const refunded = this.refundApiRequestQuota(requestId);
      const timestamp = now();
      const message = refunded
        ? row.quotaDay === quotaDate(this.clock())
          ? `用户已终止任务，已退回预扣 ${row.quotaCost} 额度`
          : `用户已终止任务，已退回原账期 ${row.quotaDay} 的预扣额度，不增加今日余额`
        : "用户已终止任务，预扣额度此前已退回或该任务未预扣额度";
      this.db.prepare(`
        UPDATE api_requests
        SET status = 'stopped', execution_phase = 'finished', message = ?, updated_at = ?, finished_at = ?
        WHERE request_id = ?
      `).run(message, timestamp, timestamp, requestId);
      if (row.accountId) this.refreshAccountStatus(row.accountId);
      return { request: this.getApiRequest(requestId)!, stopped: true, refunded };
    })();
  }

  refundApiRequestQuota(requestId: string, assignmentRevision?: number): boolean {
    this.refreshDailyQuotas();
    return this.db.transaction(() => {
      const row = this.getApiRequest(requestId);
      this.assertAssignment(row, assignmentRevision);
      if (!row?.accountId || row.quotaRefunded || row.message.includes("已退回预扣额度")) return false;
      if (row.quotaCost <= 0) return false;
      const timestamp = now();
      const account = this.getAccount(row.accountId);
      if (row.quotaReserved && row.quotaDay === account?.quotaDate) this.db.prepare(`
        UPDATE accounts
        SET quota_remaining = MIN(daily_quota_limit, ROUND(quota_remaining + ?, 1)),
            quota_used_today = MAX(0, ROUND(quota_used_today - ?, 1)),
            updated_at = ?
        WHERE id = ?
      `).run(row.quotaCost, row.quotaCost, timestamp, row.accountId);
      this.db.prepare(`UPDATE api_requests SET quota_refunded = 1, quota_reserved = 0, updated_at = ? WHERE request_id = ?`)
        .run(timestamp, requestId);
      this.appendOperationLog({ requestId, accountId: row.accountId, action: "退回任务预扣额度", status: "success",
        message: row.quotaDay === account?.quotaDate ? `已退回 ${row.quotaCost} 点预扣额度` : `已退回原账期 ${row.quotaDay} 的预扣记录，不增加今日余额` });
      return true;
    })();
  }

  updateApiRequest(input: ApiRequestUpdateInput) {
    const existing = this.getApiRequest(input.requestId);
    if (!existing) throw new Error("Request not found");
    this.assertAssignment(existing, input.assignmentRevision);

    const status = input.status ?? existing.status;
    if (input.sourceConversationUrl && input.sourceConversationUrl !== existing.sourceConversationUrl) {
      const owner = this.db.prepare("SELECT request_id FROM api_requests WHERE source_conversation_url = ? AND request_id <> ? LIMIT 1")
        .get(input.sourceConversationUrl, input.requestId);
      if (owner) throw new Error("本次豆包对话已绑定其他任务，已暂停以避免串单");
    }
    const finishedAt = status === "success" || status === "failed" || status === "stopped" ? now() : null;
    this.db.prepare(`
      UPDATE api_requests
      SET
        status = ?,
        message = ?,
        doubao_thread_url = ?,
        source_conversation_url = ?,
        execution_phase = ?,
        submission_sent_at = ?,
        raw_video_url = ?,
        clean_video_url = ?,
        output_video_path = ?,
        error_json = ?,
        updated_at = ?,
        finished_at = COALESCE(?, finished_at)
      WHERE request_id = ?
    `).run(
      status,
      input.message ?? existing.message,
      input.doubaoThreadUrl ?? existing.doubaoThreadUrl,
      input.sourceConversationUrl ?? existing.sourceConversationUrl,
      status === "success" || status === "failed" || status === "stopped" ? "finished" : input.executionPhase ?? existing.executionPhase,
      input.submissionSentAt === undefined ? existing.submissionSentAt : input.submissionSentAt,
      input.rawVideoUrl ?? existing.rawVideoUrl,
      input.cleanVideoUrl ?? existing.cleanVideoUrl,
      input.outputVideoPath ?? existing.outputVideoPath,
      status === "failed" ? JSON.stringify(input.error || existing.error || diagnoseRequest(input.message || existing.message)) : null,
      now(),
      finishedAt,
      input.requestId
    );
    if (existing.accountId) this.refreshAccountStatus(existing.accountId);
    return this.getApiRequest(input.requestId)!;
  }

  clearApiRequests() {
    this.db.prepare("DELETE FROM api_requests").run();
  }

  appendOperationLog(input: OperationLogCreateInput): OperationLog {
    this.pruneOperationLogs();
    const timestamp = now();
    const result = this.db.prepare(`
      INSERT INTO operation_logs (
        request_id,
        account_id,
        action,
        status,
        message,
        target_url,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.requestId || null,
      input.accountId ?? null,
      input.action,
      input.status || "info",
      input.message,
      input.targetUrl || null,
      timestamp
    );
    return this.getOperationLog(Number(result.lastInsertRowid))!;
  }

  listOperationLogs(limit = 500): OperationLog[] {
    this.pruneOperationLogs();
    return this.db.prepare(`
      SELECT
        operation_logs.id,
        operation_logs.request_id AS requestId,
        operation_logs.account_id AS accountId,
        accounts.name AS accountName,
        accounts.partition AS accountPartition,
        operation_logs.action,
        operation_logs.status,
        operation_logs.message,
        operation_logs.target_url AS targetUrl,
        operation_logs.created_at AS createdAt
      FROM operation_logs
      LEFT JOIN accounts ON accounts.id = operation_logs.account_id
      ORDER BY operation_logs.id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(2000, limit))).map(normalizeOperationLog);
  }

  getOperationLog(id: number): OperationLog | undefined {
    const row = this.db.prepare(`
      SELECT
        operation_logs.id,
        operation_logs.request_id AS requestId,
        operation_logs.account_id AS accountId,
        accounts.name AS accountName,
        accounts.partition AS accountPartition,
        operation_logs.action,
        operation_logs.status,
        operation_logs.message,
        operation_logs.target_url AS targetUrl,
        operation_logs.created_at AS createdAt
      FROM operation_logs
      LEFT JOIN accounts ON accounts.id = operation_logs.account_id
      WHERE operation_logs.id = ?
    `).get(id);
    return row ? normalizeOperationLog(row) : undefined;
  }

  clearOperationLogs() {
    this.db.prepare("DELETE FROM operation_logs").run();
  }

  private pruneOperationLogs() {
    const cutoff = new Date(Date.now() - OPERATION_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare("DELETE FROM operation_logs WHERE created_at < ?").run(cutoff);
  }

  private ensureDefaultSettings() {
    const existingCount = this.db.prepare("SELECT COUNT(*) AS count FROM settings").get() as { count: number };
    if (existingCount.count === 0) {
      this.updateSettings(DEFAULT_SETTINGS);
    }
  }

  private initializeQuotaPeriods() {
    const day = quotaDate(this.clock());
    this.db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'dailyResetTime' AND value <> ?")
      .run(JSON.stringify("00:00"), now(), JSON.stringify("00:00"));
    this.db.prepare("UPDATE accounts SET quota_date = ? WHERE quota_date = '' OR quota_date IS NULL").run(day);
    const migrated = this.db.prepare("SELECT 1 FROM settings WHERE key = 'quotaPeriodsV1'").get();
    if (!migrated) {
      this.db.prepare(`UPDATE api_requests SET quota_date = date(created_at, '+8 hours'),
        quota_reserved = CASE WHEN quota_cost > 0 AND quota_refunded = 0 AND message NOT LIKE '%已退回预扣额度%' THEN 1 ELSE 0 END,
        source_conversation_url = CASE WHEN doubao_thread_url LIKE 'https://www.doubao.com/chat/%' THEN doubao_thread_url ELSE NULL END`).run();
      this.db.prepare("INSERT INTO settings(key,value,updated_at) VALUES ('quotaPeriodsV1','true',?)").run(now());
    }
  }

  private repairDailyQuotaFailures() {
    const migration = "doubaoDailyQuotaV1";
    if (this.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(migration)) return;
    this.db.transaction(() => {
      const day = quotaDate(this.clock());
      const failures = this.db.prepare(`SELECT request_id AS requestId FROM api_requests WHERE status = 'failed' AND account_id IS NOT NULL
        AND date(created_at, '+8 hours') = ? AND date(COALESCE(finished_at, updated_at), '+8 hours') = ?
        AND message NOT LIKE '恢复结果失败%' ORDER BY id`).all(day, day) as Array<{ requestId: string }>;
      for (const { requestId } of failures) {
        const request = this.getApiRequest(requestId)!;
        if (request.error?.stage === "watermark" || !isDoubaoDailyQuotaExhausted(request.message)) continue;
        this.markDailyQuotaExhausted(request.accountId!, request.message);
        this.db.prepare("UPDATE api_requests SET error_json = ? WHERE request_id = ?")
          .run(JSON.stringify(doubaoDailyQuotaError(request.message)), requestId);
      }
      this.db.prepare("INSERT INTO settings(key,value,updated_at) VALUES (?, 'true', ?)").run(migration, this.clock().toISOString());
    })();
  }

  private decorateAccount(account: Account): Account {
    const counts = this.db.prepare(`SELECT COALESCE(SUM(status = 'running'),0) AS runningTaskCount,
      COALESCE(SUM(status = 'accepted'),0) AS queuedTaskCount FROM api_requests WHERE account_id = ? AND status IN ('accepted','running')`)
      .get(account.id) as { runningTaskCount: number; queuedTaskCount: number };
    const dailyQuotaExhausted = account.quotaExhaustedDate === quotaDate(this.clock());
    return { ...account, ...counts, dailyQuotaExhausted, availableQuota: dailyQuotaExhausted ? 0 : account.quotaRemaining, nextQuotaResetAt: nextQuotaReset(this.clock()),
      maxConcurrentTasks: this.getSettings().maxConcurrentTasksPerAccount,
      currentStatus: account.loginStatus !== "logged_in" || account.currentStatus === "login_required" ? "login_required" : counts.runningTaskCount + counts.queuedTaskCount > 0 ? "busy" : "idle" };
  }

  private migrateExecutorConcurrency() {
    const migrationKey = "executorConcurrencyV1";
    const migrated = this.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(migrationKey);
    if (migrated) return;

    const timestamp = now();
    this.db.prepare(`
      UPDATE settings
      SET value = '4', updated_at = ?
      WHERE key = 'maxConcurrentAccounts' AND CAST(value AS INTEGER) = 1
    `).run(timestamp);
    this.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, 'true', ?)")
      .run(migrationKey, timestamp);
  }

  private ensureAccountColumns() {
    this.addColumnIfMissing("accounts", "name", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("accounts", "remark", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("accounts", "current_status", "TEXT NOT NULL DEFAULT 'idle'");
    this.addColumnIfMissing("accounts", "daily_quota_limit", "INTEGER NOT NULL DEFAULT 10");
    this.addColumnIfMissing("accounts", "quota_remaining", "INTEGER NOT NULL DEFAULT 10");
    this.addColumnIfMissing("accounts", "quota_used_today", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("accounts", "quota_date", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("accounts", "quota_exhausted_date", "TEXT");
    this.addColumnIfMissing("accounts", "quota_exhausted_reason", "TEXT");
    this.addColumnIfMissing("accounts", "mini_daily_limit", "INTEGER NOT NULL DEFAULT 5");
    this.addColumnIfMissing("accounts", "mini_remaining", "INTEGER NOT NULL DEFAULT 5");
    this.addColumnIfMissing("accounts", "mini_used_today", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("accounts", "fast_daily_limit", "INTEGER NOT NULL DEFAULT 3");
    this.addColumnIfMissing("accounts", "fast_remaining", "INTEGER NOT NULL DEFAULT 3");
    this.addColumnIfMissing("accounts", "fast_used_today", "INTEGER NOT NULL DEFAULT 0");

    this.db.prepare(`
      UPDATE accounts
      SET
        name = CASE WHEN name = '' THEN '账号 ' || printf('%03d', id) ELSE name END,
        remark = CASE WHEN remark = '' AND name NOT LIKE '账号 %' THEN name ELSE remark END,
        daily_quota_limit = CASE WHEN daily_quota_limit = 10 AND (mini_daily_limit + fast_daily_limit) != 8 THEN mini_daily_limit + fast_daily_limit ELSE daily_quota_limit END,
        quota_remaining = CASE WHEN quota_remaining = 10 AND (mini_remaining + fast_remaining) != 8 THEN mini_remaining + fast_remaining ELSE quota_remaining END,
        quota_used_today = CASE WHEN quota_used_today = 0 AND (mini_used_today + fast_used_today) > 0 THEN mini_used_today + fast_used_today ELSE quota_used_today END
    `).run();
  }

  private ensureApiRequestColumns() {
    this.addColumnIfMissing("api_requests", "source", "TEXT NOT NULL DEFAULT 'local'");
    this.addColumnIfMissing("api_requests", "aspect_ratio", "TEXT NOT NULL DEFAULT '16:9'");
    this.addColumnIfMissing("api_requests", "duration_seconds", "INTEGER NOT NULL DEFAULT 10");
    this.addColumnIfMissing("api_requests", "reference_image_path", "TEXT");
    this.addColumnIfMissing("api_requests", "remove_watermark", "INTEGER NOT NULL DEFAULT 1");
    this.addColumnIfMissing("api_requests", "callback_url", "TEXT");
    this.addColumnIfMissing("api_requests", "doubao_thread_url", "TEXT");
    this.addColumnIfMissing("api_requests", "raw_video_url", "TEXT");
    this.addColumnIfMissing("api_requests", "clean_video_url", "TEXT");
    this.addColumnIfMissing("api_requests", "output_video_path", "TEXT");
    this.addColumnIfMissing("api_requests", "quota_cost", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("api_requests", "quota_refunded", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("api_requests", "finished_at", "TEXT");
    this.addColumnIfMissing("api_requests", "error_json", "TEXT");
    this.addColumnIfMissing("api_requests", "quota_date", "TEXT");
    this.addColumnIfMissing("api_requests", "quota_reserved", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("api_requests", "generation_accepted_at", "TEXT");
    this.addColumnIfMissing("api_requests", "source_conversation_url", "TEXT");
    this.addColumnIfMissing("api_requests", "execution_phase", "TEXT NOT NULL DEFAULT 'paused'");
    this.addColumnIfMissing("api_requests", "requested_account_id", "INTEGER");
    this.addColumnIfMissing("api_requests", "assignment_revision", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("api_requests", "submission_sent_at", "TEXT");
  }

  private cleanInvalidSuccessfulResults() {
    this.db.prepare(`
      UPDATE api_requests
      SET
        status = 'failed',
        message = '历史结果不包含有效的去水印 MP4',
        raw_video_url = NULL,
        clean_video_url = NULL,
        output_video_path = NULL,
        updated_at = ?,
        finished_at = COALESCE(finished_at, ?)
      WHERE status = 'success'
        AND NOT (
          LOWER(COALESCE(clean_video_url, '')) LIKE '%.mp4%'
          OR LOWER(COALESCE(clean_video_url, '')) LIKE '%video_mp4%'
          OR LOWER(COALESCE(output_video_path, '')) LIKE '%.mp4'
        )
    `).run(now(), now());
  }

  private addColumnIfMissing(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
  }

  private nextAccountNumber(): number {
    const rows = this.db.prepare("SELECT partition FROM accounts").all() as Array<{ partition: string }>;
    const used = rows
      .map((row) => row.partition.match(/^persist:doubao_account_(\d+)$/)?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => Number(value));

    let current = 1;
    while (used.includes(current)) current += 1;
    return current;
  }
}

function clampInt(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function clampPort(value: number) {
  const port = clampInt(value);
  if (port < 1 || port > 65535) return DEFAULT_SETTINGS.apiPort;
  return port;
}

function stringifySettingValue(value: unknown) {
  return JSON.stringify(value);
}

function parseSettingValue(key: keyof AppSettings, value: string) {
  try {
    return JSON.parse(value) as AppSettings[typeof key];
  } catch {
    return value;
  }
}

function isSettingsKey(key: string): key is keyof AppSettings {
  return key in DEFAULT_SETTINGS;
}

function normalizeApiRequest(row: unknown): ApiRequest {
  const request = row as ApiRequest & {
    removeWatermark: number | boolean;
    quotaRefunded: number | boolean;
    errorJson: string | null;
  };
  let error = null;
  if (request.status === "failed") {
    try { error = request.errorJson ? JSON.parse(request.errorJson) : diagnoseRequest(request.message); }
    catch { error = diagnoseRequest(request.message); }
  }
  const { errorJson: _errorJson, ...values } = request;
  return {
    ...values,
    aspectRatio: request.aspectRatio === "9:16" || request.aspectRatio === "16:9" ? request.aspectRatio : "16:9",
    duration: Number(request.duration) >= 4 && Number(request.duration) <= 15 ? Number(request.duration) : 10,
    removeWatermark: Boolean(request.removeWatermark),
    quotaRefunded: Boolean(request.quotaRefunded),
    quotaReserved: Boolean(request.quotaReserved),
    error
  };
}

function normalizeOperationLog(row: unknown): OperationLog {
  const log = row as OperationLog & { accountId: number | null };
  return {
    ...log,
    requestId: log.requestId || null,
    accountId: log.accountId === null || log.accountId === undefined ? null : Number(log.accountId),
    accountName: log.accountName || null,
    accountPartition: log.accountPartition || null,
    status: log.status === "success" || log.status === "failed" ? log.status : "info",
    targetUrl: log.targetUrl || null
  };
}
