/**
 * 适配器端到端测试：**真的起一个 OneBot WebSocket 服务端**，让适配器连上来。
 *
 * 不用真实 NapCat，是因为这里要验证的是协议链路本身：
 *   鉴权参数 → 事件转换 → 发消息 → 服务端断线后自动重连。
 * 真实 NapCat 联调放在最后一步（需要装 NapCat、有小号），那时的失败才更可能是协议差异。
 */

import { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
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
    config: { wsUrl: url, selfId: '10001', accessToken: 'secret-token', ...overrides },
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

describe('parseOneBotConfig', () => {
  it('requires a WebSocket url and a QQ number', () => {
    expect(() => parseOneBotConfig({ selfId: '10001' })).toThrow(/wsUrl/);
    expect(() => parseOneBotConfig({ wsUrl: 'ws://127.0.0.1:6700/onebot/v11/ws' })).toThrow(/selfId/);
    expect(() => parseOneBotConfig({ wsUrl: 'http://x', selfId: '1' })).toThrow(/ws:\/\//);
  });

  it('treats a blank token as "no auth" instead of an empty token', () => {
    const config = parseOneBotConfig({
      wsUrl: 'ws://127.0.0.1:6700/onebot/v11/ws',
      selfId: '10001',
      accessToken: '   ',
    });
    expect(config.accessToken).toBeUndefined();
  });
});
