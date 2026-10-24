/**
 * 反向 WS 服务端的鉴权与配对测试。
 *
 * 这是选反向模式的**全部理由**：token 必须在我们这一侧、在**握手阶段**生效。
 * 正向模式下 NapCat 4.18.41 的 token 校验是坏的（HTTP 中间件签名套在 WS 上，
 * `next` 未定义 → 抛异常被吞 → 连接照常保留），所以这一组用例必须把
 * "错 token 连不上、对 token 才连上"钉死，免得以后重构时悄悄退化。
 */

import { createServer, connect as netConnect } from 'node:net';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import type { AdapterDeps } from '@newjob/contracts';
import type { OneBotEvent } from '../../packages/adapter-qq/src/onebot/protocol';
import { OneBotWsServer } from '../../packages/adapter-qq/src/onebot/server';

const silentLogger: AdapterDeps['logger'] = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const TOKEN = 'reverse-token-123456';

/** 拿一个当前空闲的端口：监听 0 让内核分配，记下再释放 */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * 等到端口真的能建立 TCP 连接再让"对端"出手。
 * 不这样做的话，`connect()` 里的 listen 是异步的，测试会时好时坏（ECONNREFUSED 抖动）。
 */
async function waitUntilListening(port: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = netConnect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (reachable) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`端口 ${port} 在 ${timeoutMs}ms 内没有开始监听`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) {
    try {
      fn();
    } catch {
      // 清理失败不影响断言结论
    }
  }
  cleanup = [];
});

type ServerOptions = ConstructorParameters<typeof OneBotWsServer>[0];

function makeServer(
  port: number,
  overrides: Partial<ServerOptions> = {},
): { server: OneBotWsServer; events: OneBotEvent[]; statuses: string[] } {
  const events: OneBotEvent[] = [];
  const statuses: string[] = [];
  const server = new OneBotWsServer({
    host: '127.0.0.1',
    port,
    accessToken: TOKEN,
    logger: silentLogger,
    onEvent: (event) => events.push(event),
    onStatusChange: (status) => statuses.push(status),
    waitForPeerMs: 800,
    heartbeatIntervalMs: 0,
    ...overrides,
  });
  cleanup.push(() => server.close());
  return { server, events, statuses };
}

/** 模拟 NapCat 的反向连接：按请求回 ok */
function connectAsPeer(
  port: number,
  token: string | null,
  options: { header?: boolean } = {},
): WebSocket {
  const query = token && !options.header ? `?access_token=${token}` : '';
  const socket = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws${query}`, {
    ...(token && options.header ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  cleanup.push(() => socket.terminate());
  socket.on('message', (raw) => {
    const envelope = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (typeof envelope.echo === 'string') {
      const action = String(envelope.action ?? '');
      socket.send(
        JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: action === 'get_login_info' ? { user_id: '10001' } : { online: true, good: true },
          echo: envelope.echo,
        }),
      );
    }
  });
  return socket;
}

function waitOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
    socket.once('unexpected-response', (_req, res) =>
      reject(new Error(`握手被拒绝：HTTP ${res.statusCode}`)),
    );
  });
}

describe('OneBotWsServer 反向模式', () => {
  it('accepts a peer that presents the right token in the query', async () => {
    const port = await freePort();
    const { server, statuses } = makeServer(port);

    const connecting = server.connect();
    await waitUntilListening(port);
    const peer = connectAsPeer(port, TOKEN);
    await waitOpen(peer);
    await connecting;

    expect(server.isOpen()).toBe(true);
    // connecting → online：NapCat 还没连进来的那段时间不该显示在线
    expect(statuses).toEqual(['connecting', 'online']);
  });

  it('accepts the token via the Authorization header too', async () => {
    const port = await freePort();
    const { server } = makeServer(port);

    const connecting = server.connect();
    await waitUntilListening(port);
    const peer = connectAsPeer(port, TOKEN, { header: true });
    await waitOpen(peer);
    await connecting;

    expect(server.isOpen()).toBe(true);
  });

  it('rejects the handshake when the token is wrong', async () => {
    const port = await freePort();
    const { server } = makeServer(port);

    const connecting = server.connect();
    await waitUntilListening(port);
    const peer = connectAsPeer(port, 'wrong-token-000000');

    await expect(waitOpen(peer)).rejects.toThrow(/握手被拒绝|401/);
    // 服务端仍在等"对的那一个"，直到超时
    await expect(connecting).rejects.toThrow(/等待 NapCat 连入超时/);
    expect(server.isOpen()).toBe(false);
  });

  it('rejects a peer with no token at all', async () => {
    const port = await freePort();
    const { server } = makeServer(port);

    const connecting = server.connect();
    await waitUntilListening(port);
    const peer = connectAsPeer(port, null);

    await expect(waitOpen(peer)).rejects.toThrow(/握手被拒绝|401/);
    await expect(connecting).rejects.toThrow(/超时/);
  });

  it('refuses to start without a token', () => {
    // 反向端是我们自己开的端口：没有 token 就等于对任何能连上的进程开放
    expect(
      () =>
        new OneBotWsServer({
          host: '127.0.0.1',
          port: 1,
          accessToken: '',
          logger: silentLogger,
          onEvent: () => undefined,
        }),
    ).toThrow(/至少 8 位/);
  });

  it('routes peer events to onEvent and matches action echoes', async () => {
    const port = await freePort();
    const { server, events } = makeServer(port);

    const connecting = server.connect();
    await waitUntilListening(port);
    const peer = connectAsPeer(port, TOKEN);
    await connecting;

    // 请求-响应：我们发 get_login_info，对端回 echo
    const response = await server.call('get_login_info', {});
    expect(response.data).toMatchObject({ user_id: '10001' });

    // 事件：对端主动推一条私聊
    peer.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        message_id: 1,
        user_id: 20002,
        message: [{ type: 'text', data: { text: 'ping' } }],
        sender: { user_id: 20002, nickname: '小明' },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events.some((event) => event.post_type === 'message')).toBe(true);
  });

  it('honours the last peer when NapCat reconnects (no duplicate handling)', async () => {
    const port = await freePort();
    const { server } = makeServer(port);

    const connecting = server.connect();
    await waitUntilListening(port);
    const first = connectAsPeer(port, TOKEN);
    await waitOpen(first);
    await connecting;

    const closed = new Promise<void>((resolve) => first.once('close', () => resolve()));
    const second = connectAsPeer(port, TOKEN);
    await waitOpen(second);
    // 旧连接必须被让位，否则同一条消息会被处理两次
    await closed;

    expect(server.isOpen()).toBe(true);
    // 新连接仍然可用
    const response = await server.call('get_status', {});
    expect(response.retcode).toBe(0);
  });

  it('rejects a port that is already in use instead of silently failing', async () => {
    const port = await freePort();
    const first = makeServer(port);
    const connecting = first.server.connect();
    await waitUntilListening(port);
    await waitOpen(connectAsPeer(port, TOKEN));
    await connecting;

    const second = makeServer(port);
    await expect(second.server.connect()).rejects.toThrow(/端口被占用/);
  });
});
