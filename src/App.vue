<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { Check, ChevronDown, ClipboardList, Copy, ExternalLink, History, Info, MoreHorizontal, Plus, RefreshCw, RotateCcw, Save, Search, Settings2, ShieldCheck, Square, Trash2, Users, X } from "@lucide/vue";
import { failureStageLabels, getRequestError, requestPhase } from "../electron/request-diagnostics";
import { quotaAmount, quotaRuns } from "../electron/quota-amount";
import type {
  Account,
  AccountRuntimeStatus,
  ApiRequest,
  ApiRequestStatus,
  ApiServerStatus,
  AppSettings,
  DoubaoModel,
  LoginStatus,
  OperationLog,
  OperationLogStatus,
  FailureStage,
  RequestStats,
  WatermarkStatus
} from "../electron/types";

type TabKey = "accounts" | "settings" | "logs" | "actions";

const accounts = ref<Account[]>([]);
const apiRequests = ref<ApiRequest[]>([]);
const todayGeneratedCount = ref(0);
const requestStats = ref<RequestStats>({ todaySuccess: 0, todayFailed: 0, running: 0, queued: 0 });
const watermarkStatus = ref<WatermarkStatus>({ configured: false, usage: null, checkedAt: null, usageUpdatedAt: null, error: null });
const savedSettings = ref<AppSettings | null>(null);
const savingSettings = ref(false);
const notice = ref("");
const recoveringIds = ref(new Set<string>());
const operationLogs = ref<OperationLog[]>([]);
const apiStatus = ref<ApiServerStatus>({
  version: "0.1.73",
  enabled: false,
  running: false,
  port: 0,
  url: null,
  message: "未启动"
});
const loading = ref(true);
const activeTab = ref<TabKey>("accounts");
const editingAccount = ref<Account | null>(null);
const selectedRequest = ref<ApiRequest | null>(null);
const accountSearch = ref("");
const accountStatusFilter = ref<"all" | "available" | "busy" | "exhausted" | "login_required">("all");
const openAccountMenuId = ref<number | null>(null);
const batchMenuOpen = ref(false);
const apiAddressCopied = ref(false);
const logSearch = ref("");
const logStatusFilter = ref<"all" | ApiRequestStatus>("all");
const logFailureFilter = ref<"all" | FailureStage | "quota_exhausted" | "token">("all");
const operationSearch = ref("");
const operationStatusFilter = ref<"all" | OperationLogStatus>("all");
const copiedField = ref<"prompt" | "result" | null>(null);

const accountSettingsForm = reactive({
  remark: "",
  dailyQuotaLimit: 10,
  quotaUsedToday: 0
});

const settingsForm = reactive<AppSettings>({
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
});

const settingsDirty = computed(() => Boolean(savedSettings.value && Object.keys(settingsForm).some((key) =>
  settingsForm[key as keyof AppSettings] !== savedSettings.value?.[key as keyof AppSettings]
)));
const selectedError = computed(() => selectedRequest.value ? getRequestError(selectedRequest.value) : null);
const selectedActions = computed(() => operationLogs.value.filter((item) => item.requestId === selectedRequest.value?.requestId).slice(0, 18).reverse());
const watermarkTone = computed(() => {
  if (watermarkStatus.value.error || watermarkStatus.value.usage?.remainingCount === 0) return "warning";
  return watermarkStatus.value.usage ? "success" : "neutral";
});
const watermarkSummary = computed(() => {
  const state = watermarkStatus.value;
  if (!state.configured) return "未配置 Token";
  if (state.error) return state.error.title;
  if (state.usage?.remainingCount === 0) return "次数已用完";
  return state.usage ? "已同步服务商用量" : "尚未同步";
});

const loginLabels: Record<LoginStatus, string> = {
  unknown: "未检测",
  logged_in: "已登录",
  logged_out: "未登录"
};

const runtimeLabels: Record<AccountRuntimeStatus, string> = {
  idle: "空闲",
  busy: "忙碌",
  error: "异常",
  login_required: "需登录"
};

const requestLabels: Record<ApiRequestStatus, string> = {
  accepted: "等待中",
  running: "执行中",
  success: "成功",
  failed: "失败",
  stopped: "已停止"
};

const modelLabels: Record<DoubaoModel, string> = {
  seedance_2_0_mini: "Seedance 2.0 Mini",
  seedance_2_0_fast: "Seedance 2.0 Fast"
};

const modalRemainingQuota = computed(() =>
  quotaAmount(Number(accountSettingsForm.dailyQuotaLimit || 0) - Number(accountSettingsForm.quotaUsedToday || 0))
);

const filteredApiRequests = computed(() => {
  const keyword = logSearch.value.trim().toLocaleLowerCase("zh-CN");

  return apiRequests.value.filter((item) => {
    if (logStatusFilter.value !== "all" && item.status !== logStatusFilter.value) return false;
    const error = getRequestError(item);
    if (logFailureFilter.value === "quota_exhausted" && error?.code !== "quota_exhausted") return false;
    if (logFailureFilter.value === "token" && !["token_invalid", "token_disabled", "token_missing", "access_denied"].includes(error?.code || "")) return false;
    if (!["all", "quota_exhausted", "token"].includes(logFailureFilter.value) && error?.stage !== logFailureFilter.value) return false;
    if (!keyword) return true;

    return [
      item.requestId,
      item.source,
      item.prompt,
      item.message,
      item.accountPartition,
      item.accountName,
      item.outputVideoPath,
      item.cleanVideoUrl
    ].some((value) => value?.toLocaleLowerCase("zh-CN").includes(keyword));
  });
});

const filteredOperationLogs = computed(() => {
  const keyword = operationSearch.value.trim().toLocaleLowerCase("zh-CN");
  return operationLogs.value.filter((item) => {
    if (operationStatusFilter.value !== "all" && item.status !== operationStatusFilter.value) return false;
    if (!keyword) return true;
    return [
      item.requestId,
      item.action,
      item.message,
      item.accountName,
      item.accountPartition,
      item.targetUrl
    ].some((value) => value?.toLocaleLowerCase("zh-CN").includes(keyword));
  });
});

const accountOverview = computed(() => ({
  total: accounts.value.length,
  loggedIn: accounts.value.filter((account) => account.loginStatus === "logged_in").length,
  available: accounts.value.filter(isAccountAvailable).length,
  exhausted: accounts.value.filter(isQuotaExhausted).length
}));

const accountQuotaSummary = computed(() => {
  const total = accounts.value.reduce((sum, account) => sum + account.dailyQuotaLimit, 0);
  const remaining = quotaAmount(accounts.value.reduce((sum, account) => sum + availableQuota(account), 0));
  const used = quotaAmount(total - remaining);

  return {
    total,
    remaining,
    used,
    usedPercent: total > 0 ? Math.min(100, (used / total) * 100) : 0,
    miniRuns: accounts.value.reduce(
      (sum, account) => sum + remainingGenerations(account, "seedance_2_0_mini"),
      0
    ),
    fastRuns: accounts.value.reduce(
      (sum, account) => sum + remainingGenerations(account, "seedance_2_0_fast"),
      0
    )
  };
});

const filteredAccounts = computed(() => {
  const keyword = accountSearch.value.trim().toLocaleLowerCase("zh-CN");

  return accounts.value.filter((account) => {
    const matchesFilter =
      accountStatusFilter.value === "all" ||
      (accountStatusFilter.value === "available" && isAccountAvailable(account)) ||
      (accountStatusFilter.value === "busy" && Boolean(accountTask(account))) ||
      (accountStatusFilter.value === "exhausted" && isQuotaExhausted(account)) ||
      (accountStatusFilter.value === "login_required" && isLoginRequired(account));
    if (!matchesFilter) return false;
    if (!keyword) return true;

    return [accountCode(account), account.remark, account.partition]
      .join(" ")
      .toLocaleLowerCase("zh-CN")
      .includes(keyword);
  });
});

const apiExample = computed(() => {
  const port = settingsForm.apiPort || 17888;
  const token = "<api-key>";
  return `# 共享额度：账号每日 ${settingsForm.dailyQuotaLimit}，Mini 每次扣 ${settingsForm.miniCost}，Fast 每次扣 ${settingsForm.fastCost}
curl -X POST http://127.0.0.1:${port}/api/generate \\
  -H "Authorization: Bearer ${token}" \\
  -F "model=seedance_2_0_mini" \\
  -F "prompt=生成一段女性科普动画" \\
  -F "duration=15" \\
  -F "referenceImage=@/Users/your-name/Pictures/ref.png" \\
  -F "removeWatermark=true" \\
  -F "callbackUrl=http://127.0.0.1:3000/doubao/callback"`;
});

const watermarkExample = computed(() => {
  const port = settingsForm.apiPort || 17888;
  const token = "<api-key>";
  return `curl -X POST http://127.0.0.1:${port}/api/watermark/parse \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://www.doubao.com/thread/xxx"}'`;
});

let removeDataChangedListener: (() => void) | null = null;
let refreshTimer: number | null = null;
let statusCheckTimer: number | null = null;
let refreshInFlight = false;
let statusCheckInFlight = false;

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const [accountRows, settings, status, requests, actions, generatedCount, stats, watermark] = await Promise.all([
    window.doubaoManager.accounts.list(),
    window.doubaoManager.settings.get(),
    window.doubaoManager.apiServer.status(),
    window.doubaoManager.apiRequests.list(100),
    window.doubaoManager.operationLogs.list(500),
    window.doubaoManager.apiRequests.todaySuccessCount(dayStart.toISOString(), dayEnd.toISOString()),
    window.doubaoManager.apiRequests.stats(dayStart.toISOString(), dayEnd.toISOString()),
    window.doubaoManager.watermark.status()
  ]);
  accounts.value = accountRows;
  apiRequests.value = requests;
  todayGeneratedCount.value = generatedCount;
  operationLogs.value = actions;
  apiStatus.value = status;
  requestStats.value = stats;
  watermarkStatus.value = watermark;
  if (selectedRequest.value) selectedRequest.value = requests.find((item) => item.requestId === selectedRequest.value?.requestId) || selectedRequest.value;
  const keepEdits = settingsDirty.value;
  savedSettings.value = settings;
  if (!keepEdits) Object.assign(settingsForm, settings);
  } finally {
    refreshInFlight = false;
  }
}

async function autoCheckAccountStatuses() {
  if (statusCheckInFlight) return;
  statusCheckInFlight = true;
  try {
    await window.doubaoManager.accounts.detectAll();
    await refresh();
  } finally {
    statusCheckInFlight = false;
  }
}

async function addAccountAndOpen() {
  const account = await window.doubaoManager.accounts.create();
  await window.doubaoManager.accounts.open(account.id);
  await refresh();
}

async function openAccount(account: Account) {
  await window.doubaoManager.accounts.open(account.id);
  await refresh();
}

async function detectAccount(account: Account) {
  await window.doubaoManager.accounts.detectLogin(account.id);
  await refresh();
}

async function detectAll() {
  await window.doubaoManager.accounts.detectAll();
  await refresh();
}

async function relogin(account: Account) {
  if (!window.confirm(`清空 ${account.partition} 的登录状态并重新打开豆包？`)) return;
  await window.doubaoManager.accounts.relogin(account.id);
  await refresh();
}

async function deleteAccount(account: Account) {
  if (!window.confirm(`删除 ${account.partition} 并清空对应浏览器数据？`)) return;
  await window.doubaoManager.accounts.delete(account.id);
  await refresh();
}

async function resetQuota(account: Account) {
  try {
  await window.doubaoManager.accounts.resetQuota(account.id);
  await refresh();
  } catch (error) { notice.value = error instanceof Error ? error.message : "无法重置额度"; }
}

async function resetAllQuotas() {
  if (!window.confirm("重置所有账号今日额度？")) return;
  try {
  await window.doubaoManager.accounts.resetAllQuotas();
  await refresh();
  } catch (error) { notice.value = error instanceof Error ? error.message : "无法重置额度"; }
}

function openAccountSettings(account: Account) {
  editingAccount.value = account;
  accountSettingsForm.remark = account.remark;
  accountSettingsForm.dailyQuotaLimit = account.dailyQuotaLimit;
  accountSettingsForm.quotaUsedToday = account.quotaUsedToday;
}

function closeAccountSettings() {
  editingAccount.value = null;
}

async function saveAccountSettings() {
  if (!editingAccount.value) return;
  const total = Math.max(0, Math.floor(Number(accountSettingsForm.dailyQuotaLimit) || 0));
  const used = Math.min(total, quotaAmount(Number(accountSettingsForm.quotaUsedToday) || 0));
  await window.doubaoManager.accounts.update({
    id: editingAccount.value.id,
    remark: accountSettingsForm.remark.trim(),
    dailyQuotaLimit: total,
    quotaRemaining: quotaAmount(total - used),
    quotaUsedToday: used
  });
  closeAccountSettings();
  await refresh();
}

async function saveSettings() {
  savingSettings.value = true;
  try {
  const saved = await window.doubaoManager.settings.update({
    ...settingsForm,
    apiPort: Number(settingsForm.apiPort),
    dailyQuotaLimit: Number(settingsForm.dailyQuotaLimit),
    miniCost: Number(settingsForm.miniCost),
    fastCost: Number(settingsForm.fastCost),
    generationTimeoutSeconds: Number(settingsForm.generationTimeoutSeconds),
    maxConcurrentAccounts: Number(settingsForm.maxConcurrentAccounts),
    maxConcurrentTasksPerAccount: Number(settingsForm.maxConcurrentTasksPerAccount),
    retryCount: Number(settingsForm.retryCount)
  });
  Object.assign(settingsForm, saved);
  savedSettings.value = saved;
  notice.value = "配置已保存";
  await refresh();
  } catch (error) {
    notice.value = error instanceof Error ? error.message : "配置保存失败";
  } finally { savingSettings.value = false; }
}

function discardSettingsEdits() {
  if (savedSettings.value) Object.assign(settingsForm, savedSettings.value);
}

function accountTask(account: Account) {
  return apiRequests.value.find((item) => item.accountId === account.id && (item.status === "running" || item.status === "accepted"));
}

function canRecoverRequest(item: ApiRequest) {
  return (item.status === "failed" || item.status === "accepted" && item.executionPhase === "paused") && Boolean(item.accountId);
}

function nextResetLabel() {
  const value = accounts.value[0]?.nextQuotaResetAt;
  return value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "00:00";
}

async function recoverRequest(item: ApiRequest) {
  if (recoveringIds.value.has(item.requestId)) return;
  recoveringIds.value.add(item.requestId);
  try {
    await window.doubaoManager.apiRequests.recover(item.requestId);
    notice.value = "已进入结果恢复队列";
    await refresh();
  } catch (error) {
    notice.value = error instanceof Error ? error.message : "恢复结果失败";
  } finally { recoveringIds.value.delete(item.requestId); }
}

async function restartApiServer() {
  apiStatus.value = await window.doubaoManager.apiServer.restart();
}

async function clearLogs() {
  if (!window.confirm("清空接口日志？")) return;
  await window.doubaoManager.apiRequests.clear();
  await refresh();
}

function canStopRequest(item: ApiRequest) {
  return item.status === "accepted" || item.status === "running";
}

async function stopRequest(item: ApiRequest) {
  const warning = "终止任务并退回本地预扣额度？\n\n任务会立即退出本地队列并释放账号。如果已经提交到豆包，豆包平台上的生成无法撤回。";
  if (!window.confirm(warning)) return;
  await window.doubaoManager.apiRequests.stop(item.requestId);
  if (selectedRequest.value?.requestId === item.requestId) closeRequestDetails();
  await refresh();
}

async function clearOperationLogs() {
  if (!window.confirm("清空全部行动日志？三天前的日志会自动清理。")) return;
  await window.doubaoManager.operationLogs.clear();
  await refresh();
}

function formatTime(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatRelativeTime(value: string | null) {
  if (!value) return "从未使用";
  const date = new Date(value);
  const now = new Date();
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) return `今天 ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

function fullTime(value: string | null) {
  if (!value) return "从未使用";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function promptPreview(value: string) {
  return value.replace(/\s+/g, " ").trim() || "-";
}

function resultValue(item: ApiRequest) {
  return item.outputVideoPath || item.cleanVideoUrl || "-";
}

function resultLabel(item: ApiRequest) {
  if (item.outputVideoPath) return "本地 MP4";
  if (item.cleanVideoUrl) return "视频已就绪";
  if (item.status === "success") return "结果缺失";
  return "暂无结果";
}

function sourceLabel(value: string) {
  if (value === "infinite-canvas") return "无限画布";
  if (value === "system-test") return "系统测试";
  if (value === "local") return "本机";
  return value || "未知来源";
}

function requestAccountLabel(item: ApiRequest) {
  const suffix = item.accountPartition?.match(/doubao_account_(\d+)$/)?.[1];
  if (suffix) return `账号 ${suffix}`;
  return item.accountName || item.accountPartition || "等待分配";
}

function openRequestDetails(item: ApiRequest) {
  selectedRequest.value = item;
  copiedField.value = null;
}

function closeRequestDetails() {
  selectedRequest.value = null;
  copiedField.value = null;
}

async function copyRequestValue(field: "prompt" | "result", value: string) {
  if (!value || value === "-") return;
  await navigator.clipboard.writeText(value);
  copiedField.value = field;
  window.setTimeout(() => {
    if (copiedField.value === field) copiedField.value = null;
  }, 1500);
}

async function copyOperationUrl(value: string) {
  if (!value) return;
  await navigator.clipboard.writeText(value);
}

function accountCode(account: Account) {
  const suffix = account.partition.match(/doubao_account_(\d+)$/)?.[1] || String(account.id).padStart(3, "0");
  return `账号 ${suffix}`;
}

function minimumQuotaCost() {
  return Math.min(Number(settingsForm.miniCost) || 2, Number(settingsForm.fastCost) || 3);
}

function isQuotaExhausted(account: Account) {
  return account.dailyQuotaExhausted || availableQuota(account) < minimumQuotaCost();
}

function availableQuota(account: Account) {
  return account.dailyQuotaExhausted ? 0 : account.availableQuota ?? account.quotaRemaining;
}

function isLoginRequired(account: Account) {
  return account.loginStatus === "logged_out" || account.currentStatus === "login_required";
}

function isAccountAvailable(account: Account) {
  return account.loginStatus === "logged_in" && !isLoginRequired(account) && (account.runningTaskCount || 0) < (account.maxConcurrentTasks || 3) && !isQuotaExhausted(account);
}

function accountStatusLabel(account: Account) {
  if (isLoginRequired(account)) return "登录失效";
  if (account.dailyQuotaExhausted) return "今日次数已用完";
  if (account.currentStatus === "error") return "启动失败";
  const task = accountTask(account);
  if (task) return requestPhase(task);
  if (account.currentStatus === "busy") return "执行中";
  if (isQuotaExhausted(account)) return "额度耗尽";
  return runtimeLabels[account.currentStatus];
}

function accountStatusTone(account: Account) {
  if (isLoginRequired(account) || account.currentStatus === "error") return "danger";
  if (account.currentStatus === "busy" || isQuotaExhausted(account)) return "warning";
  if (account.currentStatus === "idle" && account.loginStatus === "logged_in") return "success";
  return "neutral";
}

function quotaUsedPercent(account: Account) {
  if (account.dailyQuotaLimit <= 0) return 100;
  return Math.min(100, Math.max(0, (account.quotaUsedToday / account.dailyQuotaLimit) * 100));
}

function remainingGenerations(account: Account, model: DoubaoModel) {
  const settings = savedSettings.value || settingsForm;
  const cost = model === "seedance_2_0_mini" ? Number(settings.miniCost) : Number(settings.fastCost);
  return quotaRuns(availableQuota(account), cost || 1);
}

function toggleAccountMenu(accountId: number) {
  openAccountMenuId.value = openAccountMenuId.value === accountId ? null : accountId;
  batchMenuOpen.value = false;
}

function toggleBatchMenu() {
  batchMenuOpen.value = !batchMenuOpen.value;
  openAccountMenuId.value = null;
}

function closeMenus() {
  openAccountMenuId.value = null;
  batchMenuOpen.value = false;
}

function apiDisplayAddress() {
  return apiStatus.value.url?.replace(/^https?:\/\//, "") || apiStatus.value.message;
}

async function copyApiAddress() {
  if (!apiStatus.value.url) return;
  await navigator.clipboard.writeText(apiStatus.value.url);
  apiAddressCopied.value = true;
  window.setTimeout(() => {
    apiAddressCopied.value = false;
  }, 1500);
}

onMounted(async () => {
  window.addEventListener("click", closeMenus);
  removeDataChangedListener = window.doubaoManager.events.onDataChanged(() => {
    void refresh();
  });
  try {
    await refresh();
    await autoCheckAccountStatuses();
  } catch (error) {
    console.error("初始化账号状态检查失败", error);
  } finally {
    loading.value = false;
  }
  refreshTimer = window.setInterval(() => {
    void refresh().catch((error) => console.error("自动刷新接口状态失败", error));
  }, 3000);
  statusCheckTimer = window.setInterval(() => {
    void autoCheckAccountStatuses().catch((error) => console.error("自动检测账号状态失败", error));
  }, 30000);
});

onBeforeUnmount(() => {
  window.removeEventListener("click", closeMenus);
  removeDataChangedListener?.();
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  if (statusCheckTimer !== null) window.clearInterval(statusCheckTimer);
});
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-symbol"><Users :size="20" /></span>
        <h1>豆包账号池</h1>
        <span class="app-version">v{{ apiStatus.version }}</span>
      </div>
      <div class="api-status-compact" :class="{ running: apiStatus.running, error: !apiStatus.running }">
        <span class="status-dot" aria-hidden="true"></span>
        <strong>{{ apiStatus.running ? "API 正常" : "API 异常" }}</strong>
        <span>{{ apiDisplayAddress() }}</span>
        <button v-if="apiStatus.url" class="tool-button" type="button" :title="apiAddressCopied ? '已复制' : '复制 API 地址'" aria-label="复制 API 地址" @click="copyApiAddress">
          <Check v-if="apiAddressCopied" :size="15" /><Copy v-else :size="15" />
        </button>
      </div>
    </header>

    <nav class="tabs">
      <button :class="{ active: activeTab === 'accounts' }" @click="activeTab = 'accounts'"><Users :size="16" />账号池</button>
      <button :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'"><Settings2 :size="16" />配置管理<span v-if="settingsDirty" class="unsaved-dot"></span></button>
      <button :class="{ active: activeTab === 'logs' }" @click="activeTab = 'logs'"><ClipboardList :size="16" />接口日志<span v-if="requestStats.running" class="tab-count">{{ requestStats.running }}</span></button>
      <button :class="{ active: activeTab === 'actions' }" @click="activeTab = 'actions'"><History :size="16" />行动日志</button>
    </nav>

    <div v-if="notice" class="notice" role="status"><span>{{ notice }}</span><button class="tool-button" title="关闭提示" aria-label="关闭提示" @click="notice = ''"><X :size="15" /></button></div>

    <section v-if="loading" class="empty">加载中...</section>

    <section v-else-if="activeTab === 'accounts'" class="panel">
      <div class="section-title">
        <div>
          <h2>账号管理</h2>
          <p>{{ accountOverview.total }} 个账号 · {{ accountOverview.loggedIn }} 个已登录 · {{ accountOverview.available }} 个可用</p>
        </div>
        <div class="activity-summary"><span>执行中 <strong>{{ requestStats.running }}</strong></span><span>今日完成 <strong class="text-success">{{ todayGeneratedCount }}</strong></span><span>今日失败 <strong>{{ requestStats.todayFailed }}</strong></span></div>
      </div>

      <div class="service-balances" aria-label="生成额度与去水印次数">
        <div class="balance-row">
          <span class="balance-label"><Users :size="15" />豆包今日额度<Info :size="13" title="本地调度额度，执行中的任务已预扣；不是豆包官方余额" /></span>
          <strong class="balance-value">{{ accountQuotaSummary.remaining }}<span>/ {{ accountQuotaSummary.total }} 点剩余</span></strong>
          <div class="balance-meter"><div class="quota-scale"><span>0</span><span>已用／不可用 {{ accountQuotaSummary.used }}</span><span>{{ accountQuotaSummary.total }}</span></div><div class="balance-track" role="progressbar" aria-label="账号池已用或不可用额度" :aria-valuenow="accountQuotaSummary.used" :aria-valuemax="accountQuotaSummary.total" aria-valuemin="0"><span :style="{ width: `${accountQuotaSummary.usedPercent}%` }"></span></div></div>
          <span class="capacity">Mini <strong>{{ accountQuotaSummary.miniRuns }}</strong> 次<span class="divider">/</span>Fast <strong>{{ accountQuotaSummary.fastRuns }}</strong> 次</span>
          <span class="balance-meta" title="北京时间每天 00:00 自动重置；唤醒和重启时补检查">下次 {{ nextResetLabel() }}<span class="quota-reset-zone">北京时间 · 自动重置</span></span>
        </div>
        <div class="balance-row" :class="`balance-${watermarkTone}`">
          <span class="balance-label"><ShieldCheck :size="15" />去水印次数<Info :size="13" title="仅显示服务商解析响应返回的用量，不用本地生成数量推算余额" /></span>
          <strong class="balance-value">{{ watermarkStatus.usage?.remainingCount ?? '—' }}<span>次剩余</span></strong>
          <span class="balance-meta watermark-usage">已用 {{ watermarkStatus.usage?.usedCount ?? '—' }} / 总计 {{ watermarkStatus.usage?.totalLimit ?? '—' }}</span>
          <span class="balance-state"><span class="status-dot"></span>{{ watermarkSummary }}</span>
          <span class="balance-meta" :title="fullTime(watermarkStatus.usageUpdatedAt)">{{ watermarkStatus.usageUpdatedAt ? `${formatTime(watermarkStatus.usageUpdatedAt)} 同步` : '下次解析时同步' }}</span>
          <button class="tool-button" title="刷新本地状态" aria-label="刷新额度状态" @click="refresh"><RefreshCw :size="14" /></button>
        </div>
      </div>

      <div v-if="watermarkStatus.error || watermarkStatus.usage?.remainingCount === 0" class="service-alert">
        <span>{{ watermarkStatus.error?.suggestion || '去水印次数已用完，补充次数后可恢复已有视频结果。' }}</span>
        <button class="text-button" @click="activeTab = 'settings'">查看配置 <ExternalLink :size="13" /></button>
      </div>

      <div class="account-toolbar">
        <div class="account-filters">
          <label>
            <span>搜索账号</span>
            <div class="search-input"><Search :size="15" /><input v-model="accountSearch" type="search" placeholder="搜索账号或备注" /></div>
          </label>
          <label>
            <span>状态筛选</span>
            <select v-model="accountStatusFilter">
              <option value="all">全部账号</option>
              <option value="available">可用账号</option>
              <option value="busy">执行中</option>
              <option value="exhausted">额度耗尽</option>
              <option value="login_required">登录失效</option>
            </select>
          </label>
        </div>
        <div class="toolbar">
          <div class="action-menu batch-menu">
            <button class="button" type="button" @click.stop="toggleBatchMenu">批量操作<ChevronDown :size="14" /></button>
            <div v-if="batchMenuOpen" class="action-menu-popover" @click.stop>
              <button type="button" @click="batchMenuOpen = false; detectAll()">检测全部账号</button>
              <button type="button" @click="batchMenuOpen = false; refresh()">刷新账号状态</button>
              <span class="menu-separator"></span>
              <button class="warning-text" type="button" @click="batchMenuOpen = false; resetAllQuotas()">重置全部今日额度</button>
            </div>
          </div>
          <button class="button primary" @click="addAccountAndOpen"><Plus :size="16" />添加账号</button>
        </div>
      </div>

      <div class="table-wrap accounts-table-wrap">
        <table class="accounts-table">
          <colgroup>
            <col class="account-col-info" />
            <col class="account-col-status" />
            <col class="account-col-quota" />
            <col class="account-col-time" />
            <col class="account-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>账号信息</th>
              <th>运行状态</th>
              <th>今日额度</th>
              <th>最后使用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="account in filteredAccounts" :key="account.id" :class="{ 'quota-exhausted-row': isQuotaExhausted(account) }">
              <td class="account-info-cell">
                <div class="account-name-line">
                  <strong>{{ accountCode(account) }}</strong>
                  <button class="tool-button partition-info" type="button" :title="account.partition" aria-label="查看账号隔离分区"><Info :size="14" /></button>
                </div>
                <span class="account-remark">{{ account.remark || "未添加备注" }}</span>
              </td>
              <td>
                <div class="account-runtime" :class="`tone-${accountStatusTone(account)}`">
                  <span class="status-dot" aria-hidden="true"></span>
                  <strong>{{ accountStatusLabel(account) }}</strong>
                </div>
                <span class="account-task-count">执行 {{ account.runningTaskCount ?? (accountTask(account)?.status === 'running' ? 1 : 0) }}/{{ account.maxConcurrentTasks || savedSettings?.maxConcurrentTasksPerAccount || 3 }}<span>排队 {{ account.queuedTaskCount ?? (accountTask(account)?.status === 'accepted' ? 1 : 0) }}</span></span>
                <span v-if="accountTask(account)" class="account-task-detail" :title="accountTask(account)?.message">{{ accountTask(account)?.message }}</span>
                <span v-else class="account-login-state">{{ loginLabels[account.loginStatus] }}</span>
              </td>
              <td class="quota-cell">
                <div v-if="account.dailyQuotaExhausted" class="quota-heading" :title="account.quotaExhaustedReason || ''">
                  <strong>今日免费次数已用完</strong><span>豆包已确认</span>
                </div>
                <div v-else class="quota-heading">
                  <strong>已用 {{ account.quotaUsedToday }}<span class="quota-total"> / {{ account.dailyQuotaLimit }} 点</span></strong>
                  <span>{{ isQuotaExhausted(account) ? "今日额度已耗尽" : `剩余 ${account.quotaRemaining}` }}</span>
                </div>
                <div class="quota-progress" :class="{ exhausted: isQuotaExhausted(account) }" role="progressbar" :aria-label="account.dailyQuotaExhausted ? '豆包今日免费次数已用完' : '账号已用额度'" :aria-valuenow="account.dailyQuotaExhausted ? account.dailyQuotaLimit : account.quotaUsedToday" aria-valuemin="0" :aria-valuemax="account.dailyQuotaLimit">
                  <span :style="{ width: `${account.dailyQuotaExhausted ? 100 : quotaUsedPercent(account)}%` }"></span>
                </div>
                <div class="quota-scale"><span>0</span><span>{{ account.dailyQuotaLimit }}</span></div>
                <div class="quota-models">
                  <span>Mini {{ remainingGenerations(account, 'seedance_2_0_mini') }} 次</span>
                  <span>Fast {{ remainingGenerations(account, 'seedance_2_0_fast') }} 次</span>
                </div>
              </td>
              <td class="last-used-cell" :title="fullTime(account.lastUsedAt)">{{ formatRelativeTime(account.lastUsedAt) }}</td>
              <td class="account-actions-cell">
                <div class="row-actions account-actions">
                  <button class="button primary compact-button" @click="openAccount(account)">打开豆包</button>
                  <button class="tool-button" title="检测账号状态" aria-label="检测账号状态" @click="detectAccount(account)"><RefreshCw :size="15" /></button>
                  <div class="action-menu">
                    <button class="tool-button" type="button" title="更多账号操作" aria-label="更多账号操作" @click.stop="toggleAccountMenu(account.id)"><MoreHorizontal :size="18" /></button>
                    <div v-if="openAccountMenuId === account.id" class="action-menu-popover account-menu-popover" @click.stop>
                      <button type="button" @click="openAccountMenuId = null; openAccountSettings(account)">账号设置</button>
                      <button type="button" @click="openAccountMenuId = null; resetQuota(account)">重置今日额度</button>
                      <button type="button" @click="openAccountMenuId = null; relogin(account)">清空登录状态</button>
                      <span class="menu-separator"></span>
                      <button class="danger-text" type="button" @click="openAccountMenuId = null; deleteAccount(account)">删除账号</button>
                    </div>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!accounts.length" class="empty compact">还没有账号。点击“添加账号”开始。</div>
        <div v-else-if="!filteredAccounts.length" class="empty compact">没有符合当前条件的账号。</div>
      </div>
    </section>

    <section v-else-if="activeTab === 'settings'" class="settings-grid">
      <form class="panel settings-form" @submit.prevent="saveSettings">
        <div class="section-title">
          <div>
            <h2>配置管理</h2>
            <p>{{ settingsDirty ? '有未保存的修改' : '配置已保存' }}</p>
          </div>
          <div class="toolbar">
            <button v-if="settingsDirty" class="button" type="button" @click="discardSettingsEdits">撤销修改</button>
            <button class="button primary" type="submit" :disabled="savingSettings || !settingsDirty"><Save :size="15" />{{ savingSettings ? '保存中' : '保存配置' }}</button>
            <button class="tool-button" title="重启本地 API 服务" aria-label="重启 API" type="button" @click="restartApiServer"><RefreshCw :size="16" /></button>
          </div>
        </div>

        <div class="form-section">
          <h3>本地 API</h3>
          <label class="checkbox-line">
            <input v-model="settingsForm.apiServiceEnabled" type="checkbox" />
            开启本地 API 服务
          </label>
          <label>
            <span>端口</span>
            <input v-model.number="settingsForm.apiPort" type="number" min="1" max="65535" />
          </label>
          <label>
            <span>API Key</span>
            <input v-model="settingsForm.apiKey" type="password" autocomplete="off" placeholder="Authorization: Bearer ..." />
          </label>
        </div>

        <div class="form-section">
          <h3>豆包本地额度</h3>
          <label>
            <span>默认模型</span>
            <select v-model="settingsForm.defaultModel">
              <option value="seedance_2_0_mini">{{ modelLabels.seedance_2_0_mini }}</option>
              <option value="seedance_2_0_fast">{{ modelLabels.seedance_2_0_fast }}</option>
            </select>
          </label>
          <label>
            <span>每日总额度</span>
            <input v-model.number="settingsForm.dailyQuotaLimit" type="number" min="0" />
          </label>
          <label>
            <span>Mini 单次消耗</span>
            <input v-model.number="settingsForm.miniCost" type="number" min="1" step="0.1" />
          </label>
          <label>
            <span>Fast 单次消耗</span>
            <input v-model.number="settingsForm.fastCost" type="number" min="1" step="0.1" />
          </label>
          <label>
            <span>每日重置时间（北京时间）</span>
            <input value="00:00 自动重置" readonly />
          </label>
        </div>

        <div class="form-section">
          <h3>执行策略</h3>
          <label class="checkbox-line">
            <input v-model="settingsForm.executorEnabled" type="checkbox" />
            后台自动执行接口请求
          </label>
          <label class="checkbox-line">
            <input v-model="settingsForm.showExecutorWindow" type="checkbox" />
            调试时显示豆包执行窗口
          </label>
          <label class="checkbox-line">
            <input v-model="settingsForm.autoCloseExecutorWindow" type="checkbox" />
            完成后自动关闭执行窗口
          </label>
          <label>
            <span>豆包入口地址</span>
            <input v-model="settingsForm.doubaoChatUrl" />
          </label>
          <label>
            <span>生成超时秒数</span>
            <input v-model.number="settingsForm.generationTimeoutSeconds" type="number" min="60" />
          </label>
          <label>
            <span>总任务并发上限</span>
            <input v-model.number="settingsForm.maxConcurrentAccounts" type="number" min="1" />
          </label>
          <label>
            <span>单账号并发上限</span>
            <input v-model.number="settingsForm.maxConcurrentTasksPerAccount" type="number" min="1" max="5" />
          </label>
          <label>
            <span>失败重试次数</span>
            <input v-model.number="settingsForm.retryCount" type="number" min="0" />
          </label>
        </div>

        <div class="form-section wide">
          <h3>去水印服务</h3>
          <div class="settings-usage" :class="`balance-${watermarkTone}`">
            <span>{{ watermarkSummary }}</span>
            <strong>剩余 {{ watermarkStatus.usage?.remainingCount ?? '—' }} 次</strong>
            <span>已用 {{ watermarkStatus.usage?.usedCount ?? '—' }} / 总计 {{ watermarkStatus.usage?.totalLimit ?? '—' }}</span>
            <small>{{ watermarkStatus.usageUpdatedAt ? `${fullTime(watermarkStatus.usageUpdatedAt)} 同步` : '尚未收到服务商用量数据' }}</small>
          </div>
          <p v-if="watermarkStatus.error" class="form-hint text-warning">{{ watermarkStatus.error.detail }} · {{ watermarkStatus.error.suggestion }}</p>
          <label class="checkbox-line">
            <input v-model="settingsForm.autoRemoveWatermark" type="checkbox" />
            默认自动去水印
          </label>
          <label>
            <span>接口地址</span>
            <input v-model="settingsForm.watermarkApiUrl" />
          </label>
          <label>
            <span>接口 Token</span>
            <input v-model="settingsForm.watermarkApiToken" type="password" placeholder="nologo API Token" />
          </label>
          <label>
            <span>输出目录</span>
            <input v-model="settingsForm.outputDir" placeholder="/Users/your-name/Movies/doubao-output" />
          </label>
        </div>
      </form>

      <aside class="api-examples">
        <details><summary>接口调用示例<ChevronDown :size="15" /></summary>
        <h3>生成请求</h3>
        <pre>{{ apiExample }}</pre>
        <h3>单独去水印</h3>
        <pre>{{ watermarkExample }}</pre>
        </details>
      </aside>
    </section>

    <section v-else-if="activeTab === 'logs'" class="panel logs-panel">
      <div class="section-title">
        <div>
          <h2>接口日志</h2>
          <p>今日完成 {{ todayGeneratedCount }} · 执行中 {{ requestStats.running }} · 待处理 {{ requestStats.queued }}</p>
        </div>
        <div class="toolbar">
          <button class="tool-button" title="刷新接口日志" aria-label="刷新接口日志" @click="refresh"><RefreshCw :size="16" /></button>
          <button class="tool-button danger" title="清空接口日志" aria-label="清空接口日志" @click="clearLogs"><Trash2 :size="16" /></button>
        </div>
      </div>

      <div class="log-filters">
        <label class="log-search">
          <span>搜索日志</span>
          <input v-model="logSearch" type="search" placeholder="请求 ID、提示词、账号或执行信息" />
        </label>
        <label class="log-status-filter">
          <span>状态</span>
          <select v-model="logStatusFilter">
            <option value="all">全部状态</option>
            <option value="accepted">等待中</option>
            <option value="running">执行中</option>
            <option value="success">成功</option>
            <option value="failed">失败</option>
            <option value="stopped">已停止</option>
          </select>
        </label>
        <label class="log-failure-filter"><span>问题分类</span><select v-model="logFailureFilter">
          <option value="all">全部问题</option><option value="quota_exhausted">去水印次数耗尽</option><option value="token">去水印认证问题</option>
          <option value="watermark">所有去水印问题</option><option value="sharing">复制分享</option><option value="submission">生成确认</option><option value="generation">豆包生成</option><option value="account">账号与额度</option><option value="output">文件保存</option>
        </select></label>
        <span class="log-count">显示 {{ filteredApiRequests.length }} / {{ apiRequests.length }} 条</span>
      </div>

      <div class="table-wrap logs-table-wrap">
        <table class="logs-table">
          <colgroup>
            <col class="log-col-request" />
            <col class="log-col-account" />
            <col class="log-col-status" />
            <col class="log-col-message" />
            <col class="log-col-prompt" />
            <col class="log-col-result" />
          </colgroup>
          <thead>
            <tr>
              <th>请求</th>
              <th>模型 / 账号</th>
              <th>状态</th>
              <th>当前进度 / 原因</th>
              <th>提示词</th>
              <th>结果 / 操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in filteredApiRequests" :key="item.id">
              <td class="log-request-cell">
                <code class="request-id">{{ item.requestId }}</code>
                <span class="cell-meta">{{ sourceLabel(item.source) }} · {{ formatTime(item.createdAt) }}</span>
              </td>
              <td>
                <strong class="model-name">{{ modelLabels[item.model] }}</strong>
                <span class="cell-meta">{{ requestAccountLabel(item) }} · {{ item.aspectRatio }}</span>
              </td>
              <td>
                <span class="pill" :class="`request-${item.status}`">
                  {{ requestLabels[item.status] }}
                </span>
              </td>
              <td><strong class="phase-label" :class="{ 'text-warning': item.status === 'failed' }">{{ requestPhase(item) }}</strong><p class="message-preview" :title="item.message">{{ getRequestError(item)?.suggestion || item.message || "-" }}</p></td>
              <td><button type="button" class="prompt-preview" title="查看完整提示词" @click="openRequestDetails(item)">{{ promptPreview(item.prompt) }}</button></td>
              <td>
                <span class="result-indicator" :class="{ ready: resultValue(item) !== '-' }">
                  {{ resultLabel(item) }}
                </span>
                <div class="result-actions">
                  <button v-if="canStopRequest(item)" class="tool-button danger" type="button" title="终止并退还本地额度" aria-label="终止并退还" @click="stopRequest(item)"><Square :size="13" /></button>
                  <button v-if="canRecoverRequest(item)" class="tool-button" type="button" :disabled="recoveringIds.has(item.requestId)" title="恢复已有视频结果，不重新生成" aria-label="恢复结果" @click="recoverRequest(item)"><RotateCcw :size="15" /></button>
                  <button class="text-button" type="button" @click="openRequestDetails(item)">详情</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!apiRequests.length" class="empty compact">还没有接口请求。</div>
        <div v-else-if="!filteredApiRequests.length" class="empty compact">没有符合当前条件的日志。</div>
      </div>
    </section>

    <section v-else class="panel logs-panel operation-logs-panel">
      <div class="section-title">
        <div>
          <h2>行动日志</h2>
          <p>最近 3 天 · {{ operationLogs.length }} 条记录</p>
        </div>
        <div class="toolbar">
          <button class="tool-button" title="刷新行动日志" aria-label="刷新行动日志" @click="refresh"><RefreshCw :size="16" /></button>
          <button class="tool-button danger" title="清空行动日志" aria-label="清空行动日志" @click="clearOperationLogs"><Trash2 :size="16" /></button>
        </div>
      </div>

      <div class="log-filters">
        <label class="log-search">
          <span>搜索行动</span>
          <input v-model="operationSearch" type="search" placeholder="任务 ID、动作、账号、地址或错误信息" />
        </label>
        <label class="log-status-filter">
          <span>结果</span>
          <select v-model="operationStatusFilter">
            <option value="all">全部</option>
            <option value="info">进行中</option>
            <option value="success">成功</option>
            <option value="failed">失败</option>
          </select>
        </label>
        <span class="log-count">显示 {{ filteredOperationLogs.length }} / {{ operationLogs.length }} 条</span>
      </div>

      <div class="table-wrap logs-table-wrap">
        <table class="logs-table operation-logs-table">
          <colgroup>
            <col class="operation-col-time" />
            <col class="operation-col-account" />
            <col class="operation-col-request" />
            <col class="operation-col-action" />
            <col class="operation-col-message" />
            <col class="operation-col-url" />
          </colgroup>
          <thead>
            <tr>
              <th>时间</th>
              <th>账号</th>
              <th>任务 ID</th>
              <th>动作</th>
              <th>详细记录</th>
              <th>地址</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in filteredOperationLogs" :key="item.id">
              <td class="cell-meta" :title="fullTime(item.createdAt)">{{ formatTime(item.createdAt) }}</td>
              <td>
                <strong>{{ item.accountName || "系统" }}</strong>
                <span v-if="item.accountPartition" class="cell-meta">{{ item.accountPartition }}</span>
              </td>
              <td><code class="request-id">{{ item.requestId || "-" }}</code></td>
              <td><span class="operation-action">{{ item.action }}</span></td>
              <td><p class="message-preview">{{ item.message || "-" }}</p></td>
              <td>
                <div v-if="item.targetUrl" class="operation-url-cell">
                  <a :href="item.targetUrl" target="_blank" rel="noreferrer">{{ item.targetUrl }}</a>
                  <button class="tool-button" type="button" title="复制记录地址" aria-label="复制记录地址" @click="copyOperationUrl(item.targetUrl)"><Copy :size="14" /></button>
                </div>
                <span v-else class="cell-meta">-</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!operationLogs.length" class="empty compact">还没有行动日志。</div>
        <div v-else-if="!filteredOperationLogs.length" class="empty compact">没有符合条件的行动日志。</div>
      </div>
    </section>

    <div v-if="selectedRequest" class="modal-backdrop request-detail-backdrop" @click.self="closeRequestDetails">
      <section class="modal request-detail-modal" role="dialog" aria-modal="true" aria-labelledby="request-detail-title">
        <div class="modal-header">
          <div>
            <h2 id="request-detail-title">请求详情</h2>
            <p>{{ selectedRequest.requestId }}</p>
          </div>
          <div class="request-detail-actions">
            <button v-if="canRecoverRequest(selectedRequest)" class="button" type="button" :disabled="recoveringIds.has(selectedRequest.requestId)" @click="recoverRequest(selectedRequest)"><RotateCcw :size="15" />恢复结果</button>
            <button
              v-if="canStopRequest(selectedRequest)"
              class="button danger"
              type="button"
              @click="stopRequest(selectedRequest)"
            >
              终止并退还积分
            </button>
            <button class="tool-button" type="button" title="关闭详情" aria-label="关闭详情" @click="closeRequestDetails"><X :size="18" /></button>
          </div>
        </div>

        <dl class="request-detail-grid">
          <div>
            <dt>状态</dt>
            <dd><span class="pill" :class="`request-${selectedRequest.status}`">{{ requestLabels[selectedRequest.status] }}</span></dd>
          </div>
          <div>
            <dt>来源</dt>
            <dd>{{ sourceLabel(selectedRequest.source) }}</dd>
          </div>
          <div>
            <dt>模型</dt>
            <dd>{{ modelLabels[selectedRequest.model] }}</dd>
          </div>
          <div>
            <dt>时长</dt>
            <dd>{{ selectedRequest.duration ? `${selectedRequest.duration} 秒` : "未指定" }}</dd>
          </div>
          <div>
            <dt>账号</dt>
            <dd>{{ requestAccountLabel(selectedRequest) }}</dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{{ formatTime(selectedRequest.createdAt) }}</dd>
          </div>
          <div>
            <dt>参考图</dt>
            <dd class="detail-path">{{ selectedRequest.referenceImagePath || "未提供" }}</dd>
          </div>
        </dl>

        <div v-if="selectedError" class="failure-detail" role="status">
          <span class="failure-stage">失败阶段：{{ failureStageLabels[selectedError.stage] }}</span>
          <h3>{{ selectedError.title }}</h3>
          <p>{{ selectedError.suggestion }}</p>
          <details><summary>原始错误信息</summary><p>{{ selectedError.detail }}</p></details>
        </div>

        <div class="request-detail-section"><h3>执行步骤</h3><ol class="execution-timeline">
          <li v-for="action in selectedActions" :key="action.id" :class="`step-${action.status}`"><time>{{ formatTime(action.createdAt) }}</time><div><strong>{{ action.action }}</strong><p>{{ action.message }}</p></div></li>
        </ol><span v-if="!selectedActions.length" class="cell-meta">暂无步骤记录</span></div>

        <div class="request-detail-section">
          <div class="request-detail-heading">
            <h3>完整提示词</h3>
            <button class="tool-button" type="button" title="复制完整提示词" aria-label="复制提示词" @click="copyRequestValue('prompt', selectedRequest.prompt)">
              <Check v-if="copiedField === 'prompt'" :size="15" /><Copy v-else :size="15" />
            </button>
          </div>
          <pre class="request-prompt-full">{{ selectedRequest.prompt || "-" }}</pre>
        </div>

        <div class="request-detail-section">
          <h3>执行信息</h3>
          <p class="request-message-full">{{ selectedRequest.message || "暂无执行信息" }}</p>
        </div>

        <div class="request-detail-section">
          <div class="request-detail-heading">
            <h3>最终视频结果</h3>
            <button
              v-if="resultValue(selectedRequest) !== '-'"
              class="tool-button"
              type="button"
              title="复制最终视频地址或路径" aria-label="复制结果"
              @click="copyRequestValue('result', resultValue(selectedRequest))"
            >
              <Check v-if="copiedField === 'result'" :size="15" /><Copy v-else :size="15" />
            </button>
          </div>
          <code class="request-result-value" :class="{ empty: resultValue(selectedRequest) === '-' }">
            {{ resultValue(selectedRequest) === '-' ? "尚未拿到可播放的 MP4 文件" : resultValue(selectedRequest) }}
          </code>
        </div>
      </section>
    </div>

    <div v-if="editingAccount" class="modal-backdrop" @click.self="closeAccountSettings">
      <form class="modal" @submit.prevent="saveAccountSettings">
        <div class="modal-header">
          <div>
            <h2>账号设置</h2>
            <p>{{ accountCode(editingAccount) }} / {{ editingAccount.partition }}</p>
          </div>
          <button class="tool-button" type="button" title="关闭账号设置" aria-label="关闭账号设置" @click="closeAccountSettings"><X :size="18" /></button>
        </div>

        <label>
          <span>备注</span>
          <input v-model="accountSettingsForm.remark" placeholder="例如 主号、备用号、客户 A" />
        </label>
        <label>
          <span>每日总额度</span>
          <input v-model.number="accountSettingsForm.dailyQuotaLimit" type="number" min="0" />
        </label>
        <label>
          <span>今日已消耗额度</span>
          <input v-model.number="accountSettingsForm.quotaUsedToday" type="number" min="0" step="0.1" />
        </label>
        <div class="readonly-quota">
          <span>自动计算剩余额度</span>
          <strong>{{ modalRemainingQuota }}</strong>
        </div>

        <div class="quota-note">
          Mini 每次消耗 {{ settingsForm.miniCost }} 额度；Fast 每次消耗 {{ settingsForm.fastCost }} 额度。账号池首页只读显示，避免误改。
        </div>

        <div class="modal-actions">
          <button class="button primary" type="submit">保存设置</button>
          <button class="button" type="button" @click="closeAccountSettings">取消</button>
        </div>
      </form>
    </div>
  </main>
</template>
