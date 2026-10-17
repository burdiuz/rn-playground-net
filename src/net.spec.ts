import { describe, it, expect } from '@jest/globals';
import { base64Decode, base64Encode, sha1, utf8Decode, utf8Encode } from './bytes';
import { readBody, readRequestHead, parseQuery } from './http-parser';
import { setTcpDriver, TcpDriver, RawSocket, RawServer } from './tcp-native';
import { serve, json, text, sse } from './http';
import { router } from './router';
import { connect } from './tcp';

describe('bytes', () => {
  it('round-trips utf8 incl. astral chars', () => {
    const s = 'héllo ✓ 😀';
    expect(utf8Decode(utf8Encode(s))).toBe(s);
  });
  it('base64 round-trips', () => {
    const b = Uint8Array.from([0, 1, 2, 250, 255]);
    expect(Array.from(base64Decode(base64Encode(b)))).toEqual(Array.from(b));
    expect(base64Encode(utf8Encode('Man'))).toBe('TWFu');
  });
  it('sha1 matches known vector', () => {
    const hex = Array.from(sha1(utf8Encode('abc'))).map((x) => x.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });
});

describe('http parser', () => {
  const reader = (s: string) => {
    let bytes = utf8Encode(s);
    return {
      async readLine() {
        if (!bytes.length) return null;
        let i = bytes.indexOf(10);
        if (i < 0) i = bytes.length;
        const line = utf8Decode(bytes.subarray(0, i)).replace(/\r$/, '');
        bytes = bytes.subarray(i + 1);
        return line;
      },
      async readExactly(n: number) {
        const o = bytes.subarray(0, n);
        bytes = bytes.subarray(n);
        return o;
      },
    };
  };
  it('parses head and content-length body', async () => {
    const r = reader('POST /a?x=1 HTTP/1.1\r\nHost: h\r\nContent-Length: 3\r\n\r\nabc');
    const h = await readRequestHead(r);
    expect(h?.method).toBe('POST');
    expect(h?.headers.get('HOST')).toBe('h');
    expect(utf8Decode(await readBody(r, h!.headers))).toBe('abc');
  });
  it('parses chunked body', async () => {
    const r = reader('POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n');
    const h = await readRequestHead(r);
    expect(utf8Decode(await readBody(r, h!.headers))).toBe('abcde');
  });
  it('parses query strings', () => {
    expect(parseQuery('a=1&b=x%20y&c')).toEqual({ a: '1', b: 'x y', c: '' });
  });
});

// In-memory TCP driver: connecting to a listening port wires two fake sockets together.
function memoryDriver(): TcpDriver {
  const servers = new Map<number, (s: RawSocket) => void>();
  const mk = () => {
    const l: Record<string, ((...a: any[]) => void)[]> = {};
    const emit = (e: string, ...a: any[]) => (l[e] ?? []).forEach((f) => f(...a));
    return {
      peer: null as any,
      on(e: string, f: (...a: any[]) => void) {
        (l[e] ??= []).push(f);
      },
      emit,
      write(d: Uint8Array, _e: any, cb?: () => void) {
        const copy = Uint8Array.from(d);
        setTimeout(() => this.peer.emit('data', copy), 0);
        cb?.();
      },
      end() {
        setTimeout(() => this.peer.emit('close'), 0);
      },
      destroy() {
        setTimeout(() => {
          emit('close');
          this.peer?.emit('close');
        }, 0);
      },
    };
  };
  return {
    createServer(onConn) {
      const srv: RawServer & { port: number } = {
        port: 0,
        on() {},
        listen(o, cb) {
          srv.port = o.port;
          servers.set(o.port, onConn!);
          setTimeout(() => cb?.(), 0);
        },
        close() {
          servers.delete(srv.port);
        },
        address: () => ({ port: srv.port, address: '0.0.0.0', family: 'IPv4' }),
      };
      return srv;
    },
    createTLSServer() {
      throw new Error('n/a');
    },
    createConnection(o, onConnect) {
      const a = mk();
      const b = mk();
      a.peer = b;
      b.peer = a;
      setTimeout(() => {
        servers.get(o.port as number)!(b as any);
        onConnect();
      }, 0);
      return a as any;
    },
  };
}

describe('serve over in-memory transport', () => {
  it('routes requests and returns json', async () => {
    setTcpDriver(memoryDriver());
    const app = router()
      .get('/hi/:name', (req) => json({ hi: req.params.name }))
      .post('/echo', (req) => text(req.text()));
    const server = await serve(9000, app);
    const c = await connect({ host: 'x', port: 9000 });
    await c.write('GET /hi/bob HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(await c.readLine()).toBe('HTTP/1.1 200 OK');
    let line: string | null;
    let len = 0;
    while ((line = await c.readLine()) !== '') {
      if (/^content-length/i.test(line!)) len = parseInt(line!.split(':')[1], 10);
    }
    expect(utf8Decode(await c.readExactly(len))).toBe('{"hi":"bob"}');

    await c.write('POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    expect(await c.readLine()).toBe('HTTP/1.1 200 OK');
    c.close();
    server.close();
    setTcpDriver(null);
  });

  it('streams sse from a producer function', async () => {
    setTcpDriver(memoryDriver());
    const server = await serve(9001, () =>
      sse(async (send) => {
        send({ event: 'tick', data: { i: 1 } });
        send('bye');
      }),
    );
    const c = await connect({ host: 'x', port: 9001 });
    await c.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    let all = '';
    let chunk: Uint8Array | null;
    while ((chunk = await c.read()) !== null) all += utf8Decode(chunk);
    expect(all).toContain('text/event-stream');
    expect(all).toContain('event: tick');
    expect(all).toContain('data: {"i":1}');
    expect(all).toContain('data: bye');
    c.close();
    server.close();
    setTcpDriver(null);
  });
});
