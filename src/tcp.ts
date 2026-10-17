import { AsyncQueue } from './async-queue';
import { BytesLike, concatBytes, indexOfBytes, toBytes, utf8Decode, utf8Encode } from './bytes';
import { trackResource } from './registry';
import { getTcpDriver, RawServer, RawSocket } from './tcp-native';

/** A connected TCP (or TLS) stream. Read with `read()`/`for await`, write with `write()`. */
export class Conn implements AsyncIterable<Uint8Array> {
  readonly remoteAddress: string;
  readonly remotePort: number;
  private queue = new AsyncQueue<Uint8Array>();
  private pending: Uint8Array = new Uint8Array(0);
  private untrack: () => void;
  private _closed = false;

  constructor(private socket: RawSocket) {
    this.remoteAddress = socket.remoteAddress ?? '';
    this.remotePort = socket.remotePort ?? 0;
    socket.on('data', (d: unknown) => {
      this.queue.push(typeof d === 'string' ? utf8Encode(d) : Uint8Array.from(d as ArrayLike<number>));
    });
    socket.on('error', (e: unknown) => this.finish(e instanceof Error ? e : new Error(String(e))));
    socket.on('close', () => this.finish());
    this.untrack = trackResource(() => this.close());
  }

  private finish(err?: Error) {
    this._closed = true;
    this.untrack();
    this.queue.close(err);
  }

  get closed(): boolean {
    return this._closed;
  }

  /** Next chunk of bytes, or `null` when the peer closed. */
  async read(): Promise<Uint8Array | null> {
    if (this.pending.length) {
      const p = this.pending;
      this.pending = new Uint8Array(0);
      return p;
    }
    const r = await this.queue.next();
    return r.done ? null : r.value;
  }

  /** Read exactly `n` bytes (fewer only if the stream ends first). */
  async readExactly(n: number): Promise<Uint8Array> {
    while (this.pending.length < n) {
      const r = await this.queue.next();
      if (r.done) break;
      this.pending = concatBytes([this.pending, r.value]);
    }
    const out = this.pending.subarray(0, n);
    this.pending = this.pending.subarray(n);
    return out;
  }

  /** Read up to and excluding `\n` (a trailing `\r` is stripped). `null` at end of stream. */
  async readLine(): Promise<string | null> {
    for (;;) {
      const i = indexOfBytes(this.pending, [10]);
      if (i >= 0) {
        let line = this.pending.subarray(0, i);
        this.pending = this.pending.subarray(i + 1);
        if (line.length && line[line.length - 1] === 13) line = line.subarray(0, line.length - 1);
        return utf8Decode(line);
      }
      const r = await this.queue.next();
      if (r.done) {
        if (!this.pending.length) return null;
        const rest = this.pending;
        this.pending = new Uint8Array(0);
        return utf8Decode(rest);
      }
      this.pending = concatBytes([this.pending, r.value]);
    }
  }

  /** Read the whole remaining stream as text. */
  async readText(): Promise<string> {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const c = await this.read();
      if (!c) break;
      chunks.push(c);
    }
    return chunks.length ? utf8Decode(concatBytes(chunks)) : '';
  }

  write(data: BytesLike): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._closed) return reject(new Error('Connection closed'));
      try {
        this.socket.write(toBytes(data), undefined, (e?: Error) => (e ? reject(e) : resolve()));
      } catch (e) {
        reject(e);
      }
    });
  }

  /** Half-close: flush and send FIN. */
  end(): void {
    try {
      this.socket.end();
    } catch {
      // already closed
    }
  }

  close(): void {
    try {
      this.socket.destroy();
    } catch {
      // already closed
    }
    this.finish();
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        const v = await this.read();
        return v ? { value: v, done: false } : { value: undefined, done: true };
      },
    };
  }
}

export interface ConnectOptions {
  host: string;
  port: number;
  /** Wrap in TLS. `true` or options (e.g. `{ ca }`). */
  tls?: boolean | Record<string, unknown>;
  timeoutMs?: number;
}

export function connect(options: ConnectOptions): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const tls = options.tls;
    const raw: Record<string, unknown> = {
      host: options.host,
      port: options.port,
      ...(tls ? { tls: true, ...(typeof tls === 'object' ? tls : {}) } : {}),
    };
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const socket = getTcpDriver().createConnection(raw, () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(new Conn(socket));
    });
    socket.on('error', (e: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`Connect timeout after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    }
  });
}

export interface ListenOptions {
  port: number;
  host?: string;
  /** PKCS12 keystore for TLS: a `file://` URI or `{ uri }`. Empty password only (library limit). */
  tls?: { keystore: string | { uri: string } } & Record<string, unknown>;
}

/** A TCP listener. `for await (const conn of server)` or `await server.accept()`. */
export class Listener implements AsyncIterable<Conn> {
  port = 0;
  host = '';
  private queue = new AsyncQueue<Conn>();
  private untrack: () => void;

  constructor(private server: RawServer) {
    this.untrack = trackResource(() => this.close());
  }

  /** @internal */
  _push(c: Conn) {
    this.queue.push(c);
  }

  /** @internal */
  _fail(e: Error) {
    this.queue.close(e);
  }

  async accept(): Promise<Conn | null> {
    const r = await this.queue.next();
    return r.done ? null : r.value;
  }

  close(): void {
    this.untrack();
    try {
      this.server.close();
    } catch {
      // already closed
    }
    this.queue.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<Conn> {
    return {
      next: async () => {
        const c = await this.accept();
        return c ? { value: c, done: false } : { value: undefined, done: true };
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

export function listen(options: ListenOptions): Promise<Listener> {
  return new Promise((resolve, reject) => {
    const driver = getTcpDriver();
    let listener: Listener;
    const onConn = (s: RawSocket) => listener._push(new Conn(s));
    let server: RawServer;
    if (options.tls) {
      const ks = options.tls.keystore;
      server = driver.createTLSServer(
        { ...options.tls, keystore: typeof ks === 'string' ? { uri: ks } : ks },
        onConn,
      );
    } else {
      server = driver.createServer(onConn);
    }
    listener = new Listener(server);
    let up = false;
    server.on('error', (e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      if (!up) {
        listener.close();
        reject(err);
      } else listener._fail(err);
    });
    server.listen({ port: options.port, host: options.host ?? '0.0.0.0', reuseAddress: true }, () => {
      up = true;
      const a = server.address();
      listener.port = a?.port ?? options.port;
      listener.host = a?.address ?? options.host ?? '0.0.0.0';
      resolve(listener);
    });
  });
}
