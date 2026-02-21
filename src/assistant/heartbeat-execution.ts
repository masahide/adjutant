type TimeoutRuntime = {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

export class HeartbeatExecution {
  constructor(private readonly runtime: TimeoutRuntime) {}

  async runWithTimeout<T>(timeoutMs: number, task: () => Promise<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = this.runtime.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error(`heartbeat timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      task()
        .then((value) => {
          if (settled) {
            return;
          }
          settled = true;
          this.runtime.clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          if (settled) {
            return;
          }
          settled = true;
          this.runtime.clearTimeout(timer);
          reject(error);
        });
    });
  }
}
