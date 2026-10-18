---
name: rn-playground-net
description: Use when writing TCP/UDP sockets, HTTP or WebSocket servers, routers or static file serving in React Native Playground code, with @actualwave/rn-playground-net.
---

# @actualwave/rn-playground-net

Networking for React Native on Hermes. Uint8Array + promises; no `Buffer`, no Node streams, no `fetch`-style server.
Native modules (`react-native-tcp-socket`, `react-native-udp`, `expo-file-system`) are optional peers loaded lazily.

## Hard rules

1. **Never use `for await` or `async function*`** — Hermes cannot compile them. Use `while ((x = await source.accept()) !== null)`
   style loops: `accept()`, `receive()`, `read()` and `readLine()` return `null` at the end.
2. **Call `closeAllNetResources()` at the start of any script that opens a listener/socket**, or re-running fails with
   "address in use".
3. `serve()`, `listen()`, `connect()` and `udp()` are **async** — `await` them.
4. Passwords for TLS keystores must be empty (PKCS12 `file://` URI).

## HTTP server

```js
import { serve, router, json, text, html, status, redirect, sse, stream, logger, cors,
         staticFiles, file, upgradeWebSocket, closeAllNetResources } from '@actualwave/rn-playground-net';

closeAllNetResources();
const app = router()
  .use(logger).use(cors())
  .get('/users/:id', (req) => json({ id: req.params.id, q: req.query }))
  .post('/users', (req) => json(req.json(), { status: 201 }))   // req.text() req.form() req.bytes()
  .get('/files/*', (req) => req.params['*'])
  .mount('/site', staticFiles('MySite', { listing: true }))
  .notFound(() => status(404, 'nope'));
const server = await serve(8080, app);     // or serve({ port, host, tls, maxBodyBytes, onError }, app)
// server.url, server.close()
```

- Handler `(req, info) => result`. Result may be: `HttpResponse`, string (html if it starts with `<`, else text),
  `Uint8Array`, plain object/array (JSON), number/boolean, fetch `Response`; `null`/`undefined` → 404. Throw → 500.
- `req`: `method url path query params headers cookies host remoteAddress state` + `text() json() form() bytes()`
  (sync, body is pre-read). `req.headers` is case-insensitive (`get has set append delete`).
- Helpers: `text html json status(code, body) redirect(url, code=302)`, `new HttpResponse(body, {status, headers})`.
- Middleware: `(req, next) => { ...; return next(); }`. `next()` resolves to the downstream `HttpResponse`.
- Router: `get post put patch delete all use mount notFound`. `:param`, trailing `*` wildcard. Wrong method → 405.

## Streaming / SSE (producer form, no generators)

```js
app.get('/events', () => sse(async (send) => {
  for (let i = 0; i < 5; i++) {
    if (!send({ event: 'tick', data: { i } })) return;   // false = client gone
    await new Promise((r) => setTimeout(r, 1000));
  }
}));
app.get('/dump', () => stream(async (send) => { send('part 1'); send(new Uint8Array([1])); }));
```

## WebSocket (server only)

```js
app.get('/ws', (req) => upgradeWebSocket(req, async (ws) => {
  let m;
  while ((m = await ws.receive()) !== null) {      // { type: 'text'|'binary', data }
    await ws.send(m.type === 'text' ? m.data.toUpperCase() : m.data);   // also ws.sendJson(v)
  }
}));   // socket closes when the callback returns; ws.close(code=1000)
```

## Static files

`staticFiles(root, { index='index.html'|false, listing, maxAge, fallback })` — `root` is a `file://` URI or a path
relative to the projects dir (`projectsRoot()`). Handles Range, `..` traversal (403), `/dir` → `/dir/` redirect.
`await file('Examples/a.md', req?)` serves a single file (404 if missing).

## TCP

```js
const l = await listen({ port: 9000 });            // { host?, tls?: { keystore } }
let c;
while ((c = await l.accept()) !== null) {
  void (async () => {
    let line;
    while ((line = await c.readLine()) !== null) await c.write('echo ' + line + '\n');
    c.close();
  })();                                            // one task per connection
}
const conn = await connect({ host, port, tls?, timeoutMs? });
```

`Conn`: `read()` (chunk|null), `readLine()`, `readExactly(n)`, `readText()`, `write(str|bytes)`, `end()`, `close()`,
`closed`, `remoteAddress`, `remotePort`. `Listener`: `accept() close() port host`.

## UDP

```js
const s = await udp({ port: 5000 });               // omit port → ephemeral client socket
await s.send('hi', 5000, '127.0.0.1');             // s.setBroadcast(true) for 255.255.255.255
let d; while ((d = await s.receive()) !== null) console.log(d.address, d.port, d.text());  // d.data = bytes
```

## Utilities

`utf8Encode utf8Decode base64Encode base64Decode` (no `Buffer`/`TextEncoder`/`atob` needed),
`mimeType(name)`, `projectsRoot()`, `closeAllNetResources()`, `onNetActivity(cb) → unsubscribe` (open-resource count).

## Pitfalls

- Forgetting `await` on `serve`/`listen` — the port isn't bound yet and errors are lost.
- Forgetting to handle each TCP connection in its own task — the accept loop blocks on the first client.
- Request bodies over 32 MiB (`maxBodyBytes`) get 413.
- No WebSocket client, no HTTP client — use `fetch` for outgoing HTTP.
