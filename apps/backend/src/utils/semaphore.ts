/**
 * Simple async semaphore for concurrency limiting.
 * Use to cap expensive I/O or CPU-adjacent work (e.g. embedding calls, JSON parsing).
 */
export class Semaphore {
  private readonly max: number;
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error(`Semaphore max must be > 0 (got ${max})`);
    }
    this.max = Math.floor(max);
  }

  get inUse(): number {
    return this.current;
  }

  get available(): number {
    return Math.max(0, this.max - this.current);
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new Error('Semaphore acquire aborted');
    }

    if (this.current < this.max) {
      this.current++;
      return () => this.release();
    }

    return await new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        // Remove from queue if still present
        const idx = this.queue.indexOf(grant);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error('Semaphore acquire aborted'));
      };

      const grant = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        this.current++;
        resolve(() => this.release());
      };

      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(grant);
    });
  }

  private release(): void {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

