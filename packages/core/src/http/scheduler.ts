import { setTimeout as delay } from 'node:timers/promises';
export class RequestScheduler {
  private active = 0;
  private waiting: (() => void)[] = [];
  private startGates = new Map<string, Promise<void>>();
  private nextStart = new Map<string, number>();
  constructor(private readonly concurrency: number, private readonly intervalMs: number) {}
  defer(host: string, waitMs: number) {
    this.nextStart.set(host, Math.max(this.nextStart.get(host) ?? 0, Date.now() + waitMs));
  }
  async run<T>(host: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    while (this.active >= this.concurrency) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { this.waiting = this.waiting.filter(item => item !== wake); reject(signal?.reason); };
        function wake() { signal?.removeEventListener('abort', abort); resolve(); }
        this.waiting.push(wake); signal?.addEventListener('abort', abort, { once: true });
      });
      signal?.throwIfAborted();
    }
    this.active++;
    try {
      const previous = this.startGates.get(host) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      this.startGates.set(host, previous.then(() => gate));
      await previous;
      try {
        signal?.throwIfAborted();
        let wait = (this.nextStart.get(host) ?? 0) - Date.now();
        while (wait > 0) { await delay(Math.min(wait, 2147483647), undefined, { signal }); wait = (this.nextStart.get(host) ?? 0) - Date.now(); }
        this.nextStart.set(host, Date.now() + this.intervalMs);
      } finally { release(); }
      signal?.throwIfAborted();
      return await task();
    } finally { this.active--; this.waiting.shift()?.(); }
  }
}
