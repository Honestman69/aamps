/**
 * 适配器端到端测试：**真的起一个 OneBot WebSocket 服务端**，让适配器连上来。
 *
 * 不用真实 NapCat，是因为这里要验证的是协议链路本身：
 *   鉴权参数 → 事件转换 → 发消息 → 服务端断线后自动重连。
 * 真实 NapCat 联调放在最后一步（需要装 NapCat、有小号），那时的失败才更可能是协议差异。
 */

import { AddressInfo, createServer, connect as netConnect } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import type { AdapterDeps, InboundMessage } from '@newjob/contracts';
import { OneBotAdapter, parseOneBotConfig } from '../../packages/adapter-qq/src/onebot-adapter';

const silentLogger: AdapterDeps['logger'] = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

type FakeOneBot = {
  url: string;
  received: Array<Record<string, unknown>>;
  connections: number;
  /** 当前还开着的连接数（验证"连接失败要真的断开"） */
  openSockets: number;
  /** 最近一次握手的请求信息（用来断言 access_token 真的带上了） */
  lastHandshake: { url: string; authorization: string | undefined } | null;
  /** 收到 action 后自动回 ok，模拟 NapCat */
  replyWith: (data: unknown) => void;
  /** 改掉 get_login_info 返回的账号，模拟"登的不是配置的那个号" */
  setLoginUserId: (userId: string) => void;
  /** 模拟账号掉线（WS 通、QQ 没登） */
  setAccountOffline: () => void;
  /** 主动把某个客户端的连接掐断，验证重连 */
  dropConnections: () => void;
  pushEvent: (event: Record<string, unknown>) => void;
  close: () => Promise<void>;
};

async function startFakeOneBot(options: { selfId?: string } = {}): Promise<FakeOneBot> {
  const wss = new WebSocketServer({ port: 0, path: '/onebot/v11/ws' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const port = (wss.address() as AddressInfo).port;

  const state = {
    received: [] as Array<Record<string, unknown>>,
    connections: 0,
    sockets: new Set<WebSocket>(),
    replyData: { message_id: 99 } as unknown,
    loginInfo: { user_id: options.selfId ?? '10001', nickname: 'bot' } as Record<string, unknown>,
    statusData: { online: true, good: true } as Record<string, unknown>,
    lastHandshake: null as { url: string; authorization: string | undefined } | null,
  };

  wss.on('connection', (socket, req) => {
    state.connections += 1;
    state.lastHandshake = { url: req.url ?? '', authorization: req.headers.authorization };
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('message', (raw) => {
      const envelope = JSON.parse(raw.toString()) as Record<string, unknown>;
      state.received.push(envelope);
      if (typeof envelope.echo === 'string') {
        const action = String(envelope.action ?? '');
        const data =
          action === 'get_login_info'
            ? state.loginInfo
            : action === 'get_status'
              ? state.statusData
              : state.replyData;
        socket.send(
          JSON.stringify({
            status: 'ok',
            retcode: 0,
            data,
            echo: envelope.echo,
          }),
        );
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${port}/onebot/v11/ws`,
    received: state.received,
    get connections() {
      return state.connections;
    },
    get openSockets() {
      return state.sockets.size;
    },
    get lastHandshake() {
      return state.lastHandshake;
    },
    replyWith: (data: unknown) => {
      state.replyData = data;
    },
    setLoginUserId: (userId: string) => {
      state.loginInfo = { user_id: userId, nickname: 'bot' };
    },
    setAccountOffline: () => {
      state.statusData = { online: false, good: false };
    },
    dropConnections: () => {
      for (const socket of state.sockets) {
        socket.terminate();
      }
    },
    pushEvent: (event: Record<string, unknown>) => {
      const payload = JSON.stringify(event);
      for (const socket of state.sockets) {
        socket.send(payload);
      }
    },
    close: async () => {
      for (const socket of state.sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function makeAdapter(
  url: string,
  overrides: Record<string, unknown> = {},
): { adapter: OneBotAdapter; messages: InboundMessage[] } {
  const deps: AdapterDeps = {
    instanceId: 'inst-e2e',
    // 这一组用例验证的是**正向**（我们连 NapCat），所以显式指定 mode。
    // 适配器默认是 server（反向），不写清楚会连不上假服务端。
    config: { mode: 'client', wsUrl: url, selfId: '10001', accessToken: 'secret-token', ...overrides },
    logger: silentLogger,
  };
  const adapter = new OneBotAdapter(deps);
  const messages: InboundMessage[] = [];
  adapter.onMessage((message) => messages.push(message));
  return { adapter, messages };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('等待条件超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.map((fn) => fn().catch(() => undefined)));
  cleanup = [];
});

describe('OneBotAdapter 端到端', () => {
  it('connects with the access token, converts inbound events and replies pong', async () => {
    const server = await startFakeOneBot();
    const { adapter, messages } = makeAdapter(server.url);
    cleanup.push(() => adapter.disconnect(), () => server.close());

    await adapter.connect();
    expect(adapter.getStatus()).toBe('online');
    // 两种鉴权方式都带上：不同 OneBot 实现认的字段不一样
    expect(server.lastHandshake?.url).toContain('access_token=secret-token');
    expect(server.lastHandshake?.authorization).toBe('Bearer secret-token');

    server.pushEvent({
      post_type: 'message',
      message_type: 'group',
      message_id: 501,
      user_id: 20002,
      group_id: 88888,
      message: [
        { type: 'at', data: { qq: '10001' } },
        { type: 'text', data: { text: ' ping' } },
      ],
      sender: { user_id: 20002, nickname: '小明' },
    });

    await waitFor(() => messages.length === 1);
    const message = messages[0]!;
    expect(message.plainText).toBe('@10001 ping');
    expect(message.session).toEqual({ kind: 'group', peerId: '88888' });
    expect(message.isMentioned).toBe(true);

    server.replyWith({ message_id: 502 });
    const sent = await adapter.send({
      kind: 'send',
      session: message.session,
      segments: [{ type: 'text', text: 'pong' }],
    });
    expect(sent.messageId).toBe('502');

    const action = server.received.find((item) => item.action === 'send_msg');
    expect(action).toBeDefined();
    expect(action!.params).toMatchObject({
      message_type: 'group',
      group_id: '88888',
      message: [{ type: 'text', data: { text: 'pong' } }],
    });
  });

  it('reconnects automatically after the server drops the socket', async () => {
    const server = await startFakeOneBot();
    const { adapter } = makeAdapter(server.url);
    cleanup.push(() => adapter.disconnect(), () => server.close());

    await adapter.connect();
    expect(server.connections).toBe(1);

    server.dropConnections();

    // 断线后自动重连（退避从 1s 起），等到第二次连接建立
    await waitFor(() => server.connections >= 2, 5000);
    await waitFor(() => adapter.getStatus() === 'online', 5000);
  }, 20_000);

  it('rejects the connection when NapCat is logged in as a different account', async () => {
    // NapCat 里登的是 99999，实例填的是 10001 —— selfId 过滤会全错，必须当场拦住
    const server = await startFakeOneBot({ selfId: '99999' });
    const { adapter } = makeAdapter(server.url);
    cleanup.push(() => adapter.disconnect(), () => server.close());

    let message = '';
    try {
      await adapter.connect();
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toMatch(/不一致/);
    // 报错信息里只能出现掩码，不能出现完整 QQ 号
    expect(message).not.toContain('99999');
    expect(message).not.toContain('10001');
    expect(adapter.getStatus()).toBe('offline');
    // 失败后必须真的断开，不能留一条半开的 WS
    await waitFor(() => server.openSockets === 0, 3000);
  });

  it('rejects the connection when the QQ account is offline while the WS is up', async () => {
    const server = await startFakeOneBot();
    server.setAccountOffline();
    const { adapter } = makeAdapter(server.url);
    cleanup.push(() => adapter.disconnect(), () => server.close());

    await expect(adapter.connect()).rejects.toThrow(/未登录/);
    expect(adapter.getStatus()).toBe('offline');
  });

  it('fails fast when NapCat is not reachable (no silent retry loop on connect)', async () => {
    const { adapter } = makeAdapter('ws://127.0.0.1:1/onebot/v11/ws');
    cleanup.push(() => adapter.disconnect());

    await expect(adapter.connect()).rejects.toThrow(/连接 OneBot 失败/);
    expect(adapter.getStatus()).toBe('offline');
  });

  it('refuses to send when not connected', async () => {
    const { adapter } = makeAdapter('ws://127.0.0.1:1/onebot/v11/ws');
    await expect(
      adapter.send({ kind: 'send', session: { kind: 'private', peerId: '1' }, segments: [] }),
    ).rejects.toThrow('未连接');
  });
});

describe('OneBotAdapter 反向模式（NapCat 连我们）', () => {
  /** 拿一个空闲端口：监听 0 让内核分配，记下再释放 */
  async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  /** 等端口就绪再让"NapCat"连，否则 listen 还没完成会 ECONNREFUSED */
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
        throw new Error(`端口 ${port} 没有开始监听`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** 模拟 NapCat 的反向连接：自动应答 action，并记录我们发出去的东西 */
  async function connectFakeNapCat(port: number, token: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws?access_token=${token}`);
    cleanup.push(async () => socket.terminate());
    const received: Array<Record<string, unknown>> = [];
    socket.on('message', (raw) => {
      const envelope = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(envelope);
      if (typeof envelope.echo === 'string') {
        const action = String(envelope.action ?? '');
        socket.send(
          JSON.stringify({
            status: 'ok',
            retcode: 0,
            data:
              action === 'get_login_info'
                ? { user_id: '10001', nickname: 'bot' }
                : action === 'get_status'
                  ? { online: true, good: true }
                  : { message_id: 601 },
            echo: envelope.echo,
          }),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
      socket.once('unexpected-response', (_req, res) =>
        reject(new Error(`握手被拒绝：HTTP ${res.statusCode}`)),
      );
    });
    return { socket, received };
  }

  it('comes online once NapCat dials in, then converts events and replies pong', async () => {
    const port = await freePort();
    const deps: AdapterDeps = {
      instanceId: 'inst-reverse',
      // 只配监听地址：谁连进来由 token 决定
      config: {
        mode: 'server',
        wsUrl: `ws://127.0.0.1:${port}`,
        selfId: '10001',
        accessToken: 'reverse-token-123456',
      },
      logger: silentLogger,
    };
    const adapter = new OneBotAdapter(deps);
    const messages: InboundMessage[] = [];
    adapter.onMessage((message) => messages.push(message));
    cleanup.push(() => adapter.disconnect());

    const connecting = adapter.connect();
    await waitUntilListening(port);
    const napcat = await connectFakeNapCat(port, 'reverse-token-123456');
    await connecting;

    expect(adapter.getStatus()).toBe('online');
    // 连上之后仍要核验登录身份（反向模式也不能省）
    expect(napcat.received.some((item) => item.action === 'get_login_info')).toBe(true);

    napcat.socket.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        message_id: 601,
        user_id: 20002,
        message: [{ type: 'text', data: { text: 'ping' } }],
        sender: { user_id: 20002, nickname: '小明' },
      }),
    );

    await waitFor(() => messages.length === 1);
    expect(messages[0]!.plainText).toBe('ping');

    const sent = await adapter.send({
      kind: 'send',
      session: { kind: 'private', peerId: '20002' },
      segments: [{ type: 'text', text: 'pong' }],
    });
    expect(sent.messageId).toBe('601');
    expect(
      napcat.received.some(
        (item) =>
          item.action === 'send_msg' &&
          (item.params as Record<string, unknown> | undefined)?.message_type === 'private',
      ),
    ).toBe(true);
  }, 20_000);

  it('refuses to listen when neither a plaintext token nor a verifier is given', async () => {
    // 没有校验手段就监听，等于把控制权交给任何能连上这个端口的人
    const port = await freePort();
    const adapter = new OneBotAdapter({
      instanceId: 'inst-no-auth',
      config: { mode: 'server', wsUrl: `ws://127.0.0.1:${port}`, selfId: '10001' },
      logger: silentLogger,
    });
    cleanup.push(() => adapter.disconnect());
    await expect(adapter.connect()).rejects.toThrow(/token 校验手段/);
  });

  it('comes online with a verifier instead of a plaintext token (the digest path)', async () => {
    // 这是"服务重启后不需要解锁"的关键路径：主服务只给一个校验函数，
    // 适配器全程不接触 token 明文。
    const port = await freePort();
    const secret = 'digest-path-token-123456';
    const adapter = new OneBotAdapter({
      instanceId: 'inst-digest',
      config: { mode: 'server', wsUrl: `ws://127.0.0.1:${port}`, selfId: '10001' },
      verifyPeerToken: (provided: string) => provided === secret,
      logger: silentLogger,
    });
    cleanup.push(() => adapter.disconnect());

    const connecting = adapter.connect();
    await waitUntilListening(port);
    const peer = await connectFakeNapCat(port, secret);
    await connecting;

    expect(adapter.getStatus()).toBe('online');
    // 连上之后仍然核验登录身份，摘要模式不能省这一步
    expect(peer.received.some((item) => item.action === 'get_login_info')).toBe(true);
  }, 20_000);

  it('does not come online when the peer presents a wrong token', async () => {
    const port = await freePort();
    const deps: AdapterDeps = {
      instanceId: 'inst-reverse-bad',
      config: {
        mode: 'server',
        wsUrl: `ws://127.0.0.1:${port}`,
        selfId: '10001',
        accessToken: 'reverse-token-123456',
      },
      logger: silentLogger,
    };
    const adapter = new OneBotAdapter(deps);
    cleanup.push(() => adapter.disconnect());

    const connecting = adapter.connect();
    await waitUntilListening(port);
    await expect(connectFakeNapCat(port, 'wrong-token-000000')).rejects.toThrow(
      /握手被拒绝|401/,
    );

    // 对端被拒 → 适配器仍在等，状态不能是 online
    expect(adapter.getStatus()).toBe('connecting');
    await adapter.disconnect();
    await expect(connecting).rejects.toThrow();
  }, 20_000);
});

describe('parseOneBotConfig', () => {
  it('requires a WebSocket url and a QQ number', () => {
    expect(() => parseOneBotConfig({ mode: 'client', selfId: '10001' })).toThrow(/wsUrl/);
    expect(() => parseOneBotConfig({ mode: 'server', selfId: '10001' })).toThrow(/监听地址/);
    expect(() =>
      parseOneBotConfig({ mode: 'client', wsUrl: 'ws://127.0.0.1:6700/onebot/v11/ws' }),
    ).toThrow(/selfId/);
    expect(() =>
      parseOneBotConfig({ mode: 'client', wsUrl: 'http://x', selfId: '1' }),
    ).toThrow(/ws:\/\//);
  });

  it('treats a blank token as "no auth" in client mode', () => {
    const config = parseOneBotConfig({
      mode: 'client',
      wsUrl: 'ws://127.0.0.1:6700/onebot/v11/ws',
      selfId: '10001',
      accessToken: '   ',
    });
    expect(config.accessToken).toBeUndefined();
  });

  it('defaults to reverse mode (server) when mode is missing or unknown', () => {
    // 默认值必须落在安全的一侧：正向模式在 NapCat 4.18.41 上等于无鉴权
    const base = { wsUrl: 'ws://127.0.0.1:3002', selfId: '10001', accessToken: 'token-123456' };
    expect(parseOneBotConfig(base).mode).toBe('server');
    expect(parseOneBotConfig({ ...base, mode: 'nginx' }).mode).toBe('server');
    expect(parseOneBotConfig({ ...base, mode: 'CLIENT' }).mode).toBe('client');
  });

  it('parses reverse mode even without a plaintext token (the caller may hold only a digest)', () => {
    // 服务启动时 DEK 不在内存，主服务手里可能只有 token 摘要。
    // 配置解析只管格式，"有没有校验手段"由适配器装配时判定。
    const config = parseOneBotConfig({
      mode: 'server',
      wsUrl: 'ws://127.0.0.1:3002',
      selfId: '10001',
    });
    expect(config.mode).toBe('server');
    expect(config.accessToken).toBeUndefined();
  });
});
