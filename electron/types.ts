export type LoginStatus = "unknown" | "logged_in" | "logged_out";
export type AccountRuntimeStatus = "idle" | "busy" | "error" | "login_required";
export type DoubaoModel = "seedance_2_0_mini" | "seedance_2_0_fast";
export type DoubaoAspectRatio = "9:16" | "16:9";
export type ApiRequestStatus = "accepted" | "running" | "success" | "failed" | "stopped";
export type ExecutionPhase = "queued" | "submitting" | "generating" | "sharing" | "watermark" | "output" | "paused" | "finished";
export type OperationLogStatus = "info" | "success" | "failed";
export type FailureStage = "account" | "submission" | "generation" | "sharing" | "watermark" | "output" | "unknown";

export interface RequestErrorInfo {
  stage: FailureStage;
  code: string;
  title: string;
  detail: string;
  suggestion: string;
  retryable: boolean;
}

export interface WatermarkUsage {
  totalLimit: number | null;
  usedCount: number | null;
  remainingCount: number | null;
}

export interface WatermarkStatus {
  configured: boolean;
  usage: WatermarkUsage | null;
  checkedAt: string | null;
  usageUpdatedAt: string | null;
  error: RequestErrorInfo | null;
}

export interface RequestStats {
  todaySuccess: number;
  todayFailed: number;
  running: number;
  queued: number;
}

export interface Account {
  id: number;
  name: string;
  partition: string;
  remark: string;
  loginStatus: LoginStatus;
  currentStatus: AccountRuntimeStatus;
  dailyQuotaLimit: number;
  quotaRemaining: number;
  quotaUsedToday: number;
  quotaDate: string;
  dailyQuotaExhausted: boolean;
  quotaExhaustedDate: string | null;
  quotaExhaustedReason: string | null;
  availableQuota: number;
  nextQuotaResetAt: string;
  runningTaskCount: number;
  queuedTaskCount: number;
  maxConcurrentTasks: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountCreateInput {
  remark?: string;
}

export interface AccountUpdateInput {
  id: number;
  remark?: string;
  loginStatus?: LoginStatus;
  currentStatus?: AccountRuntimeStatus;
  dailyQuotaLimit?: number;
  quotaRemaining?: number;
  quotaUsedToday?: number;
}

export interface AppSettings {
  apiServiceEnabled: boolean;
  apiPort: number;
  apiKey: string;
  executorEnabled: boolean;
  showExecutorWindow: boolean;
  autoCloseExecutorWindow: boolean;
  doubaoChatUrl: string;
  defaultModel: DoubaoModel;
  dailyQuotaLimit: number;
  miniCost: number;
  fastCost: number;
  dailyResetTime: string;
  generationTimeoutSeconds: number;
  maxConcurrentAccounts: number;
  maxConcurrentTasksPerAccount: number;
  retryCount: number;
  autoRemoveWatermark: boolean;
  watermarkApiUrl: string;
  watermarkApiToken: string;
  outputDir: string;
}

export type AppSettingsUpdateInput = Partial<AppSettings>;

export interface ApiRequest {
  id: number;
  requestId: string;
  source: string;
  model: DoubaoModel;
  aspectRatio: DoubaoAspectRatio;
  duration: number;
  accountId: number | null;
  requestedAccountId: number | null;
  assignmentRevision: number;
  submissionSentAt: string | null;
  accountName: string | null;
  accountPartition: string | null;
  status: ApiRequestStatus;
  message: string;
  prompt: string;
  referenceImagePath: string | null;
  removeWatermark: boolean;
  callbackUrl: string | null;
  doubaoThreadUrl: string | null;
  sourceConversationUrl: string | null;
  executionPhase: ExecutionPhase;
  quotaDay: string | null;
  quotaCost: number;
  quotaReserved: boolean;
  generationAcceptedAt: string | null;
  rawVideoUrl: string | null;
  cleanVideoUrl: string | null;
  outputVideoPath: string | null;
  quotaRefunded: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  error: RequestErrorInfo | null;
}

export interface ApiRequestCreateInput {
  requestId: string;
  source?: string;
  model: DoubaoModel;
  aspectRatio?: DoubaoAspectRatio | null;
  duration?: number | null;
  accountId?: number | null;
  requestedAccountId?: number | null;
  status: ApiRequestStatus;
  message?: string;
  prompt: string;
  referenceImagePath?: string | null;
  removeWatermark?: boolean;
  callbackUrl?: string | null;
  quotaCost?: number;
  quotaDay?: string | null;
  quotaReserved?: boolean;
  executionPhase?: ExecutionPhase;
}

export interface ApiRequestUpdateInput {
  requestId: string;
  assignmentRevision?: number;
  submissionSentAt?: string | null;
  status?: ApiRequestStatus;
  message?: string;
  doubaoThreadUrl?: string | null;
  sourceConversationUrl?: string | null;
  executionPhase?: ExecutionPhase;
  rawVideoUrl?: string | null;
  cleanVideoUrl?: string | null;
  outputVideoPath?: string | null;
  error?: RequestErrorInfo | null;
}

export interface OperationLog {
  id: number;
  requestId: string | null;
  accountId: number | null;
  accountName: string | null;
  accountPartition: string | null;
  action: string;
  status: OperationLogStatus;
  message: string;
  targetUrl: string | null;
  createdAt: string;
}

export interface OperationLogCreateInput {
  requestId?: string | null;
  accountId?: number | null;
  action: string;
  status?: OperationLogStatus;
  message: string;
  targetUrl?: string | null;
}

export interface ApiServerStatus {
  version: string;
  enabled: boolean;
  running: boolean;
  port: number;
  url: string | null;
  message: string;
}

export interface GenerateRequestBody {
  accountId?: number | string;
  model?: DoubaoModel;
  aspectRatio?: DoubaoAspectRatio | string | null;
  duration?: number | string | null;
  prompt: string;
  referenceImagePath?: string | null;
  referenceImageUrl?: string | null;
  removeWatermark?: boolean;
  callbackUrl?: string | null;
  source?: string;
}
