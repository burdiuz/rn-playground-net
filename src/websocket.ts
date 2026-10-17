import { AsyncQueue } from './async-queue';
import { base64Encode, BytesLike, concatBytes, sha1, toBytes, utf8Decode, utf8Encode } from './bytes';
import { HttpRequest, HttpResponse, status } from './http';
import { Conn } from './tcp';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export type WsMessage = { type: 'text'; data: string } | { type: 'binary'; data: Uint8Array };

function frame(opcode: number, payload: Uint8Array): Uint8Array {
  const n = payload.length;
  let hdr: number[];
  if (n < 126) hdr = [0x80 | opcode, n];
  else if (n < 65536) hdr = [0x80 | opcode, 126, n >> 8, n & 0xff];
  else hdr = [0x80 | opcode, 127, 0, 0, 0, 0, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return concatBytes([Uint8Array.from(hdr), payload]);
}

/** An accepted WebSocket (server side). */
export class WebSocketConn implements AsyncIterable<WsMessage> {
  private queue = new AsyncQueue<WsMessage>();
  private _open = true;

  constructor(private conn: Conn) {
    void this.pump();
  }

  get open(): boolean {
    return this._open;
  }

  private async pump(): Promise<void> {
    let fragOpcode = 0;
    let frags: Uint8Array[] = [];
    try {
      for (;;) {
        const h = await this.conn.readExactly(2);
        if (h.length < 2) break;
        const fin = (h[0] & 0x80) !== 0;
        const opcode = h[0] & 0x0f;
        const masked = (h[1] & 0x80) !== 0;
        let len = h[1] & 0x7f;
        if (len === 126) {
          const e = await this.conn.readExactly(2);
          len = (e[0] << 8) | e[1];
        } else if (len === 127) {
          const e = await this.conn.readExactly(8);
          len = e[4] * 0x1000000 + ((e[5] << 16) | (e[6] << 8) | e[7]);
        }
        const mask = masked ? await this.conn.readExactly(4) : null;
        const payload = len ? await this.conn.readExactly(len) : new Uint8Array(0);
        if (payload.length < len) break;
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

        if (opcode === 0x8) {
          await this.conn.write(frame(0x8, payload.subarray(0, 2))).catch(() => {});
          break;
        } else if (opcode === 0x9) {
          await this.conn.write(frame(0xa, payload)).catch(() => {});
        } else if (opcode === 0xa) {
          // pong: ignore
        } else {
          if (opcode !== 0) {
            fragOpcode = opcode;
            frags = [];
          }
          frags.push(payload);
          if (fin) {
            const data = concatBytes(frags);
            this.queue.push(fragOpcode === 1 ? { type: 'text', data: utf8Decode(data) } : { type: 'binary', data });
            frags = [];
          }
        }
      }
    } catch {
      // connection dropped
    }
    this._open = false;
    this.queue.close();
    this.conn.close();
  }

  async send(data: string | BytesLike): Promise<void> {
    if (!this._open) throw new Error('WebSocket closed');
    await this.conn.write(frame(typeof data === 'string' ? 1 : 2, typeof data === 'string' ? utf8Encode(data) : toBytes(data)));
  }

  /** Send a value as JSON text. */
  sendJson(value: unknown): Promise<void> {
    return this.send(JSON.stringify(value));
  }

  async receive(): Promise<WsMessage | null> {
    const r = await this.queue.next();
    return r.done ? null : r.value;
  }

  async close(code = 1000): Promise<void> {
    if (this._open) {
      this._open = false;
      await this.conn.write(frame(0x8, Uint8Array.from([code >> 8, code & 0xff]))).catch(() => {});
    }
    this.conn.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<WsMessage> {
    return {
      next: async () => {
        const m = await this.receive();
        return m ? { value: m, done: false } : { value: undefined, done: true };
      },
    };
  }
}

/**
 * Upgrade a request to a WebSocket.
 *
 *   router.get('/ws', (req) => upgradeWebSocket(req, async (ws) => {
 *     for await (const m of ws) await ws.send(m.data);
 *   }));
 */
export function upgradeWebSocket(req: HttpRequest, onSocket: (ws: WebSocketConn) => void | Promise<void>): HttpResponse {
  const key = req.headers.get('sec-websocket-key');
  if (!key || (req.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
    return status(400, 'WebSocket upgrade required');
  }
  const res = new HttpResponse(null, {
    status: 101,
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-accept': base64Encode(sha1(utf8Encode(key + GUID))),
    },
  });
  res.upgrade = async (conn) => {
    const ws = new WebSocketConn(conn);
    try {
      await onSocket(ws);
    } finally {
      await ws.close();
    }
  };
  return res;
}
