import { IPty } from "node-pty";

interface SharedPty {
  term: IPty;
  buffer: string;
  subscribers: Set<(data: string) => void>;
}

const pool = new Map<string, SharedPty>();
const SCROLLBACK_LIMIT = 100_000;

export function ensureSharedPty(key: string, spawn: () => IPty): void {
  if (pool.has(key)) return;
  const term = spawn();
  const entry: SharedPty = { term, buffer: "", subscribers: new Set() };
  term.onData((data) => {
    entry.buffer = (entry.buffer + data).slice(-SCROLLBACK_LIMIT);
    for (const sub of entry.subscribers) sub(data);
  });
  term.onExit(() => {
    if (pool.get(key) === entry) pool.delete(key);
  });
  pool.set(key, entry);
}

export function attachSharedPty(
  key: string,
  onData: (data: string) => void
): { unsubscribe: () => void; write: (data: string) => void; resize: (cols: number, rows: number) => void } | null {
  const entry = pool.get(key);
  if (!entry) return null;
  if (entry.buffer) onData(entry.buffer);
  entry.subscribers.add(onData);
  return {
    unsubscribe: () => entry.subscribers.delete(onData),
    write: (data) => entry.term.write(data),
    resize: (cols, rows) => {
      try { entry.term.resize(cols, rows); } catch {}
    },
  };
}

export function killSharedPty(key: string): void {
  const entry = pool.get(key);
  if (!entry) return;
  pool.delete(key);
  try { entry.term.kill(); } catch {}
}
