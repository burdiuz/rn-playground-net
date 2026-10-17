import { Handler, HandlerResult, HttpRequest, HttpResponse, RequestInfo, status, toResponse } from './http';

export type Next = () => Promise<HttpResponse>;
export type Middleware = (req: HttpRequest, next: Next, info: RequestInfo) => HandlerResult | Promise<HandlerResult>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p === '*') {
      params['*'] = parts.slice(i).join('/');
      return params;
    }
    if (i >= parts.length) return null;
    if (p.startsWith(':')) params[p.slice(1)] = parts[i];
    else if (p !== parts[i]) return null;
  }
  return pattern.length === parts.length ? params : null;
}

/** A callable request handler with Express/Hono-style routing. */
export interface Router extends Handler {
  get(path: string, handler: Handler): Router;
  post(path: string, handler: Handler): Router;
  put(path: string, handler: Handler): Router;
  patch(path: string, handler: Handler): Router;
  delete(path: string, handler: Handler): Router;
  all(path: string, handler: Handler): Router;
  /** Add a middleware `(req, next) => response`. Runs in registration order, before routes. */
  use(mw: Middleware): Router;
  /** Mount a handler (router, `staticFiles(...)`) under a prefix. */
  mount(prefix: string, handler: Handler): Router;
  /** Fallback when nothing matches (default 404). */
  notFound(handler: Handler): Router;
}

export function router(): Router {
  const routes: Route[] = [];
  const middlewares: Middleware[] = [];
  let fallback: Handler | null = null;

  const dispatch: Handler = async (req, info) => {
    const parts = split(req.path);
    let methodMismatch = false;
    for (const r of routes) {
      const params = matchSegments(r.segments, parts);
      if (!params) continue;
      if (r.method !== '*' && r.method !== req.method && !(req.method === 'HEAD' && r.method === 'GET')) {
        methodMismatch = true;
        continue;
      }
      req.params = params;
      return r.handler(req, info);
    }
    if (fallback) return fallback(req, info);
    return methodMismatch ? status(405, 'Method Not Allowed') : status(404, 'Not Found');
  };

  const run: Handler = async (req, info) => {
    let i = 0;
    const next: Next = async () => {
      const mw = middlewares[i++];
      if (!mw) return toResponse(await dispatch(req, info));
      return toResponse(await mw(req, next, info));
    };
    return next();
  };

  const self = run as Router;
  const add = (method: string) => (path: string, handler: Handler) => {
    routes.push({ method, segments: split(path), handler });
    return self;
  };
  self.get = add('GET');
  self.post = add('POST');
  self.put = add('PUT');
  self.patch = add('PATCH');
  self.delete = add('DELETE');
  self.all = add('*');
  self.use = (mw) => {
    middlewares.push(mw);
    return self;
  };
  self.mount = (prefix, handler) => {
    const pre = split(prefix);
    routes.push({
      method: '*',
      segments: [...pre, '*'],
      handler: (req, info) => {
        const rest = '/' + (req.params['*'] ?? '');
        const sub = Object.create(req) as HttpRequest;
        Object.defineProperty(sub, 'path', { value: rest });
        return handler(sub, info);
      },
    });
    // also match the bare prefix
    routes.push({
      method: '*',
      segments: pre,
      handler: (req, info) => {
        const sub = Object.create(req) as HttpRequest;
        Object.defineProperty(sub, 'path', { value: '/' });
        return handler(sub, info);
      },
    });
    return self;
  };
  self.notFound = (h) => {
    fallback = h;
    return self;
  };
  return self;
}

// ---- common middleware -----------------------------------------------------------------------

/** Logs `METHOD path -> status (ms)` to console. */
export const logger: Middleware = async (req, next) => {
  const t = Date.now();
  const res = await next();
  console.log(`${req.method} ${req.path} -> ${res.status} (${Date.now() - t}ms)`);
  return res;
};

/** Adds permissive CORS headers and answers preflight requests. */
export const cors =
  (origin = '*'): Middleware =>
  async (req, next) => {
    if (req.method === 'OPTIONS') {
      return new HttpResponse(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers': req.headers.get('access-control-request-headers') ?? '*',
        },
      });
    }
    const res = await next();
    res.headers.set('access-control-allow-origin', origin);
    return res;
  };
