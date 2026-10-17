/**
 * `@actualwave/rn-playground-net` — sockets and servers for playground code.
 *
 *   import { serve, router, json } from '@actualwave/rn-playground-net';
 *   serve(8080, (req) => json({ hi: req.query.name ?? 'world' }));
 */
export { connect, listen, Conn, Listener } from './tcp';
export type { ConnectOptions, ListenOptions } from './tcp';
export { udp, UdpSocket } from './udp';
export type { Datagram, UdpOptions } from './udp';
export {
  serve,
  Headers,
  HttpRequest,
  HttpResponse,
  text,
  html,
  json,
  status,
  redirect,
  stream,
  sse,
} from './http';
export type { Handler, HandlerResult, ServeOptions, HttpServer, ResponseInit } from './http';
export { router, logger, cors } from './router';
export type { Router, Middleware } from './router';
export { staticFiles, file, projectsRoot, mimeType } from './static';
export type { StaticOptions } from './static';
export { upgradeWebSocket, WebSocketConn } from './websocket';
export type { WsMessage } from './websocket';
export { utf8Encode, utf8Decode, base64Encode, base64Decode } from './bytes';
export { closeAllNetResources, onNetActivity } from './registry';
