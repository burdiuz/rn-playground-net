---
name: rn-playground-net
description: Use when writing sockets, HTTP/WebSocket servers or static file serving for React Native with @actualwave/rn-playground-net.
---

# @actualwave/rn-playground-net

- `serve(port | {port, tls?, onError?, maxBodyBytes?}, handler)`; handler returns string / object (JSON) / `Uint8Array` /
  `HttpResponse` (`json text html status redirect stream sse`) / fetch `Response`; `null` → 404.
- `router().get/post/put/delete('/x/:id', h).use(mw).mount(prefix, handler)`, middleware `logger`, `cors()`.
- `staticFiles(dir, {index, listing, maxAge, fallback})`, `file(path)`; `dir` is a `file://` URI or relative to projects.
- `upgradeWebSocket(req, ws => …)` server side.
- `listen({port, tls?})` → loop `while ((c = await l.accept()) !== null)`; `connect({host, port, tls?})`;
  `Conn`: `read readLine readExactly readText write end close`.
- `udp({port?})` → `send(data, port, host)`, `receive()` loop.
- Never use `for await` / `async function*` (Hermes). Re-running code must call `closeAllNetResources()`.
