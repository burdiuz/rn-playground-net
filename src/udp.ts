import { AsyncQueue } from './async-queue';
import { BytesLike, toBytes, utf8Decode } from './bytes';
import { trackResource } from './registry';

export interface RawUdpSocket {
  on(event: string, listener: (...args: any[]) => void): unknown;
  bind(port: number, address?: string, cb?: () => void): void;
  send(msg: any, offset: number, length: number, port: number, address: string, cb?: (err?: Error) => void): void;
  close(cb?: () => void): void;
  address(): { port: number; address: string; family: string };
  setBroadcast?(flag: boolean): void;
}

export interface UdpDriver {
  createSocket(options: { type: 'udp4' | 'udp6' }): RawUdpSocket;
}

let driver: UdpDriver | null = null;

export function setUdpDriver(d: UdpDriver | null): void {
  driver = d;
}

function getDriver(): UdpDriver {
  if (!driver) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-udp');
    driver = (mod.default ?? mod) as UdpDriver;
  }
  return driver;
}

export interface Datagram {
  data: Uint8Array;
  address: string;
  port: number;
  /** Payload decoded as UTF-8. */
  text(): string;
}

/** A bound UDP socket. `for await (const msg of socket)` receives datagrams. */
export class UdpSocket implements AsyncIterable<Datagram> {
  port = 0;
  private queue = new AsyncQueue<Datagram>();
  private untrack: () => void;

  constructor(private raw: RawUdpSocket) {
    raw.on('message', (data: ArrayLike<number>, info: { address: string; port: number }) => {
      const bytes = Uint8Array.from(data);
      this.queue.push({ data: bytes, address: info.address, port: info.port, text: () => utf8Decode(bytes) });
    });
    raw.on('error', (e: unknown) => this.queue.close(e instanceof Error ? e : new Error(String(e))));
    raw.on('close', () => this.queue.close());
    this.untrack = trackResource(() => this.close());
  }

  async receive(): Promise<Datagram | null> {
    const r = await this.queue.next();
    return r.done ? null : r.value;
  }

  send(data: BytesLike, port: number, address = '127.0.0.1'): Promise<void> {
    const bytes = toBytes(data);
    return new Promise((resolve, reject) => {
      try {
        this.raw.send(bytes, 0, bytes.length, port, address, (e?: Error) => (e ? reject(e) : resolve()));
      } catch (e) {
        reject(e);
      }
    });
  }

  /** Allow sending to broadcast addresses (e.g. 255.255.255.255). */
  setBroadcast(flag = true): void {
    this.raw.setBroadcast?.(flag);
  }

  close(): void {
    this.untrack();
    try {
      this.raw.close();
    } catch {
      // already closed
    }
    this.queue.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<Datagram> {
    return {
      next: async () => {
        const d = await this.receive();
        return d ? { value: d, done: false } : { value: undefined, done: true };
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

export interface UdpOptions {
  /** Port to bind; omit or 0 for an ephemeral port (client use). */
  port?: number;
  host?: string;
  type?: 'udp4' | 'udp6';
}

export function udp(options: UdpOptions = {}): Promise<UdpSocket> {
  return new Promise((resolve, reject) => {
    const raw = getDriver().createSocket({ type: options.type ?? 'udp4' });
    const sock = new UdpSocket(raw);
    let up = false;
    raw.on('error', (e: unknown) => {
      if (!up) {
        sock.close();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    raw.bind(options.port ?? 0, options.host, () => {
      up = true;
      try {
        sock.port = raw.address().port;
      } catch {
        sock.port = options.port ?? 0;
      }
      resolve(sock);
    });
  });
}
