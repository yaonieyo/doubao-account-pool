import type {
  Account,
  AccountUpdateInput,
  ApiRequest,
  ApiServerStatus,
  AppSettings,
  AppSettingsUpdateInput,
  OperationLog
} from "../electron/types";

declare global {
  interface Window {
    doubaoManager: {
      accounts: {
        list: () => Promise<Account[]>;
        create: (remark?: string) => Promise<Account>;
        update: (input: AccountUpdateInput) => Promise<Account>;
        delete: (id: number) => Promise<boolean>;
        open: (id: number) => Promise<void>;
        relogin: (id: number) => Promise<boolean>;
        detectLogin: (id: number) => Promise<Account>;
        detectAll: () => Promise<Account[]>;
        resetQuota: (id: number) => Promise<Account>;
        resetAllQuotas: () => Promise<Account[]>;
      };
      settings: {
        get: () => Promise<AppSettings>;
        update: (input: AppSettingsUpdateInput) => Promise<AppSettings>;
      };
      apiServer: {
        status: () => Promise<ApiServerStatus>;
        restart: () => Promise<ApiServerStatus>;
      };
      apiRequests: {
        list: (limit?: number) => Promise<ApiRequest[]>;
        todaySuccessCount: (startIso: string, endIso: string) => Promise<number>;
        stop: (requestId: string) => Promise<{ request: ApiRequest; stopped: boolean; refunded: boolean }>;
        clear: () => Promise<boolean>;
      };
      operationLogs: {
        list: (limit?: number) => Promise<OperationLog[]>;
        clear: () => Promise<boolean>;
      };
      events: {
        onDataChanged: (callback: () => void) => () => void;
      };
    };
  }
}

export {};
