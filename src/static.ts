import { Handler, HttpRequest, HttpResponse, html, status } from './http';

export interface FsDriver {
  stat(path: string): { isDirectory: boolean; size: number } | null;
  read(path: string): Promise<Uint8Array>;
  list(path: string): string[];
}

let fsDriver: FsDriver | null = null;

export function setFsDriver(d: FsDriver | null): void {
  fsDriver = d;
}

export function projectsRoot(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Directory, Paths } = require('expo-file-system');
  return new Directory(Paths.document, 'projects').uri;
}

function getFs(): FsDriver {
  if (fsDriver) return fsDriver;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { File, Directory } = require('expo-file-system');
  fsDriver = {
    stat(path) {
      const d = new Directory(path);
      if (d.exists) return { isDirectory: true, size: 0 };
      const f = new File(path);
      if (f.exists) return { isDirectory: false, size: f.size ?? 0 };
      return null;
    },
    async read(path) {
      return new File(path).bytes();
    },
    list(path) {
      return new Directory(path).list().map((i: { name: string }) => i.name);
    },
  };
  return fsDriver;
}

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  zip: 'application/zip',
};

export function mimeType(name: string): string {
  const i = name.lastIndexOf('.');
  return (i >= 0 && MIME[name.slice(i + 1).toLowerCase()]) || 'application/octet-stream';
}

/** Absolute `file://` URI stays; anything else is relative to the projects directory. */
function resolveRoot(root: string): string {
  const r = /^(file|content):\/\//.test(root) ? root : `${projectsRoot().replace(/\/$/, '')}/${root.replace(/^\/+/, '')}`;
  return r.replace(/\/$/, '');
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    start = Math.max(0, size - parseInt(m[2], 10));
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  return start <= end && start < size ? { start, end } : null;
}

async function sendFile(req: HttpRequest, path: string, size: number, cacheSeconds?: number): Promise<HttpResponse> {
  const bytes = await getFs().read(path);
  const headers: Record<string, string> = {
    'content-type': mimeType(path),
    'accept-ranges': 'bytes',
  };
  if (cacheSeconds !== undefined) headers['cache-control'] = `public, max-age=${cacheSeconds}`;
  const range = parseRange(req.headers.get('range'), bytes.length || size);
  if (range) {
    headers['content-range'] = `bytes ${range.start}-${range.end}/${bytes.length}`;
    return new HttpResponse(bytes.subarray(range.start, range.end + 1), { status: 206, headers });
  }
  return new HttpResponse(bytes, { headers });
}

/** Serve one file as a response: `return file('Examples/readme.md')`. */
export async function file(path: string, req?: HttpRequest): Promise<HttpResponse> {
  const full = resolveRoot(path);
  const st = getFs().stat(full);
  if (!st || st.isDirectory) return status(404, 'Not Found');
  return sendFile(req ?? ({ headers: { get: () => null } } as unknown as HttpRequest), full, st.size);
}

export interface StaticOptions {
  /** File served for directory URLs (default `index.html`; `false` disables). */
  index?: string | false;
  /** Render an HTML directory listing when no index file exists. */
  listing?: boolean;
  /** `Cache-Control: max-age` seconds. */
  maxAge?: number;
  /** Serve this file for unknown paths (single-page apps). */
  fallback?: string;
}

/**
 * Serve a directory. `root` is a `file://` URI or a path relative to the projects folder.
 * Returns `null` (→ next handler / 404) for paths that don't exist.
 */
export function staticFiles(root: string, options: StaticOptions = {}): Handler {
  const base = resolveRoot(root);
  const index = options.index === undefined ? 'index.html' : options.index;
  return async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return status(405, 'Method Not Allowed');
    const parts = req.path.split('/').filter(Boolean);
    if (parts.some((p) => p === '..' || p === '.' || p.includes('\\') || p.includes('\0'))) {
      return status(403, 'Forbidden');
    }
    const fs = getFs();
    let full = [base, ...parts].join('/');
    let st = fs.stat(full);
    if (st?.isDirectory) {
      if (!req.path.endsWith('/') && parts.length) {
        return new HttpResponse(null, { status: 301, headers: { location: req.path + '/' } });
      }
      const idx = index ? `${full}/${index}` : null;
      const ist = idx ? fs.stat(idx) : null;
      if (idx && ist && !ist.isDirectory) {
        full = idx;
        st = ist;
      } else if (options.listing) {
        const names = fs.list(full).sort();
        const dir = req.path.endsWith('/') ? req.path : req.path + '/';
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        const items = names
          .map((n) => `<li><a href="${encodeURI(dir + n)}">${esc(n)}</a></li>`)
          .join('');
        return html(`<!doctype html><meta name=viewport content="width=device-width"><h1>${esc(dir)}</h1><ul>${items}</ul>`);
      } else st = null;
    }
    if (!st && options.fallback) {
      full = `${base}/${options.fallback.replace(/^\/+/, '')}`;
      st = fs.stat(full);
    }
    if (!st || st.isDirectory) return status(404, 'Not Found');
    return sendFile(req, full, st.size, options.maxAge);
  };
}
