// Development only: not part of the published package or the browser import graph.
import { randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import * as path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { nodeTrustStore } from '../src/hosts/node/trust-store.ts';

/** Exact destinations; redirects to other hosts need explicit --allow entries. */
export const DEFAULT_ALLOW: readonly string[] = [
  'example.com:443',
  'discord.com:443',
  'kbbi.kemendikdasmen.go.id:443',
];
const repo = path.resolve(import.meta.dirname, '..');
const MAX_CREDIT = 256 * 1024;
const MAX_PENDING_WRITE = 8 * 1024 * 1024;

export interface DemoOptions {
  readonly port?: number;
  readonly allow?: readonly string[];
}
export interface DemoServer {
  readonly url: string;
  readonly relay: string;
  close(): Promise<void>;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('invalid control');
  return value as Record<string, unknown>;
}
function positiveInt(n: unknown, max: number): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= max;
}
function wire(ws: WebSocket, allow: ReadonlySet<string>, sockets: Set<net.Socket>): void {
  let socket: net.Socket | undefined;
  let credit = 0;
  let pendingWrite = 0;
  let finished = false;
  let graceful = false;
  const send = (value: object): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
  };
  const fail = (code: string): void => {
    if (finished) return;
    finished = true;
    send({ type: 'error', code });
    socket?.destroy();
    ws.close();
  };
  const timer = setTimeout(() => fail('ETIMEDOUT'), 10_000);
  ws.on('error', () => {
    socket?.destroy();
  });
  ws.on('close', () => {
    clearTimeout(timer);
    finished = true;
    if (!graceful) socket?.destroy();
  });
  ws.on('message', (data, binary) => {
    if (finished) return;
    try {
      if (binary) {
        if (socket === undefined || socket.connecting || graceful) throw new Error('not connected');
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
        pendingWrite += bytes.length;
        if (pendingWrite > MAX_PENDING_WRITE) {
          fail('ENOBUFS');
          return;
        }
        socket.write(bytes, () => {
          pendingWrite -= bytes.length;
          send({ type: 'ack', bytes: bytes.length });
        });
        return;
      }
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString()
        : Buffer.isBuffer(data)
          ? data.toString()
          : Buffer.from(data as ArrayBuffer).toString();
      const msg = record(JSON.parse(text));
      switch (msg['type']) {
        case 'connect': {
          if (
            socket !== undefined ||
            typeof msg['host'] !== 'string' ||
            !positiveInt(msg['port'], 65535) ||
            !positiveInt(msg['credit'], MAX_CREDIT)
          )
            throw new Error('invalid connect');
          const host = msg['host'].toLowerCase().replace(/\.$/, '');
          if (!allow.has(`${host}:${msg['port']}`)) {
            fail('EACCES');
            return;
          }
          credit = msg['credit'];
          const tcp = new net.Socket({ allowHalfOpen: true });
          socket = tcp;
          sockets.add(tcp);
          tcp.setNoDelay(true);
          tcp.setTimeout(60_000, () => fail('ETIMEDOUT'));
          tcp.on('connect', () => {
            clearTimeout(timer);
            send({ type: 'connected' });
          });
          tcp.on('data', (bytes) => {
            credit -= bytes.length;
            if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
            if (credit <= 0) tcp.pause();
          });
          tcp.on('end', () => send({ type: 'end' }));
          tcp.on('error', (error: NodeJS.ErrnoException) =>
            fail(
              error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN'
                ? 'EHOSTUNREACH'
                : (error.code ?? 'EIO'),
            ),
          );
          tcp.on('close', () => {
            sockets.delete(tcp);
            if (!finished) ws.close();
          });
          tcp.connect({ host, port: msg['port'] });
          break;
        }
        case 'credit':
          if (
            socket === undefined ||
            !positiveInt(msg['bytes'], MAX_CREDIT) ||
            credit + msg['bytes'] > MAX_CREDIT
          )
            throw new Error('invalid credit');
          credit += msg['bytes'];
          socket.resume();
          break;
        case 'end':
          if (socket === undefined) throw new Error('not connected');
          graceful = true;
          socket.end(() => {
            socket?.destroy();
          });
          break;
        case 'reset':
          socket?.destroy();
          ws.close();
          break;
        case 'no-delay':
          if (typeof msg['enabled'] !== 'boolean' || socket === undefined)
            throw new Error('invalid option');
          socket.setNoDelay(msg['enabled']);
          break;
        case 'keep-alive':
          if (
            typeof msg['enabled'] !== 'boolean' ||
            socket === undefined ||
            typeof msg['idleSeconds'] !== 'number' ||
            !Number.isSafeInteger(msg['idleSeconds']) ||
            msg['idleSeconds'] < 0 ||
            msg['idleSeconds'] > 86400
          )
            throw new Error('invalid option');
          socket.setKeepAlive(msg['enabled'], msg['idleSeconds'] * 1000);
          break;
        default:
          throw new Error('unknown control');
      }
    } catch {
      fail('EINVAL');
    }
  });
}

/** Tests own the lifecycle. Binding is deliberately not configurable beyond the port. */
export async function startBrowserDemo(options: DemoOptions = {}): Promise<DemoServer> {
  const token = randomBytes(24).toString('hex');
  const allow = new Set(options.allow ?? DEFAULT_ALLOW);
  const roots = nodeTrustStore().systemRoots();
  if (!roots.ok) throw new Error(`cannot read relay roots: ${roots.error.code}`);
  const rootJson = JSON.stringify(roots.value.map((der) => Buffer.from(der).toString('base64')));
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has('moonrun-tcp-v1') ? 'moonrun-tcp-v1' : false),
  });
  const sockets = new Set<net.Socket>();
  let authority = '';
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.headers.host !== authority || req.method !== 'GET') {
          res.writeHead(403).end();
          return;
        }
        const url = new URL(req.url ?? '/', `http://${authority}`);
        if (req.headers.origin !== undefined && req.headers.origin !== `http://${authority}`) {
          res.writeHead(403).end();
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        if (url.pathname === '/roots') {
          if (url.searchParams.get('token') !== token) {
            res.writeHead(403).end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(rootJson);
          return;
        }
        const relative =
          url.pathname === '/'
            ? 'examples/browser/index.html'
            : decodeURIComponent(url.pathname.slice(1));
        if (
          relative !== 'examples/browser/index.html' &&
          relative !== 'examples/browser/demo.js' &&
          !relative.startsWith('dist/')
        ) {
          res.writeHead(404).end();
          return;
        }
        const file = await realpath(path.resolve(repo, relative));
        const permitted =
          file === path.join(repo, 'examples/browser/index.html') ||
          file === path.join(repo, 'examples/browser/demo.js') ||
          file.startsWith(`${path.join(repo, 'dist')}${path.sep}`);
        if (!permitted) {
          res.writeHead(403).end();
          return;
        }
        const mime = file.endsWith('.wasm')
          ? 'application/wasm'
          : file.endsWith('.html')
            ? 'text/html; charset=utf-8'
            : file.endsWith('.js')
              ? 'text/javascript; charset=utf-8'
              : undefined;
        if (mime === undefined) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': mime }).end(await readFile(file));
      } catch {
        if (!res.headersSent) res.writeHead(404);
        res.end();
      }
    })();
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${authority}`);
    const origin = req.headers.origin;
    if (
      req.headers.host !== authority ||
      url.pathname !== '/relay' ||
      url.searchParams.get('token') !== token ||
      (origin !== undefined && origin !== `http://${authority}`) ||
      req.headers['sec-websocket-protocol'] !== 'moonrun-tcp-v1'
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wire(ws, allow, sockets));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing bound address');
  authority = `127.0.0.1:${address.port}`;
  return {
    url: `http://${authority}/?token=${token}`,
    relay: `ws://${authority}/relay?token=${token}`,
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => wss.close(() => resolve())),
        new Promise<void>((resolve, reject) =>
          server.close((e) => (e === undefined ? resolve() : reject(e))),
        ),
      ]);
    },
  };
}

if (import.meta.main) {
  const allow = [...DEFAULT_ALLOW];
  let port = 8080;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--allow' && process.argv[i + 1] !== undefined)
      allow.push(process.argv[++i] as string);
    else if (arg === '--port' && process.argv[i + 1] !== undefined)
      port = Number(process.argv[++i]);
    else
      throw new Error('usage: node scripts/browser-demo.ts [--port PORT] [--allow HOST:PORT]...');
  }
  const demo = await startBrowserDemo({ port, allow });
  console.log(
    `moonrun-js browser demo: ${demo.url}\nTCP allowlist: ${allow.join(', ')}\nCtrl-C to stop. Run mise exec -- pnpm build first.`,
  );
  process.once('SIGINT', () => {
    void demo.close();
  });
  process.once('SIGTERM', () => {
    void demo.close();
  });
}
