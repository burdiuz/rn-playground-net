# @actualwave/rn-playground-net

Networking layer used by React Native Playground: TCP/UDP sockets, an HTTP/1.1 server (keep-alive, chunked, SSE),
WebSocket server, router, static files. Web-standard-ish API on `Uint8Array` and promises — no `Buffer`, no Node streams.

```js
import { serve, router, json } from '@actualwave/rn-playground-net';

const r = router().get('/hello/:name', (req) => json({ hi: req.params.name }));
serve(8080, r);
```

Native drivers are loaded lazily with `require()`:

| Feature | Module |
| --- | --- |
| TCP / HTTP / WebSocket | `react-native-tcp-socket` |
| UDP | `react-native-udp` |
| `staticFiles`, `file`, `projectsRoot` | `expo-file-system` (v55 class API) |

Drivers are injectable (`setTcpDriver`, `setUdpDriver`, `setFsDriver`) for tests; `closeAllNetResources()` frees every
listener/socket, `onNetActivity(cb)` reports the open-resource count.

Hermes cannot compile `async function*` / `for await`: every source is loop-friendly — `accept()`, `receive()` and
`readLine()` return `null` at the end.

## Build

`npm run build` → `dist/` (CJS + ES + `types/`, plus LICENSE/README/SKILL/package.json).
