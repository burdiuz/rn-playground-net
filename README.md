# @actualwave/rn-playground-net

Networking layer used by React Native Playground (an Android app for
running React Native code on-device): TCP/UDP sockets, an HTTP/1.1 server (keep-alive, chunked, SSE), a WebSocket
server, a router and static file serving.

The API is web-standard-ish: `Uint8Array` and promises. No `Buffer`, no Node streams.

```sh
npm install @actualwave/rn-playground-net
npm install react-native-tcp-socket   # TCP, HTTP, WebSocket
npm install react-native-udp          # UDP only
npm install expo-file-system          # staticFiles / file / projectsRoot only
```

All three native modules are **optional peer dependencies**; each is loaded lazily with `require()` the first time the
matching feature is used.

| Feature | Native module |
| --- | --- |
| `connect`, `listen`, `serve`, `upgradeWebSocket` | `react-native-tcp-socket` |
| `udp` | `react-native-udp` |
| `staticFiles`, `file`, `projectsRoot` | `expo-file-system` (v55 class API: `File`, `Directory`, `Paths`) |

## Hermes: no `for await`, no `async function*`

Hermes cannot compile async generators or `for await` in user code. Every source in this library therefore has a
loop-friendly method that resolves to **`null` at the end of the stream**:

```js
let conn;
while ((conn = await listener.accept()) !== null) { /* ... */ }
```

The classes also implement `Symbol.asyncIterator`, so `for await` works wherever your toolchain supports it — but the
examples below use `while` loops so they run everywhere.

## Quick start

```js
import { serve, router, json, logger, closeAllNetResources } from '@actualwave/rn-playground-net';

closeAllNetResources(); // release ports left by a previous run

const app = router()
  .use(logger)
  .get('/hello/:name', (req) => json({ hi: req.params.name }));

const server = await serve(8080, app);
console.log(server.url); // http://localhost:8080
```

`serve()` returns a promise that resolves once the port is bound (and rejects if it can't be, e.g. address in use).

## HTTP server

```js
const server = await serve(port | options, handler);
server.close();
```

Options (`ServeOptions`):

| Option | Meaning |
| --- | --- |
| `port` | Port to listen on (required in the object form). |
| `host` | Interface, default `0.0.0.0`. |
| `tls` | `{ keystore: 'file:///…/server.p12' }` — PKCS12 keystore, **empty password only**. Serves HTTPS. |
| `maxBodyBytes` | Maximum request body, default 32 MiB. Larger bodies get `413`. |
| `onError(error, req?)` | Called when a handler throws (default: `console.error`). The client gets `500`. |
| `onListen({port, host, url})` | Called once listening. |

The returned `HttpServer` has `port`, `host`, `url` and `close()`.

### Handlers and what they may return

A handler is `(req, info) => result` (sync or async), where `info` is `{ remoteAddress, remotePort }`.

| Returned value | Response |
| --- | --- |
| `HttpResponse` (from `json`, `text`, `html`, `status`, `redirect`, `stream`, `sse`, or `new HttpResponse(...)`) | Sent as is. |
| `string` | `text/html` if it starts with `<`, otherwise `text/plain`. |
| `Uint8Array` / `ArrayBuffer` | `application/octet-stream`. |
| plain object / array | JSON. |
| number / boolean | `text/plain` of `String(value)`. |
| a fetch `Response` | Status, headers and body are copied. |
| `null` / `undefined` | `404 Not Found`. |

A thrown error produces `500` (and calls `onError`). Malformed requests produce `400`/`413`/`414`/`431` automatically.
Connections are keep-alive unless the client asks otherwise or speaks HTTP/1.0. `HEAD` requests get headers only.

### Request

`HttpRequest` fields:

| Member | Description |
| --- | --- |
| `method`, `url`, `path` | `url` is the raw target (`/a?x=1`); `path` is decoded and has no query. |
| `query` | Parsed query string, `Record<string,string>`. |
| `params` | Route parameters filled in by the router (`/users/:id`). |
| `headers` | Case-insensitive `Headers` (`get`, `has`, `set`, `append`, `delete`, `forEach`, `entries`, `toObject`). |
| `cookies` | Parsed `Cookie` header. |
| `host`, `remoteAddress`, `remotePort` | Connection info. |
| `state` | Free-form bag for middleware to pass data along. |
| `text()`, `json()`, `form()`, `bytes()` | Body readers (the body is already fully read; these are synchronous). `form()` parses `application/x-www-form-urlencoded`. |

### Response helpers

```js
text('hi')                              // text/plain
html('<h1>hi</h1>')                     // text/html
json({ ok: true }, { status: 201 })     // application/json
status(404, 'nope')                     // status + body
redirect('/login', 303)                 // default 302
new HttpResponse(bytes, { status: 200, headers: { 'x-a': '1' } })
```

All helpers take an optional `init` of `{ status, headers }`; a `content-type` you set yourself is kept.

### Streaming and Server-Sent Events

`stream()` and `sse()` accept an async iterable **or** a producer function `(send) => Promise<void>`. `send(x)` returns
`false` once the client is gone, so stop producing. The response ends when the producer's promise settles.

```js
app.get('/clock', () =>
  sse(async (send) => {
    for (let i = 0; i < 10; i++) {
      if (!send({ event: 'tick', data: { i }, id: String(i) })) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }),
);

app.get('/big', () =>
  stream(async (send) => {
    send('chunk 1\n');
    send(new Uint8Array([1, 2, 3]));
  }, { headers: { 'content-type': 'text/plain' } }),
);
```

In `sse()`, a plain string is sent as `data: …`, other values are JSON-encoded, and `{ event, data, id }` objects become
named events. Streamed responses use chunked transfer encoding.

## Router

```js
const app = router()
  .use(logger)                     // middleware, runs in registration order
  .use(cors())                     // cors('https://example.com') to restrict the origin
  .get('/users/:id', (req) => json({ id: req.params.id }))
  .post('/users', (req) => status(201, JSON.stringify(req.json())))
  .put('/x', h).patch('/x', h).delete('/x', h)
  .all('/any', h)                  // every method
  .get('/files/*', (req) => req.params['*'])   // wildcard: rest of the path
  .mount('/static', staticFiles('my-site'))    // handler under a prefix
  .notFound(() => html('<h1>Not here</h1>'));
```

- A router is itself a handler, so it can be passed to `serve()` or `mount()`ed into another router.
- Routes match in registration order. `GET` routes also answer `HEAD`.
- If a path matches but the method doesn't: `405`; if nothing matches: `404` (or your `notFound` handler).
- Middleware signature: `(req, next, info) => result`. Call `await next()` to get the downstream `HttpResponse`; modify
  it or return something else.

```js
const auth = async (req, next) => {
  if (req.headers.get('authorization') !== 'Bearer secret') return status(401);
  req.state.user = 'me';
  return next();
};
```

- Built-in middleware: `logger` (`GET /x -> 200 (3ms)`) and `cors(origin = '*')` (adds the header and answers `OPTIONS`
  preflight with `204`).

## Static files

```js
app.mount('/', staticFiles('MySite', { index: 'index.html', listing: true, maxAge: 3600 }));
return file('Examples/readme.md', req);   // one file, inside a handler
```

`root` is either an absolute `file://` (or `content://`) URI, or a path **relative to the projects directory**
(`projectsRoot()` = `<documents>/projects`).

| Option | Meaning |
| --- | --- |
| `index` | File served for directory URLs. Default `index.html`; `false` disables. |
| `listing` | Render an HTML directory listing when there is no index file. |
| `maxAge` | Adds `Cache-Control: public, max-age=N`. |
| `fallback` | File served for unknown paths (single-page apps). |

Features: MIME types by extension (`mimeType(name)` is exported), `Range` requests (`206`), redirects `/dir` → `/dir/`,
`403` for `..` path traversal, `405` for non-GET/HEAD, `404` for missing files. `file(path, req?)` is async and
resolves to a `404` response if the file is missing; pass `req` to enable `Range`.

## WebSocket server

```js
app.get('/ws', (req) =>
  upgradeWebSocket(req, async (ws) => {
    await ws.sendJson({ hello: true });
    let m;
    while ((m = await ws.receive()) !== null) {
      // m is { type: 'text', data: string } or { type: 'binary', data: Uint8Array }
      if (m.type === 'text') await ws.send(m.data.toUpperCase());
      else await ws.send(m.data);
    }
  }),
);
```

`upgradeWebSocket(req, onSocket)` returns `400` if the request isn't a WebSocket upgrade. The socket is closed when
`onSocket` returns. `WebSocketConn` members: `send(string | bytes)` (string → text frame, bytes → binary frame),
`sendJson(value)`, `receive()`, `close(code = 1000)`, `open`. Ping frames are answered automatically and fragmented
messages are reassembled. There is no WebSocket *client*.

## TCP

Server:

```js
const listener = await listen({ port: 9000 });   // also { host, tls: { keystore } }
console.log(listener.port);

let conn;
while ((conn = await listener.accept()) !== null) {
  void (async () => {                              // handle each connection concurrently
    let line;
    while ((line = await conn.readLine()) !== null) await conn.write(`echo: ${line}\n`);
    conn.close();
  })();
}
```

Client:

```js
const conn = await connect({ host: '192.168.1.5', port: 9000, timeoutMs: 5000 }); // tls: true | { ca }
await conn.write('hello\n');
console.log(await conn.readLine());
conn.close();
```

`Conn` members:

| Member | Behaviour |
| --- | --- |
| `read()` | Next chunk of bytes, `null` when the peer closed. |
| `readLine()` | Up to `\n` (a trailing `\r` is removed); `null` at the end. |
| `readExactly(n)` | Exactly `n` bytes; fewer only if the stream ended first. |
| `readText()` | Everything remaining, decoded as UTF-8. |
| `write(data)` | Accepts string, `Uint8Array`, `ArrayBuffer` or number array. Rejects if closed. |
| `end()` | Half-close (send FIN). |
| `close()` | Destroy the socket. |
| `closed`, `remoteAddress`, `remotePort` | State and peer info. |

`Listener` has `accept()`, `close()`, `port` and `host`. TLS servers need a PKCS12 keystore with an empty password.

## UDP

```js
const sock = await udp({ port: 5000 });          // omit port for an ephemeral, client-side socket
sock.setBroadcast(true);                          // optional
await sock.send('ping', 5000, '192.168.1.255');  // address defaults to 127.0.0.1

let msg;
while ((msg = await sock.receive()) !== null) {
  console.log(msg.address, msg.port, msg.text()); // msg.data is the raw Uint8Array
}
sock.close();
```

Options: `{ port?, host?, type?: 'udp4' | 'udp6' }`. `sock.port` holds the bound port.

## Byte helpers

`utf8Encode(str)`, `utf8Decode(bytes)`, `base64Encode(bytes)`, `base64Decode(str)` — they work without `Buffer`,
`TextEncoder` or `atob`/`btoa`.

## Cleaning up between runs

Every listener, connection and UDP socket registers itself. When code is re-run (or a screen is left), free all ports:

```js
import { closeAllNetResources, onNetActivity } from '@actualwave/rn-playground-net';

closeAllNetResources();                              // closes everything that is still open
const off = onNetActivity((count) => console.log(count, 'open resources'));
off();                                               // unsubscribe
```

Without this, re-running a server script fails with "address in use".

## Testing

The native modules are accessed through small structural interfaces (`TcpDriver`, `UdpDriver`, `FsDriver`), and the
library's own tests drive the full HTTP stack over an in-memory transport. Run them with `npm test`.

## Build

`npm run build` → `dist/` (cleaned first): CJS (`index.cjs`) + ES (`index.es.js`) + `types/`, plus
LICENSE/README/SKILL/package.json.

## License

MIT
