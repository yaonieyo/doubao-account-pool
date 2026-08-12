<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
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
  OperationLogStatus
} from "../electron/types";

type TabKey = "accounts" | "settings" | "logs" | "actions";

const accounts = ref<Account[]>([]);
const apiRequests = ref<ApiRequest[]>([]);
const operationLogs = ref<OperationLog[]>([]);
const apiStatus = ref<ApiServerStatus>({
  version: "0.1.35",
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
const accountStatusFilter = ref<"all" | "available" | "exhausted" | "login_required">("all");
const openAccountMenuId = ref<number | null>(null);
const batchMenuOpen = ref(false);
const apiAddressCopied = ref(false);
const logSearch = ref("");
const logStatusFilter = ref<"all" | ApiRequestStatus>("all");
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
  maxConcurrentAccounts: 4,
  retryCount: 1,
  autoRemoveWatermark: true,
  watermarkApiUrl: "https://nologo.code24.top/api/water-mask/parse",
  watermarkApiToken: "",
  outputDir: ""
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
  Math.max(0, Number(accountSettingsForm.dailyQuotaLimit || 0) - Number(accountSettingsForm.quotaUsedToday || 0))
);

const filteredApiRequests = computed(() => {
  const keyword = logSearch.value.trim().toLocaleLowerCase("zh-CN");

  return apiRequests.value.filter((item) => {
    if (logStatusFilter.value !== "all" && item.status !== logStatusFilter.value) return false;
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
  const remaining = accounts.value.reduce((sum, account) => sum + account.quotaRemaining, 0);
  const used = Math.max(0, total - remaining);

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
  const token = settingsForm.apiKey || "local-doubao-key";
  return `# 共享额度：账号每日 ${settingsForm.dailyQuotaLimit}，Mini 每次扣 ${settingsForm.miniCost}，Fast 每次扣 ${settingsForm.fastCost}
curl -X POST http://127.0.0.1:${port}/api/generate \\
  -H "Authorization: Bearer ${token}" \\
  -F "model=seedance_2_0_mini" \\
  -F "prompt=生成一段 10 秒女性科普动画" \\
  -F "referenceImage=@/Users/your-name/Pictures/ref.png" \\
  -F "removeWatermark=true" \\
  -F "callbackUrl=http://127.0.0.1:3000/doubao/callback"`;
});

const watermarkExample = computed(() => {
  const port = settingsForm.apiPort || 17888;
  const token = settingsForm.apiKey || "local-doubao-key";
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
  const [accountRows, settings, status, requests, actions] = await Promise.all([
    window.doubaoManager.accounts.list(),
    window.doubaoManager.settings.get(),
    window.doubaoManager.apiServer.status(),
    window.doubaoManager.apiRequests.list(100),
    window.doubaoManager.operationLogs.list(500)
  ]);
  accounts.value = accountRows;
  apiRequests.value = requests;
  operationLogs.value = actions;
  apiStatus.value = status;
  Object.assign(settingsForm, settings);
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
  await window.doubaoManager.accounts.resetQuota(account.id);
  await refresh();
}

async function resetAllQuotas() {
  if (!window.confirm("重置所有账号今日额度？")) return;
  await window.doubaoManager.accounts.resetAllQuotas();
  await refresh();
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
  const used = Math.min(total, Math.max(0, Math.floor(Number(accountSettingsForm.quotaUsedToday) || 0)));
  await window.doubaoManager.accounts.update({
    id: editingAccount.value.id,
    remark: accountSettingsForm.remark.trim(),
    dailyQuotaLimit: total,
    quotaRemaining: total - used,
    quotaUsedToday: used
  });
  closeAccountSettings();
  await refresh();
}

async function saveSettings() {
  await window.doubaoManager.settings.update({
    ...settingsForm,
    apiPort: Number(settingsForm.apiPort),
    dailyQuotaLimit: Number(settingsForm.dailyQuotaLimit),
    miniCost: Number(settingsForm.miniCost),
    fastCost: Number(settingsForm.fastCost),
    generationTimeoutSeconds: Number(settingsForm.generationTimeoutSeconds),
    maxConcurrentAccounts: Number(settingsForm.maxConcurrentAccounts),
    retryCount: Number(settingsForm.retryCount)
  });
  await refresh();
}

async function restartApiServer() {
  apiStatus.value = await window.doubaoManager.apiServer.restart();
}

async function clearLogs() {
  if (!window.confirm("清空接口日志？")) return;
  await window.doubaoManager.apiRequests.clear();
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
  return account.quotaRemaining < minimumQuotaCost();
}

function isLoginRequired(account: Account) {
  return account.loginStatus === "logged_out" || account.currentStatus === "login_required";
}

function isAccountAvailable(account: Account) {
  return account.loginStatus === "logged_in" && account.currentStatus === "idle" && !isQuotaExhausted(account);
}

function accountStatusLabel(account: Account) {
  if (isLoginRequired(account)) return "登录失效";
  if (account.currentStatus === "error") return "启动失败";
  if (account.currentStatus === "busy") return "生成中";
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
  const cost = model === "seedance_2_0_mini" ? Number(settingsForm.miniCost) : Number(settingsForm.fastCost);
  return Math.floor(account.quotaRemaining / Math.max(1, cost || 1));
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
        <h1>豆包账号池</h1>
        <p>多账号隔离登录，共享每日额度；Mini/Fast 按不同消耗对外提供本地接口。</p>
      </div>
      <div class="api-status-compact" :class="{ running: apiStatus.running, error: !apiStatus.running }">
        <span class="status-dot" aria-hidden="true"></span>
        <strong>{{ apiStatus.running ? "API 正常" : "API 异常" }}</strong>
        <span class="app-version">v{{ apiStatus.version }}</span>
        <span>{{ apiDisplayAddress() }}</span>
        <button v-if="apiStatus.url" type="button" @click="copyApiAddress">
          {{ apiAddressCopied ? "已复制" : "复制地址" }}
        </button>
      </div>
    </header>

    <nav class="tabs">
      <button :class="{ active: activeTab === 'accounts' }" @click="activeTab = 'accounts'">账号池</button>
      <button :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'">配置管理</button>
      <button :class="{ active: activeTab === 'logs' }" @click="activeTab = 'logs'">接口日志</button>
      <button :class="{ active: activeTab === 'actions' }" @click="activeTab = 'actions'">行动日志</button>
    </nav>

    <section v-if="loading" class="empty">加载中...</section>

    <section v-else-if="activeTab === 'accounts'" class="panel">
      <div class="section-title">
        <div>
          <h2>账号池</h2>
          <p>统一查看账号登录、运行状态和今日可用额度。</p>
        </div>
      </div>

      <div class="account-overview account-overview-compact" role="list" aria-label="账号与额度概览">
        <div role="listitem">
          <span>账号总数</span>
          <strong>{{ accountOverview.total }}</strong>
        </div>
        <div role="listitem">
          <span>已登录</span>
          <strong>{{ accountOverview.loggedIn }}</strong>
        </div>
        <div role="listitem" class="overview-success">
          <span>可用账号</span>
          <strong>{{ accountOverview.available }}</strong>
        </div>
        <div role="listitem" :class="{ 'overview-warning': accountOverview.exhausted > 0 }">
          <span>今日额度耗尽</span>
          <strong>{{ accountOverview.exhausted }}</strong>
        </div>
        <div class="overview-quota" role="listitem">
          <span>总剩余额度</span>
          <strong>{{ accountQuotaSummary.remaining }} / {{ accountQuotaSummary.total }}</strong>
          <div
            class="overview-quota-track"
            :class="{ exhausted: accountQuotaSummary.remaining < minimumQuotaCost() }"
            role="progressbar"
            :aria-valuenow="accountQuotaSummary.usedPercent"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <span :style="{ width: `${accountQuotaSummary.usedPercent}%` }"></span>
          </div>
        </div>
        <div role="listitem" title="全部剩余额度只用于 Mini 时的预计次数">
          <span>Mini 预计</span>
          <strong>{{ accountQuotaSummary.miniRuns }} 次</strong>
        </div>
        <div role="listitem" title="全部剩余额度只用于 Fast 时的预计次数；与 Mini 预计次数不可相加">
          <span>Fast 预计</span>
          <strong>{{ accountQuotaSummary.fastRuns }} 次</strong>
        </div>
      </div>

      <div class="account-toolbar">
        <div class="account-filters">
          <label>
            <span>搜索账号</span>
            <input v-model="accountSearch" type="search" placeholder="搜索账号或备注" />
          </label>
          <label>
            <span>状态筛选</span>
            <select v-model="accountStatusFilter">
              <option value="all">全部账号</option>
              <option value="available">可用账号</option>
              <option value="exhausted">额度耗尽</option>
              <option value="login_required">登录失效</option>
            </select>
          </label>
        </div>
        <div class="toolbar">
          <div class="action-menu batch-menu">
            <button class="button" type="button" @click.stop="toggleBatchMenu">批量操作</button>
            <div v-if="batchMenuOpen" class="action-menu-popover" @click.stop>
              <button type="button" @click="batchMenuOpen = false; detectAll()">检测全部账号</button>
              <button type="button" @click="batchMenuOpen = false; refresh()">刷新账号状态</button>
              <span class="menu-separator"></span>
              <button class="warning-text" type="button" @click="batchMenuOpen = false; resetAllQuotas()">重置全部今日额度</button>
            </div>
          </div>
          <button class="button primary" @click="addAccountAndOpen">添加账号</button>
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
                  <button class="partition-info" type="button" :title="account.partition" aria-label="查看账号隔离分区">i</button>
                </div>
                <span class="account-remark">{{ account.remark || "未添加备注" }}</span>
              </td>
              <td>
                <div class="account-runtime" :class="`tone-${accountStatusTone(account)}`">
                  <span class="status-dot" aria-hidden="true"></span>
                  <strong>{{ accountStatusLabel(account) }}</strong>
                </div>
                <span class="account-login-state">{{ loginLabels[account.loginStatus] }}</span>
              </td>
              <td class="quota-cell">
                <div class="quota-heading">
                  <strong>今日剩余：{{ account.quotaRemaining }} / {{ account.dailyQuotaLimit }}</strong>
                  <span>{{ isQuotaExhausted(account) ? "今日额度已耗尽" : `已用 ${account.quotaUsedToday}` }}</span>
                </div>
                <div class="quota-progress" :class="{ exhausted: isQuotaExhausted(account) }" role="progressbar" :aria-valuenow="quotaUsedPercent(account)" aria-valuemin="0" aria-valuemax="100">
                  <span :style="{ width: `${quotaUsedPercent(account)}%` }"></span>
                </div>
                <div class="quota-models">
                  <span>Mini 可生成 {{ remainingGenerations(account, 'seedance_2_0_mini') }} 次</span>
                  <span>Fast 可生成 {{ remainingGenerations(account, 'seedance_2_0_fast') }} 次</span>
                </div>
              </td>
              <td class="last-used-cell" :title="fullTime(account.lastUsedAt)">{{ formatRelativeTime(account.lastUsedAt) }}</td>
              <td class="account-actions-cell">
                <div class="row-actions account-actions">
                  <button class="button primary compact-button" @click="openAccount(account)">打开豆包</button>
                  <button class="button compact-button" @click="detectAccount(account)">检测</button>
                  <div class="action-menu">
                    <button class="more-button" type="button" aria-label="更多账号操作" @click.stop="toggleAccountMenu(account.id)">···</button>
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
            <p>这些配置会保存到 SQLite，并影响本地接口服务。</p>
          </div>
          <div class="toolbar">
            <button class="button primary" type="submit">保存配置</button>
            <button class="button" type="button" @click="restartApiServer">重启 API</button>
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
            <input v-model="settingsForm.apiKey" placeholder="Authorization: Bearer ..." />
          </label>
        </div>

        <div class="form-section">
          <h3>模型额度</h3>
          <p class="form-hint">豆包账号每天只有一条共享额度，默认总额 10；Mini 消耗 2，Fast 消耗 3。</p>
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
            <input v-model.number="settingsForm.miniCost" type="number" min="1" />
          </label>
          <label>
            <span>Fast 单次消耗</span>
            <input v-model.number="settingsForm.fastCost" type="number" min="1" />
          </label>
          <label>
            <span>每日重置时间</span>
            <input v-model="settingsForm.dailyResetTime" placeholder="00:00" />
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
            <span>最大并发账号数（不同账号同时执行）</span>
            <input v-model.number="settingsForm.maxConcurrentAccounts" type="number" min="1" />
          </label>
          <label>
            <span>失败重试次数</span>
            <input v-model.number="settingsForm.retryCount" type="number" min="0" />
          </label>
        </div>

        <div class="form-section wide">
          <h3>去水印</h3>
          <label class="checkbox-line">
            <input v-model="settingsForm.autoRemoveWatermark" type="checkbox" />
            默认自动过水印
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

      <aside class="panel">
        <div class="section-title">
          <div>
            <h2>接口示例</h2>
            <p>其他无限画布或工作流可以按这个格式调用。</p>
          </div>
        </div>
        <h3>生成请求</h3>
        <pre>{{ apiExample }}</pre>
        <h3>单独过水印</h3>
        <pre>{{ watermarkExample }}</pre>
      </aside>
    </section>

    <section v-else-if="activeTab === 'logs'" class="panel logs-panel">
      <div class="section-title">
        <div>
          <h2>接口日志</h2>
          <p>最近 100 条外部请求。表格展示摘要，完整提示词和视频结果请打开详情。</p>
        </div>
        <div class="toolbar">
          <button class="button" @click="refresh">刷新</button>
          <button class="button danger" @click="clearLogs">清空</button>
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
              <th>执行信息</th>
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
                <span class="cell-meta">{{ requestAccountLabel(item) }}</span>
              </td>
              <td>
                <span class="pill" :class="`request-${item.status}`">
                  {{ requestLabels[item.status] }}
                </span>
              </td>
              <td><p class="message-preview">{{ item.message || "-" }}</p></td>
              <td><p class="prompt-preview">{{ promptPreview(item.prompt) }}</p></td>
              <td>
                <span class="result-indicator" :class="{ ready: resultValue(item) !== '-' }">
                  {{ resultLabel(item) }}
                </span>
                <button class="icon-button log-detail-button" type="button" @click="openRequestDetails(item)">
                  查看详情
                </button>
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
          <p>记录每个任务和账号操作的详细步骤，日志自动保留 3 天。</p>
        </div>
        <div class="toolbar">
          <button class="button" @click="refresh">刷新</button>
          <button class="button danger" @click="clearOperationLogs">清空</button>
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
                  <button class="icon-button" type="button" @click="copyOperationUrl(item.targetUrl)">复制</button>
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

    <div v-if="selectedRequest" class="modal-backdrop" @click.self="closeRequestDetails">
      <section class="modal request-detail-modal" role="dialog" aria-modal="true" aria-labelledby="request-detail-title">
        <div class="modal-header">
          <div>
            <h2 id="request-detail-title">请求详情</h2>
            <p>{{ selectedRequest.requestId }}</p>
          </div>
          <button class="icon-button" type="button" @click="closeRequestDetails">关闭</button>
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

        <div class="request-detail-section">
          <div class="request-detail-heading">
            <h3>完整提示词</h3>
            <button class="icon-button" type="button" @click="copyRequestValue('prompt', selectedRequest.prompt)">
              {{ copiedField === "prompt" ? "已复制" : "复制提示词" }}
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
              class="icon-button"
              type="button"
              @click="copyRequestValue('result', resultValue(selectedRequest))"
            >
              {{ copiedField === "result" ? "已复制" : "复制结果" }}
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
          <button class="icon-button" type="button" @click="closeAccountSettings">关闭</button>
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
          <input v-model.number="accountSettingsForm.quotaUsedToday" type="number" min="0" />
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
