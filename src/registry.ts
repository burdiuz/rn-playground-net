/**
 * Everything a run opens (listeners, sockets) registers a closer here so the next run — or leaving
 * the run screen — can release ports. Without it, re-running a server file fails with "address in use".
 */
const closers = new Set<() => void>();
const listeners = new Set<(count: number) => void>();

function notify(): void {
  for (const listener of Array.from(listeners)) listener(closers.size);
}

/** Called with the number of open resources whenever it changes. Returns an unsubscribe function. */
export function onNetActivity(listener: (count: number) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function trackResource(close: () => void): () => void {
  closers.add(close);
  notify();
  return () => {
    if (closers.delete(close)) notify();
  };
}

export function closeAllNetResources(): void {
  for (const close of Array.from(closers)) {
    try {
      close();
    } catch {
      // best effort
    }
  }
  closers.clear();
  notify();
}

export function openNetResourceCount(): number {
  return closers.size;
}
