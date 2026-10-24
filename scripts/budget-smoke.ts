/**
 * 预算链路的真实数据库冒烟。
 *
 * 为什么需要它：单测用的是假仓储，返回的是写死的数字，**真实 SQL 聚合从来没被验证过**。
 * 而预算最容易错的地方恰好就在 SQL 里——时间窗口带不带、`_sum` 返回 null 怎么办、
 * 跨天/跨月边界对不对。这些错了不会被单测发现，只会表现成"限额有时候不生效"。
 *
 * 用法（用独立库，别碰 dev.db）：
 *   rm -f data/budget-smoke.db
 *   DATABASE_URL="file:../data/budget-smoke.db" npx prisma migrate deploy
 *   DATABASE_URL="file:../data/budget-smoke.db" npx tsx scripts/budget-smoke.ts
 */

import assert from 'node:assert/strict';

import { PrismaClient } from '@prisma/client';

import { encryptWithDek, randomDek } from '../src/common/crypto';
import { GatewayFailedError, GatewayService } from '../src/modules/model/gateway/gateway.service';
import { PrismaGatewayRepository } from '../src/modules/model/gateway/repositories/prisma-gateway.repository';
import { DEFAULT_AGENT_CONFIG, type AgentConfig } from '../src/modules/config/types';
import { RuntimeKeyStore } from '../src/modules/auth/runtime-key-store';

const prisma = new PrismaClient();
const DEK = randomDek();
const SESSION = 'smoke-session';
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number, hour = 12): Date {
  const d = new Date(Date.now() - days * DAY);
  d.setHours(hour, 0, 0, 0);
  return d;
}

async function main(): Promise<void> {
  const tenant = await prisma.tenant.create({ data: { name: '冒烟租户' } });
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: 'budget_smoke_user',
      passwordHash: 'not-a-real-hash',
      keySalt: '00'.repeat(16),
      wrappedDek: 'wrap:v1:placeholder',
    },
  });

  const instance = await prisma.botInstance.create({
    data: {
      tenantId: tenant.id,
      ownerUserId: user.id,
      name: '预算冒烟号',
      accountId: '90001',
      platform: 'qq',
      adapterMode: 'client',
      dailyBudgetCents: 100,
      monthlyBudgetCents: 2000,
      budgetPolicy: 'block',
    },
  });

  const credential = await prisma.credential.create({
    data: {
      tenantId: tenant.id,
      ownerUserId: user.id,
      provider: 'deepseek',
      label: '冒烟 Key',
      apiKeyEnc: encryptWithDek('sk-smoke-key', DEK),
      keyMasked: 'sk-****-key',
      catalogJson: JSON.stringify([
        { id: 'deepseek-chat', priceInPerM: 100, priceOutPerM: 200 },
        { id: 'deepseek-lite', priceInPerM: 10, priceOutPerM: 20 },
      ]),
    },
  });

  const usage = (costCents: number, at: Date, model = 'deepseek-chat') =>
    prisma.modelUsage.create({
      data: {
        instanceId: instance.id,
        credentialId: credential.id,
        ownerUserId: user.id,
        provider: 'deepseek',
        model,
        tokenIn: 1000,
        tokenOut: 1000,
        costCents,
        purpose: 'chat',
        createdAt: at,
      },
    });

  // 今天的 40 分 + 昨天 50 分 + 上个月 300 分
  await usage(40, daysAgo(0));
  await usage(50, daysAgo(1));
  await usage(300, daysAgo(40));

  const repo = new PrismaGatewayRepository(prisma);
  const now = new Date();
  const dayStart = new Date(now.getTime());
  dayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

  // ① 真实聚合：今天只算今天，本月不含上月
  const totals = await repo.usageTotals(instance.id, { dayStart, monthStart });
  assert.equal(totals.todayCents, 40, `今日应为 40，实际 ${totals.todayCents}`);
  assert.equal(totals.monthCents, 90, `本月应为 90（40+50），实际 ${totals.monthCents}`);
  process.stdout.write(`① 聚合正确：今日=${totals.todayCents} 本月=${totals.monthCents}\n`);

  // ② 没有任何用量时 `_sum` 为 null，必须是 0 而不是 NaN/null
  const empty = await repo.usageTotals('no-such-instance', { dayStart, monthStart });
  assert.equal(empty.todayCents, 0);
  assert.equal(empty.monthCents, 0);
  process.stdout.write('② 空实例返回 0（不是 null）\n');

  // ③ 未超预算：正常放行（全局 fetch 打桩，不出网）
  const keyStore = new RuntimeKeyStore();
  keyStore.set(SESSION, user.id, DEK);
  const seenModel: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    seenModel.push(body.model);
    return new Response(
      JSON.stringify({
        model: body.model,
        choices: [{ message: { content: '在' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const configFor = (overrides: Partial<AgentConfig>): AgentConfig => ({
    ...DEFAULT_AGENT_CONFIG,
    credentialId: credential.id,
    dailyBudgetCents: 100,
    monthlyBudgetCents: 2000,
    budgetPolicy: 'block',
    ...overrides,
  });

  let config = configFor({});
  const gateway = new GatewayService({
    repo,
    config: { get: async () => ({ config }) },
    keyStore,
  });

  const result = await gateway.chat({
    instanceId: instance.id,
    ownerUserId: user.id,
    sessionId: SESSION,
    purpose: 'chat',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(result.costCents > 0, true, '成功后应记了费');
  assert.equal(result.budget, undefined, '没超预算不该带降级标记');
  process.stdout.write(`③ 未超预算正常调用，本次花费 ${result.costCents} 分\n`);

  // ④ 花到 100 分（等于日预算）后必须拒绝
  const after = await repo.usageTotals(instance.id, { dayStart, monthStart });
  if (after.todayCents < 100) {
    await usage(100 - after.todayCents, new Date());
  }

  const before = seenModel.length;
  const err = await gateway
    .chat({
      instanceId: instance.id,
      ownerUserId: user.id,
      sessionId: SESSION,
      purpose: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    })
    .catch((e: unknown) => e);

  assert.ok(err instanceof GatewayFailedError, '超预算应抛 GatewayFailedError');
  assert.equal(err.reason, 'budget_exhausted');
  assert.equal(err.budget?.over, 'daily');
  assert.equal(err.budget?.because, 'policy');
  assert.equal(seenModel.length, before, '超预算时不应发起任何模型调用');
  process.stdout.write(
    `④ 达到日预算即拒绝：今日已花 ${err.budget?.todayCents} / 上限 ${err.budget?.dailyBudgetCents}\n`,
  );

  // ⑤ 同一份数据换成 downgrade，应该改走 cheap 模型
  config = configFor({ budgetPolicy: 'downgrade', modelCheap: 'deepseek-lite' });
  const downgraded = await gateway.chat({
    instanceId: instance.id,
    ownerUserId: user.id,
    sessionId: SESSION,
    purpose: 'chat',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(downgraded.model, 'deepseek-lite');
  assert.deepEqual(downgraded.budget, { downgraded: true, over: 'daily' });
  assert.equal(seenModel.at(-1), 'deepseek-lite', '发给厂商的 model 必须是 cheap');
  process.stdout.write(`⑤ 降级生效：实际调用 ${downgraded.model}，记为 downgraded\n`);

  globalThis.fetch = originalFetch;
  process.stdout.write('\nBUDGET SMOKE PASSED\n');
}

main()
  .catch((err) => {
    process.stdout.write(`\nBUDGET SMOKE FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
