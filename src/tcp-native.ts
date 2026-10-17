/** Minimal structural view of react-native-tcp-socket, so the rest of the layer is testable with fakes. */
export interface RawSocket {
  on(event: string, listener: (...args: any[]) => void): unknown;
  write(data: any, encoding?: any, cb?: (err?: Error) => void): unknown;
  end(): void;
  destroy(): void;
  remoteAddress?: string;
  remotePort?: number;
  localAddress?: string;
  localPort?: number;
}

export interface RawServer {
  on(event: string, listener: (...args: any[]) => void): unknown;
  listen(options: { port: number; host?: string; reuseAddress?: boolean }, cb?: () => void): unknown;
  close(cb?: () => void): void;
  address(): { port: number; address: string; family: string } | null | undefined;
}

export interface TcpDriver {
  createConnection(options: Record<string, unknown>, onConnect: () => void): RawSocket;
  createServer(onConnection?: (socket: RawSocket) => void): RawServer;
  createTLSServer(options: Record<string, unknown>, onConnection?: (socket: RawSocket) => void): RawServer;
}

let driver: TcpDriver | null = null;

export function setTcpDriver(d: TcpDriver | null): void {
  driver = d;
}

export function getTcpDriver(): TcpDriver {
  if (!driver) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-tcp-socket');
    driver = (mod.default ?? mod) as TcpDriver;
  }
  return driver;
}
