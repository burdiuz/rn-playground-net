import { AsyncQueue } from './async-queue';
import { BytesLike, concatBytes, toBytes, utf8Encode } from './bytes';
import {
  decodeBody,
  Headers,
  HttpParseError,
  parseQuery,
  readBody,
  readRequestHead,
  RequestHead,
} from './http-parser';
import { Conn, listen, Listener } from './tcp';

export { Headers } from './http-parser';

export type Params = Record<string, string>;

export class HttpRequest {
  readonly method: string;
  /** Raw request target, e.g. `/a/b?x=1`. */
  readonly url: string;
  readonly path: string;
  readonly query: Params;
  readonly headers: Headers;
  readonly remoteAddress: string;
  readonly remotePort: number;
  /** Route parameters filled in by the router (`/users/:id`). */
  params: Params = {};
  /** Free-form per-request bag for middleware. */
  state: Record<string, unknown> = {};
  private raw: Uint8Array;

  constructor(head: RequestHead, body: Uint8Array, conn?: { remoteAddress: string; remotePort: number }) {
    this.method = head.method;
    this.url = head.target;
    const q = head.target.indexOf('?');
    const rawPath = q < 0 ? head.target : head.target.slice(0, q);
    try {
      this.path = decodeURI(rawPath);
    } catch {
      this.path = rawPath;
    }
    this.query = parseQuery(q < 0 ? '' : head.target.slice(q + 1));
    this.headers = head.headers;
    this.raw = body;
    this.remoteAddress = conn?.remoteAddress ?? '';
    this.remotePort = conn?.remotePort ?? 0;
  }

  get host(): string {
    return this.headers.get('host') ?? '';
  }

  get cookies(): Params {
    const out: Params = {};
    for (const p of (this.headers.get('cookie') ?? '').split(';')) {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    }
    return out;
  }

  bytes(): Uint8Array {
    return this.raw;
  }
  text(): string {
    return decodeBody(this.raw);
  }
  json<T = any>(): T {
    return JSON.parse(this.text());
  }
  /** Parses `application/x-www-form-urlencoded` bodies. */
  form(): Params {
    return parseQuery(this.text());
  }
}

export type BodyChunk = Uint8Array | string;

export interface ResponseInit {
  status?: number;
  headers?: Record<string, string | number> | Headers;
}

/** Hands the raw connection over (WebSocket upgrades). */
export type UpgradeHandler = (conn: Conn) => void | Promise<void>;

export class HttpResponse {
  status: number;
  headers: Headers;
  body: Uint8Array | AsyncIterable<BodyChunk> | null;
  upgrade?: UpgradeHandler;

  constructor(body: BytesLike | AsyncIterable<BodyChunk> | null = null, init: ResponseInit = {}) {
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers as any);
    this.body =
      body === null || body === undefined
        ? null
        : typeof body === 'object' && Symbol.asyncIterator in body
          ? (body as AsyncIterable<BodyChunk>)
          : toBytes(body as BytesLike);
  }
}

const withType = (type: string, init?: ResponseInit) => {
  const h = new Headers(init?.headers as any);
  if (!h.has('content-type')) h.set('content-type', type);
  return { ...init, headers: h };
};

export const text = (body: string, init?: ResponseInit) =>
  new HttpResponse(body, withType('text/plain; charset=utf-8', init));
export const html = (body: string, init?: ResponseInit) =>
  new HttpResponse(body, withType('text/html; charset=utf-8', init));
export const json = (data: unknown, init?: ResponseInit) =>
  new HttpResponse(JSON.stringify(data), withType('application/json; charset=utf-8', init));
export const status = (code: number, body = '') => new HttpResponse(body, { status: code });
export const redirect = (location: string, code = 302) =>
  new HttpResponse(null, { status: code, headers: { location } });

/**
 * Hermes cannot compile `async function*` or `for await` in user code, so streaming responses
 * also accept a producer function: `(send) => Promise<void>`. `send(x)` returns false once the
 * client is gone (stop producing); the response ends when the promise settles.
 */
export type Producer<T> = (send: (item: T) => boolean) => Promise<void> | void;

function fromProducer<T>(run: Producer<T>): AsyncIterable<T> {
  const queue = new AsyncQueue<T>();
  const send = (item: T) => {
    if (queue.closed) return false;
    queue.push(item);
    return true;
  };
  Promise.resolve()
    .then(() => run(send))
    .then(
      () => queue.close(),
      (e) => queue.close(e),
    );
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: () => queue.next(),
        return: async () => {
          queue.close();
          return { value: undefined, done: true } as IteratorResult<T>;
        },
      };
    },
  };
}

function mapIterable<T, U>(source: AsyncIterable<T>, fn: (item: T) => U): AsyncIterable<U> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<U> {
      const it = source[Symbol.asyncIterator]();
      return {
        next: async () => {
          const r = await it.next();
          return r.done ? { value: undefined, done: true } : { value: fn(r.value), done: false };
        },
        return: async () => {
          if (it.return) await it.return();
          return { value: undefined, done: true } as IteratorResult<U>;
        },
      };
    },
  };
}

/** Chunked streaming response from an async iterable or a producer function (see `Producer`). */
export const stream = (source: AsyncIterable<BodyChunk> | Producer<BodyChunk>, init?: ResponseInit) =>
  new HttpResponse(
    typeof source === 'function' ? fromProducer(source) : source,
    withType('application/octet-stream', init),
  );

function encodeEvent(item: unknown): string {
  if (item && typeof item === 'object' && 'data' in (item as any)) {
    const e = item as { event?: string; data: unknown; id?: string };
    let out = '';
    if (e.id) out += `id: ${e.id}\n`;
    if (e.event) out += `event: ${e.event}\n`;
    const d = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
    for (const l of d.split('\n')) out += `data: ${l}\n`;
    return out + '\n';
  }
  const d = typeof item === 'string' ? item : JSON.stringify(item);
  return d.split('\n').map((l) => `data: ${l}\n`).join('') + '\n';
}

/**
 * Server-Sent Events from an async iterable or a producer function:
 * `sse(async (send) => { send({ event: 'tick', data: { i } }); ... })`.
 * Strings/objects are JSON-encoded; `{ event, data, id }` objects become named events.
 */
export function sse(source: AsyncIterable<unknown> | Producer<unknown>, init?: ResponseInit): HttpResponse {
  const items = typeof source === 'function' ? fromProducer(source) : source;
  const h = new Headers(init?.headers as any);
  h.set('content-type', 'text/event-stream');
  h.set('cache-control', 'no-cache');
  return new HttpResponse(mapIterable(items, encodeEvent), { ...init, headers: h });
}

/** Anything a handler may return. */
export type HandlerResult =
  | HttpResponse
  | string
  | Uint8Array
  | ArrayBuffer
  | number
  | boolean
  | object
  | null
  | undefined
  | void;

export interface RequestInfo {
  remoteAddress: string;
  remotePort: number;
}

export type Handler = (req: HttpRequest, info: RequestInfo) => HandlerResult | Promise<HandlerResult>;

function isFetchResponse(v: any): boolean {
  return (
    v &&
    typeof v === 'object' &&
    typeof v.status === 'number' &&
    v.headers &&
    typeof v.headers.forEach === 'function' &&
    (typeof v.arrayBuffer === 'function' || typeof v.text === 'function')
  );
}

export async function toResponse(result: HandlerResult): Promise<HttpResponse> {
  if (result instanceof HttpResponse) return result;
  if (result === null || result === undefined) return status(404, 'Not Found');
  if (typeof result === 'string') {
    return result.trimStart().startsWith('<') ? html(result) : text(result);
  }
  if (result instanceof Uint8Array || result instanceof ArrayBuffer) {
    return new HttpResponse(result, { headers: { 'content-type': 'application/octet-stream' } });
  }
  if (isFetchResponse(result)) {
    const r = result as any;
    const h = new Headers();
    r.headers.forEach((v: string, k: string) => h.set(k, v));
    const body = typeof r.arrayBuffer === 'function' ? new Uint8Array(await r.arrayBuffer()) : utf8Encode(await r.text());
    return new HttpResponse(body, { status: r.status, headers: h });
  }
  if (typeof result === 'object') return json(result);
  return text(String(result));
}

const REASONS: Record<number, string> = {
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

function head(status: number, headers: Headers): Uint8Array {
  let s = `HTTP/1.1 ${status} ${REASONS[status] ?? 'Status'}\r\n`;
  headers.forEach((v, k) => (s += `${k}: ${v}\r\n`));
  return utf8Encode(s + '\r\n');
}

export interface ServeOptions {
  port: number;
  host?: string;
  /** Serve HTTPS: PKCS12 keystore (`file://` URI), empty password. */
  tls?: { keystore: string | { uri: string } };
  /** Called for handler exceptions (default: logs via console.error). */
  onError?: (error: unknown, req?: HttpRequest) => void;
  /** Max request body in bytes (default 32 MiB). */
  maxBodyBytes?: number;
  /** Called once listening. */
  onListen?: (info: { port: number; host: string; url: string }) => void;
}

export interface HttpServer {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  close(): void;
}

async function handleConnection(conn: Conn, handler: Handler, opts: ServeOptions): Promise<void> {
  const info: RequestInfo = { remoteAddress: conn.remoteAddress, remotePort: conn.remotePort };
  try {
    for (;;) {
      let req: HttpRequest | undefined;
      let res: HttpResponse;
      let keepAlive = true;
      try {
        const h = await readRequestHead(conn);
        if (!h) break;
        const body = await readBody(conn, h.headers, opts.maxBodyBytes);
        req = new HttpRequest(h, body, conn);
        keepAlive = h.version !== '1.0' && (h.headers.get('connection') ?? '').toLowerCase() !== 'close';
        if ((h.headers.get('expect') ?? '').toLowerCase() === '100-continue') {
          // body already read; nothing to do
        }
        res = await toResponse(await handler(req, info));
      } catch (e) {
        if (e instanceof HttpParseError) {
          res = status(e.status, e.message);
          keepAlive = false;
        } else {
          try {
            (opts.onError ?? ((err) => console.error('[serve]', err)))(e, req);
          } catch {
            // ignore
          }
          res = status(500, 'Internal Server Error');
        }
      }

      const headers = new Headers(res.headers);
      if (!headers.has('server')) headers.set('server', 'rn-playground');
      if (res.upgrade) {
        await conn.write(head(res.status, headers));
        await res.upgrade(conn);
        break;
      }
      const noBody = req?.method === 'HEAD' || res.status === 204 || res.status === 304 || res.status < 200;
      if (!keepAlive) headers.set('connection', 'close');
      const body = res.body;
      if (body && !(body instanceof Uint8Array)) {
        headers.delete('content-length');
        headers.set('transfer-encoding', 'chunked');
        await conn.write(head(res.status, headers));
        if (!noBody) {
          for await (const chunk of body) {
            const bytes = typeof chunk === 'string' ? utf8Encode(chunk) : chunk;
            if (!bytes.length) continue;
            await conn.write(concatBytes([utf8Encode(bytes.length.toString(16) + '\r\n'), bytes, utf8Encode('\r\n')]));
          }
        }
        await conn.write(utf8Encode('0\r\n\r\n'));
      } else {
        const bytes = body ?? new Uint8Array(0);
        if (!noBody || res.status !== 204) headers.set('content-length', String(bytes.length));
        const headBytes = head(res.status, headers);
        await conn.write(noBody ? headBytes : concatBytes([headBytes, bytes]));
      }
      if (!keepAlive) break;
    }
  } catch {
    // connection error: drop it
  } finally {
    conn.close();
  }
}

/**
 * Start an HTTP (or HTTPS) server.
 *
 *   serve(8080, (req) => ({ hello: 'world' }));
 *   serve({ port: 8443, tls: { keystore } }, handler);
 */
export async function serve(
  portOrOptions: number | ServeOptions,
  handler: Handler,
): Promise<HttpServer> {
  const opts: ServeOptions = typeof portOrOptions === 'number' ? { port: portOrOptions } : portOrOptions;
  const listener: Listener = await listen({ port: opts.port, host: opts.host, tls: opts.tls });
  (async () => {
    for await (const conn of listener) {
      void handleConnection(conn, handler, opts);
    }
  })().catch(() => {});
  const scheme = opts.tls ? 'https' : 'http';
  const server: HttpServer = {
    port: listener.port,
    host: listener.host,
    url: `${scheme}://localhost:${listener.port}`,
    close: () => listener.close(),
  };
  opts.onListen?.({ port: server.port, host: server.host, url: server.url });
  return server;
}
