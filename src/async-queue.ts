/** Unbounded async FIFO: producers `push`, one consumer awaits `next()` / iterates. */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }[] = [];
  private done = false;
  private failure: unknown = undefined;
  private failed = false;

  push(item: T): void {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  /** Ends the stream. Pending items are still delivered; then `error` (if any) is thrown once. */
  close(error?: unknown): void {
    if (this.done) return;
    this.done = true;
    if (error !== undefined) {
      this.failed = true;
      this.failure = error;
    }
    for (const w of this.waiters.splice(0)) {
      if (this.failed) {
        this.failed = false;
        w.reject(this.failure);
      } else w.resolve({ value: undefined, done: true });
    }
  }

  get closed(): boolean {
    return this.done;
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
    if (this.done) {
      if (this.failed) {
        this.failed = false;
        return Promise.reject(this.failure);
      }
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}
