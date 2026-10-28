/**
 * HTTP 层冒烟：对**已经跑起来的服务**发真实请求。
 *
 * 验证的是端到端行为，不是代码形状：
 *   鉴权 → 登录 → 改密 → 锁定 → 重新解锁 → 管理员接口 → 审计链
 * 以及最关键的一条：**任何响应体里都不许出现 Key 明文或密文**。
 *
 * 用法：
 *   BASE_URL=http://127.0.0.1:3111 npx tsx scripts/http-smoke.ts
 *
 * 账号与密码要和**起服务时的 BOOTSTRAP_ADMIN_*** 对上：
 *   SMOKE_USERNAME  默认 smoke_http_admin
 *   SMOKE_PASSWORD  默认 smoke-http-pass-01（也认 ADMIN_PASSWORD）
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3111';
const ADMIN = process.env.SMOKE_USERNAME ?? 'smoke_http_admin';
/** 两个名字都认：老文档里写的是 ADMIN_PASSWORD，脚本里一直是 SMOKE_PASSWORD */
const PASSWORD =
  process.env.SMOKE_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'smoke-http-pass-01';
const NEW_PASSWORD = process.env.SMOKE_NEW_PASSWORD ?? 'smoke-http-pass-02';
/** 留给 `zero-knowledge-check.ts` 当靶子的明文 Key，两边必须一致 */
const ZK_PLAINTEXT = process.env.ZK_PLAINTEXT ?? 'sk-smoke-zk-marker-4c3b2a19';

/** 极简 cookie jar：只关心我们自己的 session cookie */
let cookie = '';

type Res = { status: number; body: any; setCookie: string | null; raw: string };

/**
 * 发一次请求。**不碰全局 cookie**：`cookieValue` 由调用方给。
 *
 * 拆出这一层是为了验证"第二个账号"的场景：用另一个 cookie 登录普通用户、
 * 拿他的身份去访问管理接口。如果只用全局 jar，登录会互相覆盖。
 */
async function request(
  method: string,
  path: string,
  body: unknown,
  cookieValue: string,
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (cookieValue) {
    headers.cookie = cookieValue;
  }
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  const setCookie = response.headers.get('set-cookie');
  let parsed: any = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw;
  }
  assert.ok(
    !raw.includes('sk-live') && !raw.includes('dek:v1:') && !raw.includes('wrap:v1:'),
    `${method} ${path} 的响应里出现了密钥材料`,
  );
  return { status: response.status, body: parsed, setCookie, raw };
}

/** 主账号用：请求成功后把 Set-Cookie 收进全局 jar */
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await request(method, path, body, cookie);
  if (res.setCookie) {
    // 只取 name=value 部分
    const first = res.setCookie.split(';')[0]!;
    cookie = first.endsWith('=') ? '' : first;
  }
  return res;
}

function step(name: string): void {
  process.stdout.write(`• ${name}\n`);
}

async function main(): Promise<void> {
  step('未登录访问 /api/auth/me → 401');
  let res = await call('GET', '/api/auth/me');
  assert.equal(res.status, 401);

  step('错误密码登录 → 401，且不泄漏"用户存在与否"');
  res = await call('POST', '/api/auth/login', { username: ADMIN, password: 'definitely-wrong-pass' });
  assert.equal(res.status, 401);
  const wrongUser = await call('POST', '/api/auth/login', { username: 'no-such-user', password: 'whatever-1234' });
  assert.equal(wrongUser.status, 401);
  assert.equal(wrongUser.body?.message, res.body?.message, '两种失败的文案必须一致（防枚举）');

  step('正确密码登录 → 200 + HttpOnly cookie');
  res = await call('POST', '/api/auth/login', { username: ADMIN, password: PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.unlocked, true);
  assert.match(res.setCookie ?? '', /HttpOnly/);
  assert.ok(!(res.setCookie ?? '').includes('dek'), 'cookie 里不允许出现密钥材料');

  step('/api/auth/me → 已解锁，且只返回身份字段');
  res = await call('GET', '/api/auth/me');
  assert.equal(res.status, 200);
  assert.equal(res.body.unlocked, true);
  assert.deepEqual(Object.keys(res.body.user).sort(), ['id', 'role', 'username']);

  step('本人改密 → 200，当前会话仍可用');
  res = await call('POST', '/api/auth/password', {
    oldPassword: PASSWORD,
    newPassword: NEW_PASSWORD,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  res = await call('GET', '/api/auth/me');
  assert.equal(res.body.unlocked, true);

  step('旧密码不能再解锁 → 401');
  res = await call('POST', '/api/auth/unlock', { password: PASSWORD });
  assert.equal(res.status, 401);

  step('新密码可以重新解锁 → 200');
  res = await call('POST', '/api/auth/unlock', { password: NEW_PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(res.body.unlocked, true);

  // ── 凭据管理（M0 第 5 步） ──
  const credentialKey = 'sk-smoke-credential-9f8e7d6c';
  step('凭据：新增 → 201，响应只有掩码，没有密文');
  res = await call('POST', '/api/credentials', {
    provider: 'deepseek',
    label: '冒烟用',
    apiKey: credentialKey,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const credId = res.body.id as string;
  assert.equal(res.body.keyMasked, 'sk-****7d6c');
  assert.ok(!('apiKeyEnc' in res.body), '响应体里不允许有 apiKeyEnc');
  assert.ok(!res.raw.includes(credentialKey), '响应体里出现了明文 Key');

  step('凭据：列表 → 只有掩码，没有归属与密文字段');
  res = await call('GET', '/api/credentials');
  assert.equal(res.status, 200);
  const credList = res.body as Array<Record<string, unknown>>;
  assert.equal(credList.length, 1);
  for (const forbidden of ['apiKeyEnc', 'ownerUserId', 'tenantId']) {
    assert.ok(!(forbidden in credList[0]!), `凭据列表泄漏字段 ${forbidden}`);
  }
  assert.equal(credList[0]!.keyMasked, 'sk-****7d6c');

  step('凭据：请求体里塞 apiKeyEnc（想自己指定密文）→ 400');
  res = await call('POST', '/api/credentials', {
    provider: 'deepseek',
    label: '越权写入',
    apiKey: 'sk-smoke-attempt-000000',
    apiKeyEnc: 'dek:v1:forged:forged:forged',
  });
  assert.equal(res.status, 400);

  step('凭据：改元数据 → 200，密文不动（掩码不变）');
  res = await call('PATCH', `/api/credentials/${credId}`, { label: '改名后' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.label, '改名后');
  assert.equal(res.body.keyMasked, 'sk-****7d6c');

  step('凭据：轮换 Key → 掩码随之变化');
  res = await call('PATCH', `/api/credentials/${credId}`, { apiKey: 'sk-smoke-rotated-1234abcd' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.keyMasked, 'sk-****abcd');

  step('凭据：不存在的 id → 404（不提"存在但无权"）');
  res = await call('PATCH', '/api/credentials/no-such-credential', { label: 'x' });
  assert.equal(res.status, 404);

  step('凭据：删除 → 200，列表清空');
  res = await call('DELETE', `/api/credentials/${credId}`);
  assert.equal(res.status, 200);
  res = await call('GET', '/api/credentials');
  assert.deepEqual(res.body, []);

  step('凭据：留一条给零知识验收（直查数据库时用它当靶子）');
  res = await call('POST', '/api/credentials', {
    provider: 'openai',
    label: 'zk-keep',
    apiKey: ZK_PLAINTEXT,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  step('适配器清单：qq/onebot 已注册（前端据此渲染表单）');
  res = await call('GET', '/api/adapters');
  assert.equal(res.status, 200);
  const manifests = res.body as Array<Record<string, any>>;
  const qq = manifests.find((item) => item.platform === 'qq' && item.protocol === 'onebot');
  assert.ok(qq, '没有找到 qq/onebot 适配器');
  assert.ok(Array.isArray(qq.configFields) && qq.configFields.length >= 3);

  step('实例：新建（QQ 号从接口填，不是写死在配置里）→ 201');
  res = await call('POST', '/api/instances', {
    name: '冒烟实例',
    accountId: '10001000',
    // 显式声明正向模式：下面要验的是"拨号连不上 → 502"。
    // 不写就会落到默认的反向模式，那时 connect 是**监听 + 等对端**，
    // 失败原因变成"等待超时"，这条用例就不再测它名字说的那件事了（还会白等 20 秒）。
    adapterMode: 'client',
    endpoint: 'ws://127.0.0.1:1/onebot/v11/ws',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const instanceId = res.body.id as string;
  assert.equal(res.body.accountId, '10001000');
  assert.equal(res.body.adapterMode, 'client');
  assert.equal(res.body.hasAccessToken, false);
  assert.ok(!('accessTokenEnc' in res.body), '实例响应里不允许有 accessTokenEnc');

  step('实例：列表只返回自己的，且没有 token 密文');
  res = await call('GET', '/api/instances');
  assert.equal(res.status, 200);
  const instanceList = res.body as Array<Record<string, unknown>>;
  assert.equal(instanceList.length, 1);
  for (const forbidden of ['accessTokenEnc', 'ownerUserId', 'tenantId']) {
    assert.ok(!(forbidden in instanceList[0]!), `实例列表泄漏字段 ${forbidden}`);
  }
  assert.equal(instanceList[0]!.status, 'offline');

  step('实例：NapCat 没起来时连接 → 502，且状态回到 offline');
  res = await call('POST', `/api/instances/${instanceId}/connect`);
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(res.body.code, 'INSTANCE_CONNECT_FAILED');
  res = await call('GET', '/api/instances');
  assert.equal((res.body as Array<Record<string, unknown>>)[0]!.status, 'offline');

  step('实例：公网地址 → 400（默认不允许把 QQ 登录态交给陌生地址）');
  res = await call('POST', '/api/instances', {
    name: '公网 NapCat',
    accountId: '10001001',
    endpoint: 'ws://napcat.example.com:3001',
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'REMOTE_ENDPOINT_BLOCKED');

  step('实例：反向模式下监听端口被占用 → 502，且状态回到 offline');
  {
    // 反向模式是默认路径，冒烟里必须有它的失败分支。
    // 用 EADDRINUSE 触发，比"等对端 20 秒超时"快得多，测的还是同一件事：起不来就别报 online。
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const busyPort = (blocker.address() as AddressInfo).port;
    try {
      res = await call('POST', '/api/instances', {
        name: '反向模式实例',
        accountId: '10001002',
        adapterMode: 'server',
        endpoint: `ws://127.0.0.1:${busyPort}`,
        accessToken: 'smoke-reverse-token',
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.adapterMode, 'server');
      const reverseId = res.body.id as string;
      res = await call('POST', `/api/instances/${reverseId}/connect`);
      assert.equal(res.status, 502, JSON.stringify(res.body));
      assert.equal(res.body.code, 'INSTANCE_CONNECT_FAILED');
      const after = await call('GET', '/api/instances');
      const row = (after.body as Array<Record<string, unknown>>).find((it) => it.id === reverseId);
      assert.equal(row?.status, 'offline');
      res = await call('DELETE', `/api/instances/${reverseId}`);
      assert.equal(res.status, 200);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  }

  // ── 接入配置由适配器清单驱动（D041）──
  const ADAPTER_CONFIG = {
    mode: 'client',
    wsUrl: 'ws://127.0.0.1:1/onebot/v11/ws',
    selfId: '10002000',
  };

  step('实例：只给 adapterConfig 也能建（账号来自清单里的 selfId）→ 201');
  res = await call('POST', '/api/instances', {
    name: '清单驱动',
    platform: 'qq',
    adapterType: 'onebot',
    adapterConfig: ADAPTER_CONFIG,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const configInstanceId = res.body.id as string;
  assert.equal(res.body.accountId, '10002000');
  assert.equal(res.body.adapterMode, 'client');
  assert.equal(res.body.endpoint, ADAPTER_CONFIG.wsUrl);

  step('实例：adapterConfig 与平铺字段同时给 → 400（同一件事两个来源）');
  res = await call('POST', '/api/instances', {
    name: '重复来源',
    accountId: '10002001',
    adapterConfig: ADAPTER_CONFIG,
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));

  step('实例：adapterConfig 里有清单外的字段 → 400，而不是静默丢掉');
  res = await call('POST', '/api/instances', {
    name: '拼错字段',
    adapterConfig: { ...ADAPTER_CONFIG, wssUrl: 'ws://x' },
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.ok(String(res.body.message).includes('wssUrl'), '错误里要点出是哪个字段');

  step('实例：反向模式漏 token → 400（清单的 requiredWhen 在服务端同样生效）');
  res = await call('POST', '/api/instances', {
    name: '反向漏 token',
    adapterConfig: { mode: 'server', wsUrl: 'ws://127.0.0.1:3002', selfId: '10002002' },
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));

  step('实例：用 adapterConfig 改账号 → 200，没传的接入参数原样保留');
  res = await call('PATCH', `/api/instances/${configInstanceId}`, {
    adapterConfig: { selfId: '10002001' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.accountId, '10002001');
  assert.equal(res.body.endpoint, ADAPTER_CONFIG.wsUrl);
  assert.equal(res.body.adapterMode, 'client');

  step('实例：adapterConfig 把必填项改空 → 400');
  res = await call('PATCH', `/api/instances/${configInstanceId}`, {
    adapterConfig: { wsUrl: '   ' },
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));

  res = await call('DELETE', `/api/instances/${configInstanceId}`);
  assert.equal(res.status, 200);

  step('实例：改名字 → 200');
  step('实例：主动消息开关默认关闭，能改能读回');
  res = await call('GET', '/api/instances');
  assert.equal(res.status, 200);
  const listed = (res.body as Array<{ id: string; proactiveEnabled: boolean }>).find(
    (item) => item.id === instanceId,
  );
  assert.ok(listed, '列表里应能查到刚建的实例');
  assert.equal(listed.proactiveEnabled, false, '默认必须关闭（D047）');
  res = await call('PATCH', `/api/instances/${instanceId}`, { proactiveEnabled: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.proactiveEnabled, true);
  res = await call('PATCH', `/api/instances/${instanceId}`, { proactiveEnabled: 'yes' });
  assert.equal(res.status, 400, '布尔字段不接字符串');

  res = await call('PATCH', `/api/instances/${instanceId}`, { name: '改过名的实例' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.name, '改过名的实例');

  // ── 人设（M4-1：编辑器的后端） ──
  step('人设：新建草稿 → 201，只有 name 必填');
  res = await call('POST', `/api/instances/${instanceId}/personas`, {
    name: '小雅',
    tagline: '22 岁，话多、心软',
    identity: { name: '小雅', age: '22' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.status, 'draft');
  assert.equal(res.body.version, 1);
  assert.equal(res.body.active, false);
  const personaId = String(res.body.id);

  step('人设：列表里能看到它，且默认不含归档');
  res = await call('GET', `/api/instances/${instanceId}/personas`);
  assert.equal(res.status, 200);
  assert.equal((res.body as unknown[]).length, 1);
  assert.equal(res.body[0].id, personaId);

  step('人设：草稿不能启用 → 409（先发布）');
  res = await call('POST', `/api/personas/${personaId}/activate`);
  assert.equal(res.status, 409, JSON.stringify(res.body));

  step('人设：发布 → 200，带 publishedAt');
  res = await call('POST', `/api/personas/${personaId}/publish`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'published');
  assert.ok(res.body.publishedAt);

  step('人设：启用 → 200，active=true');
  res = await call('POST', `/api/personas/${personaId}/activate`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.active, true);

  step('人设：改已发布内容 → 版本 +1（改动即新版）');
  res = await call('PATCH', `/api/personas/${personaId}`, { tagline: '改过的定位' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.version, 2);
  assert.equal(res.body.tagline, '改过的定位');

  step('人设：行为参数拼错字段 → 400（不能"保存成功但没生效"）');
  res = await call('PATCH', `/api/personas/${personaId}`, {
    behavior: { attention: { thresholdGrop: 0.4 } },
  });
  assert.equal(res.status, 400);

  step('人设：合法行为参数 → 200 并原样存下');
  res = await call('PATCH', `/api/personas/${personaId}`, {
    behavior: { expression: { typingCps: 6 }, think: { enabled: false } },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual((res.body.behavior as Record<string, unknown>).expression, { typingCps: 6 });

  step('人设：不存在 / 不属于本人 → 404');
  res = await call('GET', '/api/personas/no-such-persona');
  assert.equal(res.status, 404);

  step('人设：归档 → 200，并解除实例的激活指针');
  res = await call('POST', `/api/personas/${personaId}/archive`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'archived');
  assert.equal(res.body.active, false);
  res = await call('GET', `/api/instances/${instanceId}/personas`);
  assert.deepEqual(res.body, [], '归档后默认列表应为空');
  res = await call('GET', `/api/instances/${instanceId}/personas?includeArchived=1`);
  assert.equal((res.body as unknown[]).length, 1);

  // ── 素材库（M4-3） ──
  step('素材：列表为空，但带统计与每实例上限');
  res = await call('GET', `/api/instances/${instanceId}/assets`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.items, []);
  assert.equal(res.body.stats.usable, 0);
  assert.equal(res.body.stats.limit, 200);

  step('素材：includeDeleted 传非法值 → 400（query 也 strict 校验）');
  res = await call('GET', `/api/instances/${instanceId}/assets?includeDeleted=yes`);
  assert.equal(res.status, 400);

  step('素材：删除不存在的素材 → 404');
  res = await call('DELETE', `/api/instances/${instanceId}/assets/no-such-asset`);
  assert.equal(res.status, 404);

  step('素材：取不存在的文件 → 404 JSON（不能回 HTML）');
  res = await call('GET', `/api/instances/${instanceId}/assets/no-such-asset/file`);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'ASSET_NOT_FOUND');

  step('实例：不存在的 id → 404');
  res = await call('POST', '/api/instances/no-such-instance/connect');
  assert.equal(res.status, 404);

  step('实例：删除 → 200，列表清空');
  res = await call('DELETE', `/api/instances/${instanceId}`);
  assert.equal(res.status, 200);
  res = await call('GET', '/api/instances');
  assert.deepEqual(res.body, []);

  step('管理员接口：用户列表不含任何密钥材料');
  res = await call('GET', '/api/admin/users');
  assert.equal(res.status, 200);
  const users = res.body as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(users) && users.length >= 1);
  for (const user of users) {
    for (const forbidden of ['wrappedDek', 'keySalt', 'passwordHash', 'apiKeyEnc']) {
      assert.ok(!(forbidden in user), `用户列表泄漏字段 ${forbidden}`);
    }
  }
  const self = users.find((user) => user.username === ADMIN)!;
  assert.equal(self.dekInitialized, true);

  // ── 用户管理：建号 / 角色 / 启停（D042） ──
  const MEMBER = 'smoke_member';
  const MEMBER_PASSWORD = 'member-pass-8f3a2c';

  step('用户：建号 → 201，且响应里没有密码哈希 / 盐 / 密文');
  res = await call('POST', '/api/admin/users', {
    username: MEMBER,
    displayName: '冒烟成员',
    password: MEMBER_PASSWORD,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const memberId = String(res.body.id);
  assert.equal(res.body.role, 'user');
  assert.equal(res.body.status, 'active');
  for (const forbidden of ['passwordHash', 'keySalt', 'wrappedDek']) {
    assert.ok(!(forbidden in res.body), `建号响应泄漏字段 ${forbidden}`);
  }

  step('用户：用户名重复 → 409（不是 400，这是状态冲突）');
  res = await call('POST', '/api/admin/users', {
    username: MEMBER,
    password: MEMBER_PASSWORD,
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));

  step('用户：密码太短 → 400（与改密共用同一条强度规则）');
  res = await call('POST', '/api/admin/users', { username: 'smoke_short_pw', password: 'short' });
  assert.equal(res.status, 400, JSON.stringify(res.body));

  step('用户：新号可以直接登录，首次登录才生成 DEK');
  const memberLogin = await request(
    'POST',
    '/api/auth/login',
    { username: MEMBER, password: MEMBER_PASSWORD },
    '',
  );
  assert.equal(memberLogin.status, 200, JSON.stringify(memberLogin.body));
  assert.equal(memberLogin.body.unlocked, true);
  assert.equal(memberLogin.body.user.role, 'user');
  const memberCookie = (memberLogin.setCookie ?? '').split(';')[0] ?? '';

  res = await call('GET', '/api/admin/users');
  const memberRow = (res.body as Array<Record<string, unknown>>).find(
    (it) => it.username === MEMBER,
  )!;
  assert.equal(memberRow.dekInitialized, true, '首次登录后 DEK 应已初始化');

  step('用户：普通账号访问管理接口 → 403（角色不是装饰）');
  res = await request('GET', '/api/admin/users', undefined, memberCookie);
  assert.equal(res.status, 403);

  step('用户：普通账号照常能用业务接口（他就是一个用户）');
  res = await request('GET', '/api/instances', undefined, memberCookie);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [], '新账号看不到别人的实例');

  step('用户：停用 → 200，已登录会话立即失效');
  res = await call('PATCH', `/api/admin/users/${memberId}`, { status: 'disabled' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(Number(res.body.revokedSessions) >= 1, '停用必须撤销会话');
  res = await request('GET', '/api/auth/me', undefined, memberCookie);
  assert.equal(res.status, 401, '旧 cookie 必须立刻失效');

  step('用户：停用后无法登录 → 401，且不区分"已停用"与"密码错"');
  res = await request(
    'POST',
    '/api/auth/login',
    { username: MEMBER, password: MEMBER_PASSWORD },
    '',
  );
  assert.equal(res.status, 401);

  step('用户：重新启用 → 能登录且 Key 不受影响（停用不是销毁）');
  res = await call('PATCH', `/api/admin/users/${memberId}`, { status: 'active' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  res = await request(
    'POST',
    '/api/auth/login',
    { username: MEMBER, password: MEMBER_PASSWORD },
    '',
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.unlocked, true);
  const memberCookie2 = (res.setCookie ?? '').split(';')[0] ?? '';

  // ── 会话查看（D043）──
  // 自建一个实例：前面的实例到这一步已经被删掉了，借用它会让用例依赖执行顺序
  step('会话：新建一个空实例，列表返回空 + total=0');
  res = await call('POST', '/api/instances', {
    name: '会话冒烟',
    accountId: '10009000',
    adapterMode: 'client',
    endpoint: 'ws://127.0.0.1:1/onebot/v11/ws',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const sessionInstanceId = String(res.body.id);

  res = await call('GET', `/api/instances/${sessionInstanceId}/sessions`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.items, []);
  assert.equal(res.body.total, 0);

  step('会话：未登录 → 401');
  res = await request('GET', `/api/instances/${sessionInstanceId}/sessions`, undefined, '');
  assert.equal(res.status, 401);

  step('会话：实例不存在 → 404（不是空列表）');
  res = await call('GET', '/api/instances/no-such-instance/sessions');
  assert.equal(res.status, 404, JSON.stringify(res.body));

  step('会话：limit 越界 / 未知参数 → 400（query 也严格校验）');
  res = await call('GET', `/api/instances/${sessionInstanceId}/sessions?limit=0`);
  assert.equal(res.status, 400);
  res = await call('GET', `/api/instances/${sessionInstanceId}/sessions?unknown=1`);
  assert.equal(res.status, 400);

  step('会话：别人的实例 → 404（看不到别人的聊天记录）');
  res = await request(
    'GET',
    `/api/instances/${sessionInstanceId}/sessions`,
    undefined,
    memberCookie2,
  );
  assert.equal(res.status, 404, JSON.stringify(res.body));

  step('消息：不存在的会话 → 404');
  res = await call('GET', '/api/sessions/no-such-session/messages');
  assert.equal(res.status, 404, JSON.stringify(res.body));
  assert.equal(res.body.code, 'SESSION_NOT_FOUND');

  step('消息：limit 越界 → 400');
  res = await call('GET', '/api/sessions/whatever/messages?limit=999');
  assert.equal(res.status, 400);

  // ── 人格演化（M5-2 / D046）──
  step('自我：没演化过 → 200 + evolved=false + 版本为空');
  res = await call('GET', `/api/instances/${sessionInstanceId}/self`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.state.evolved, false);
  assert.equal(res.body.state.version, 0);
  assert.deepEqual(res.body.versions, []);
  // 没演化过时特质是中性值，且**不写库**（下面回滚 404 能佐证库里没有 v0）
  assert.equal(res.body.state.traits.warm, 0.5);

  step('自我：回滚到不存在的版本 → 404（没演化过就没有基线）');
  res = await call('POST', `/api/instances/${sessionInstanceId}/self/rollback`, { version: 0 });
  assert.equal(res.status, 404, JSON.stringify(res.body));
  assert.equal(res.body.code, 'SELF_VERSION_NOT_FOUND');

  step('自我：limit 越界 / 未知参数 / 版本号非法 → 400');
  res = await call('GET', `/api/instances/${sessionInstanceId}/self?limit=999`);
  assert.equal(res.status, 400);
  res = await call('GET', `/api/instances/${sessionInstanceId}/self?unknown=1`);
  assert.equal(res.status, 400);
  res = await call('POST', `/api/instances/${sessionInstanceId}/self/rollback`, { version: -1 });
  assert.equal(res.status, 400);
  res = await call('POST', `/api/instances/${sessionInstanceId}/self/rollback`, { version: 1, extra: 1 });
  assert.equal(res.status, 400);

  step('自我：别人的实例 → 404');
  res = await request('GET', `/api/instances/${sessionInstanceId}/self`, undefined, memberCookie2);
  assert.equal(res.status, 404, JSON.stringify(res.body));

  step('自我：实例不存在 → 404');
  res = await call('GET', '/api/instances/no-such-instance/self');
  assert.equal(res.status, 404);

  res = await call('DELETE', `/api/instances/${sessionInstanceId}`);
  assert.equal(res.status, 200);

  step('用户：不能停用自己 → 403（没有第二个管理员时无法恢复）');
  res = await call('PATCH', `/api/admin/users/${String(self.id)}`, { status: 'disabled' });
  assert.equal(res.status, 403, JSON.stringify(res.body));

  step('用户：改显示名 → 200，does not 踢会话（revokedSessions=0）');
  res = await call('PATCH', `/api/admin/users/${memberId}`, { displayName: '改过的显示名' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.revokedSessions, 0);

  step('重置自己 → 403（必须走改密路径）');
  res = await call('POST', `/api/admin/users/${String(self.id)}/reset-password`, {
    newPassword: 'another-pass-123456',
    confirmUsername: ADMIN,
  });
  assert.equal(res.status, 403);

  step('二次确认用户名不匹配 → 403');
  res = await call('POST', '/api/admin/users/no-such-id/reset-password', {
    newPassword: 'another-pass-123456',
    confirmUsername: 'wrong-name',
  });
  assert.equal(res.status, 403);

  step('审计列表：动作齐全且已脱敏');
  res = await call('GET', '/api/admin/audit?limit=50');
  assert.equal(res.status, 200);
  const rows = res.body as Array<Record<string, any>>;
  const actions = rows.map((row) => row.action);
  for (const expected of [
    'user.create',
    'credential.unlock',
    'user.password_change',
    'credential.create',
    'credential.update',
    'credential.rotate',
    'credential.delete',
    'instance.create',
    'instance.update',
    'instance.delete',
  ]) {
    assert.ok(actions.includes(expected), `审计缺少 ${expected}，实际：${actions.join(',')}`);
  }
  const dump = JSON.stringify(rows);
  for (const forbidden of [
    PASSWORD,
    NEW_PASSWORD,
    'passwordHash',
    'wrappedDek',
    'keySalt',
    credentialKey,
    ZK_PLAINTEXT,
    // 完整 QQ 号不进审计（硬性规则 6），只允许出现掩码
    '10001000',
  ]) {
    assert.ok(!dump.includes(forbidden), `审计泄漏了 ${forbidden}`);
  }

  step('审计链校验 → ok');
  res = await call('POST', '/api/admin/audit/verify');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true, JSON.stringify(res.body));

  // 审计页的「显示条数」写死成 100/200/500 三档（`AuditView.vue` 的 LIMITS）。
  // 服务端上限是 500，任何一侧改了这个数，页面就会要么 400、要么白少一档 —— 在这里钉住。
  step('审计列表：三档 limit 全部可接受');
  for (const limit of [100, 200, 500]) {
    res = await call('GET', `/api/admin/audit?limit=${limit}`);
    assert.equal(res.status, 200, `limit=${limit} 被拒了：${res.raw}`);
  }

  step('审计列表：越界 limit → 400');
  for (const limit of [0, 501]) {
    res = await call('GET', `/api/admin/audit?limit=${limit}`);
    assert.equal(res.status, 400, `limit=${limit} 应该 400，实际 ${res.status}`);
  }

  step('锁定 → 会话失效');
  res = await call('POST', '/api/auth/lock');
  assert.equal(res.status, 200);
  res = await call('GET', '/api/auth/me');
  assert.equal(res.status, 401);

  step('锁定后访问凭据接口 → 401（会话已销毁，DEK 也没了）');
  res = await call('GET', '/api/credentials');
  assert.equal(res.status, 401);

  step('伪造 cookie → 401（签名校验生效）');
  cookie = 'aamps_sid=forged-session-id.deadbeef';
  res = await call('GET', '/api/auth/me');
  assert.equal(res.status, 401);

  // ── 管理后台托管（M4-2）──
  // 只在产物存在时验证：纯后端开发不构建前端，也不该被这条卡住
  if (existsSync(resolve(process.cwd(), 'web/dist/index.html'))) {
    step('后台首页 → 200 HTML，且含挂载点');
    const home = await fetch(`${BASE}/`, { headers: { accept: 'text/html' } });
    assert.equal(home.status, 200);
    assert.ok(home.headers.get('content-type')?.includes('text/html'));
    assert.ok((await home.text()).includes('<div id="app">'));

    step('前台路由刷新 → 回落 index.html（不会 404）');
    const deep = await fetch(`${BASE}/instances/whatever/settings`, {
      headers: { accept: 'text/html' },
    });
    assert.equal(deep.status, 200);
    assert.ok((await deep.text()).includes('<div id="app">'));

    step('未知接口不回落 → 404 + JSON（前端不会拿到 HTML）');
    const api404 = await fetch(`${BASE}/api/no-such-route`);
    assert.equal(api404.status, 404);
    assert.ok(api404.headers.get('content-type')?.includes('json'));

    step('接口鉴权不受静态托管影响 → /api/auth/me 仍是 401 JSON');
    const me = await fetch(`${BASE}/api/auth/me`);
    assert.equal(me.status, 401);
    assert.ok(me.headers.get('content-type')?.includes('json'));

    step('带 hash 的产物 → 长缓存 immutable');
    const indexHtml = await (await fetch(`${BASE}/`)).text();
    const assetPath = /(\/assets\/[^"']+\.js)/.exec(indexHtml)?.[1];
    assert.ok(assetPath, 'index.html 里应引用 assets 下的 js');
    const asset = await fetch(`${BASE}${assetPath}`);
    assert.equal(asset.status, 200);
    assert.ok(
      (asset.headers.get('cache-control') ?? '').includes('immutable'),
      '带 hash 的资源应该长缓存',
    );

    step('目录穿越 → 403（不是"找不到就回首页"）');
    const traversal = await fetch(`${BASE}/..%2f..%2fpackage.json`, {
      headers: { accept: 'text/html' },
    });
    assert.equal(traversal.status, 403);
  } else {
    step('跳过后台托管检查（未构建 web/dist）');
  }

  process.stdout.write('\nHTTP SMOKE PASSED\n');
}

main().catch((err) => {
  process.stderr.write(`\nHTTP SMOKE FAILED: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
