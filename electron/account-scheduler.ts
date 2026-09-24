export interface AccountTask {
  key: string;
  accountId: number;
}

export class AccountTaskScheduler<T extends AccountTask> {
  private readonly pending: T[] = [];
  private readonly activeKeys = new Set<string>();
  private readonly activeAccountIds = new Set<number>();
  private readonly activeAccountByKey = new Map<string, number>();
  private draining = false;

  constructor(
    private readonly getConcurrency: () => number,
    private readonly worker: (item: T) => Promise<void>,
    private readonly onWorkerError: (error: unknown) => void = () => undefined
  ) {}

  enqueue(item: T) {
    if (this.activeKeys.has(item.key) || this.pending.some((queued) => queued.key === item.key)) {
      return false;
    }
    this.pending.push(item);
    this.drain();
    return true;
  }

  cancel(key: string) {
    const index = this.pending.findIndex((item) => item.key === key);
    if (index >= 0) {
      this.pending.splice(index, 1);
      return true;
    }

    const accountId = this.activeAccountByKey.get(key);
    if (accountId === undefined) return false;
    this.activeKeys.delete(key);
    this.activeAccountIds.delete(accountId);
    this.activeAccountByKey.delete(key);
    this.drain();
    return true;
  }

  isActive(key: string) {
    return this.activeKeys.has(key);
  }

  private drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      const concurrency = Math.max(1, Math.trunc(this.getConcurrency()) || 1);
      while (this.activeKeys.size < concurrency) {
        const nextIndex = this.pending.findIndex(
          (item) => !this.activeAccountIds.has(item.accountId)
        );
        if (nextIndex < 0) break;

        const [item] = this.pending.splice(nextIndex, 1);
        this.activeKeys.add(item.key);
        this.activeAccountIds.add(item.accountId);
        this.activeAccountByKey.set(item.key, item.accountId);

        void Promise.resolve()
          .then(() => this.worker(item))
          .catch((error) => this.onWorkerError(error))
          .finally(() => {
            const activeAccountId = this.activeAccountByKey.get(item.key);
            this.activeKeys.delete(item.key);
            this.activeAccountByKey.delete(item.key);
            if (activeAccountId !== undefined) this.activeAccountIds.delete(activeAccountId);
            this.drain();
          });
      }
    } finally {
      this.draining = false;
    }
  }
}
