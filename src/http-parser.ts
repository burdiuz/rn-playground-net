import { concatBytes, utf8Decode } from './bytes';

/** What the parser needs from a connection. `Conn` satisfies this. */
export interface ByteReader {
  readLine(): Promise<string | null>;
  readExactly(n: number): Promise<Uint8Array>;
}

/** Case-insensitive header bag (Fetch `Headers`-shaped, without needing the global). */
export class Headers {
  private map = new Map<string, { name: string; value: string }>();

  constructor(init?: Record<string, string | number | string[]> | Headers | [string, string][]) {
    if (!init) return;
    if (init instanceof Headers) init.forEach((v, k) => this.set(k, v));
    else if (Array.isArray(init)) init.forEach(([k, v]) => this.append(k, v));
    else
      for (const k of Object.keys(init)) {
        const v = init[k];
        this.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      }
  }

  get(name: string): string | null {
    return this.map.get(name.toLowerCase())?.value ?? null;
  }
  has(name: string): boolean {
    return this.map.has(name.toLowerCase());
  }
  set(name: string, value: string | number): this {
    this.map.set(name.toLowerCase(), { name, value: String(value) });
    return this;
  }
  append(name: string, value: string | number): this {
    const cur = this.map.get(name.toLowerCase());
    return this.set(name, cur ? `${cur.value}, ${value}` : String(value));
  }
  delete(name: string): void {
    this.map.delete(name.toLowerCase());
  }
  forEach(fn: (value: string, name: string) => void): void {
    this.map.forEach((e) => fn(e.value, e.name));
  }
  entries(): [string, string][] {
    return Array.from(this.map.values()).map((e) => [e.name, e.value]);
  }
  toObject(): Record<string, string> {
    const o: Record<string, string> = {};
    this.map.forEach((e, k) => (o[k] = e.value));
    return o;
  }
}

export interface RequestHead {
  method: string;
  target: string;
  version: string;
  headers: Headers;
}

export class HttpParseError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const MAX_HEADER_LINES = 100;
const MAX_LINE = 16 * 1024;

/** Reads a request head. `null` when the peer closed before sending anything. */
export async function readRequestHead(r: ByteReader): Promise<RequestHead | null> {
  let line = await r.readLine();
  while (line === '') line = await r.readLine(); // tolerate stray CRLF between requests
  if (line === null) return null;
  if (line.length > MAX_LINE) throw new HttpParseError('Request line too long', 414);
  const m = /^([A-Za-z]+)\s+(\S+)\s+HTTP\/(\d\.\d)$/.exec(line);
  if (!m) throw new HttpParseError('Malformed request line');
  const headers = new Headers();
  for (let i = 0; ; i++) {
    const h = await r.readLine();
    if (h === null) throw new HttpParseError('Unexpected end of headers');
    if (h === '') break;
    if (i >= MAX_HEADER_LINES || h.length > MAX_LINE) throw new HttpParseError('Headers too large', 431);
    const c = h.indexOf(':');
    if (c <= 0) throw new HttpParseError('Malformed header');
    headers.append(h.slice(0, c).trim(), h.slice(c + 1).trim());
  }
  return { method: m[1].toUpperCase(), target: m[2], version: m[3], headers };
}

/** Reads a request body per Content-Length / chunked encoding. */
export async function readBody(r: ByteReader, headers: Headers, maxBytes = 32 * 1024 * 1024): Promise<Uint8Array> {
  const te = (headers.get('transfer-encoding') ?? '').toLowerCase();
  if (te.includes('chunked')) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const sizeLine = await r.readLine();
      if (sizeLine === null) throw new HttpParseError('Unexpected end of chunked body');
      const size = parseInt(sizeLine.split(';')[0].trim(), 16);
      if (Number.isNaN(size)) throw new HttpParseError('Bad chunk size');
      if (size === 0) {
        // trailers until blank line
        for (;;) {
          const t = await r.readLine();
          if (t === null || t === '') break;
        }
        break;
      }
      total += size;
      if (total > maxBytes) throw new HttpParseError('Payload too large', 413);
      chunks.push(await r.readExactly(size));
      await r.readLine();
    }
    return chunks.length ? concatBytes(chunks) : new Uint8Array(0);
  }
  const len = parseInt(headers.get('content-length') ?? '0', 10);
  if (!len) return new Uint8Array(0);
  if (len > maxBytes) throw new HttpParseError('Payload too large', 413);
  const body = await r.readExactly(len);
  if (body.length < len) throw new HttpParseError('Unexpected end of body');
  return body;
}

export function parseQuery(qs: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!qs) return out;
  for (const part of qs.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const dec = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
      } catch {
        return s;
      }
    };
    const k = dec(i < 0 ? part : part.slice(0, i));
    if (!(k in out)) out[k] = i < 0 ? '' : dec(part.slice(i + 1));
  }
  return out;
}

export function decodeBody(bytes: Uint8Array): string {
  return utf8Decode(bytes);
}
