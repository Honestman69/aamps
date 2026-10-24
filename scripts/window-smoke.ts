/**
 * 会话窗口 + 引用决策在真实数据库上的冒烟。
 *
 * 单测覆盖的是纯函数；这里验证的是 SQL 侧那几件事：
 *   - 按 target 定位（它可能不在"最近 N 条"里）
 *   - before/after 的 lt/gt 边界
 *   - afterTotals 的 count 与发言人数是**全量**，不受切片 limit 影响
 *   - 跨会话拿别人的 messageId 读不到
 *
 * 用法：
 *   rm -f data/window-smoke.db
 *   DATABASE_URL="file:../data/window-smoke.db" npx prisma migrate deploy
 *   DATABASE_URL="file:../data/window-smoke.db" npx tsx scripts/window-smoke.ts
 */

import assert from 'node:assert/strict';

import { PrismaClient } from '@prisma/client';

import { parseQuoteTendency } from '../src/modules/persona/quote';
import { decideQuote } from '../src/modules/persona/quote';
import {
  DEFAULT_WINDOW_LIMITS,
  buildWindow,
  flattenWindow,
  windowQuoteFacts,
} from '../src/modules/session/window';
import { PrismaSessionWindowRepository } from '../src/modules/session/repositories/prisma-session-window.repository';

const prisma = new PrismaClient();
const BOT = 'bot-self';

async function seedMessages(
  sessionId: string,
  rows: Array<{ role: string; senderId: string; content: string; at: Date }>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const row of rows) {
    const created = await prisma.message.create({
      data: {
        sessionId,
        role: row.role,
        senderId: row.senderId,
        senderName: row.senderId,
        content: row.content,
        createdAt: row.at,
      },
    });
    ids.push(created.id);
  }
  return ids;
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

async function main(): Promise<void> {
  const tenant = await prisma.tenant.create({ data: { name: '窗口冒烟' } });
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: 'window_smoke_user',
      passwordHash: 'not-a-real-hash',
      keySalt: '00'.repeat(16),
      wrappedDek: 'wrap:v1:placeholder',
    },
  });
  const instance = await prisma.botInstance.create({
    data: {
      tenantId: tenant.id,
      ownerUserId: user.id,
      name: '窗口冒烟号',
      accountId: '90002',
    },
  });

  const groupSession = await prisma.session.create({
    data: { instanceId: instance.id, kind: 'group', peerId: 'group-1', peerName: '测试群' },
  });
  const otherSession = await prisma.session.create({
    data: { instanceId: instance.id, kind: 'private', peerId: 'peer-9' },
  });

  // 群聊：target 是第 3 条（50 分钟前），后面刷了 40 条，3 个人在说
  const rows = [
    { role: 'user', senderId: 'alice', content: '开场', at: minutesAgo(52) },
    { role: 'user', senderId: 'bob', content: '插一句', at: minutesAgo(51) },
    { role: 'user', senderId: 'alice', content: '这个功能怎么做', at: minutesAgo(50) },
  ];
  for (let i = 0; i < 40; i += 1) {
    const speakers = ['bob', 'carol', 'alice'];
    rows.push({
      role: 'user',
      senderId: speakers[i % 3] as string,
      content: `刷屏第 ${i + 1} 条`,
      at: minutesAgo(49 - i),
    });
  }
  const groupIds = await seedMessages(groupSession.id, rows);
  const targetId = groupIds[2] as string;

  const repo = new PrismaSessionWindowRepository(prisma);

  // ① 取数：target 在很靠前的位置，切片只有 10 条，但统计是全量
  const slice = await repo.loadSlice({
    sessionId: groupSession.id,
    targetMessageId: targetId,
    beforeLimit: 5,
    afterLimit: 10,
  });
  assert.ok(slice, '应当取到切片');
  assert.equal(slice.target.id, targetId);
  assert.equal(slice.before.length, 2, `before 应为 2 条，实际 ${slice.before.length}`);
  assert.equal(slice.after.length, 10, `after 切片应为 10 条，实际 ${slice.after.length}`);
  assert.equal(slice.afterTotals.count, 40, `after 全量应为 40，实际 ${slice.afterTotals.count}`);
  assert.equal(slice.afterTotals.distinctSenders, 3);
  process.stdout.write(
    `① 取数正确：before=${slice.before.length} after切片=${slice.after.length} ` +
      `全量=${slice.afterTotals.count} 发言人数=${slice.afterTotals.distinctSenders}\n`,
  );

  // ② 窗口：target 一定在；after 被裁但统计不受影响
  const window = buildWindow({
    targetId,
    messages: [...slice.before, slice.target, ...slice.after],
    limits: DEFAULT_WINDOW_LIMITS.group,
    now: new Date(),
  });
  assert.ok(window, '窗口应存在');
  const flat = flattenWindow(window);
  assert.equal(flat.findIndex((m) => m.id === targetId), window.before.length);
  assert.ok(window.after.length <= 10, '窗口里的 after 不会超过切片');
  process.stdout.write(
    `② 窗口组装正确：共 ${flat.length} 条，target 在位置 ${window.before.length}，` +
      `after 保留 ${window.after.length} 条\n`,
  );

  // ③ 引用决策：必须引用（多人在说），且依据是全量统计而不是切片长度
  const facts = windowQuoteFacts(window);
  const decision = decideQuote({
    channel: 'group',
    target: facts.target,
    after: facts.after,
    afterTotals: facts.afterTotals,
    incomingQuotesBot: false,
    selfId: BOT,
    tendency: parseQuoteTendency('never'),
    now: new Date(),
  });
  assert.equal(decision.quote, true, '多人在说时必须引用');
  assert.equal(decision.reason, 'multi_speaker');
  process.stdout.write(`③ 引用决策正确：${decision.reason}（即使人格设为 never 也要引用）\n`);

  // ④ 私聊：回复最后一条 → 不引用（纯冗余）
  const privateRows = [
    { role: 'user', senderId: 'peer-9', content: '在吗', at: minutesAgo(3) },
    { role: 'assistant', senderId: BOT, content: '在', at: minutesAgo(2) },
    { role: 'user', senderId: 'peer-9', content: '问你个事', at: minutesAgo(1) },
  ];
  const privateIds = await seedMessages(otherSession.id, privateRows);
  const privateSlice = await repo.loadSlice({
    sessionId: otherSession.id,
    targetMessageId: privateIds[2] as string,
    beforeLimit: 10,
    afterLimit: 10,
  });
  assert.ok(privateSlice);
  assert.equal(privateSlice.afterTotals.count, 0);

  const privateDecision = decideQuote({
    channel: 'private',
    target: {
      id: privateSlice.target.id,
      senderId: privateSlice.target.senderId as string,
      createdAt: privateSlice.target.createdAt,
    },
    after: [],
    afterTotals: privateSlice.afterTotals,
    incomingQuotesBot: false,
    selfId: BOT,
    tendency: 'normal',
    now: new Date(),
  });
  assert.equal(privateDecision.quote, false);
  assert.equal(privateDecision.reason, 'redundant');
  process.stdout.write('④ 私聊回最后一条：不引用（redundant）\n');

  // ⑤ 跨会话：拿别的会话的 messageId 读不到
  const crossSession = await repo.loadSlice({
    sessionId: otherSession.id,
    targetMessageId: targetId, // 属于 groupSession
    beforeLimit: 5,
    afterLimit: 5,
  });
  assert.equal(crossSession, null, '跨会话读取必须返回 null');
  process.stdout.write('⑤ 跨会话读取被拒绝（返回 null）\n');

  // ⑥ 不存在的消息
  const missing = await repo.loadSlice({
    sessionId: groupSession.id,
    targetMessageId: 'no-such-message',
    beforeLimit: 5,
    afterLimit: 5,
  });
  assert.equal(missing, null);
  process.stdout.write('⑥ 不存在的消息返回 null\n');

  process.stdout.write('\nWINDOW SMOKE PASSED\n');
}

main()
  .catch((err) => {
    process.stdout.write(`\nWINDOW SMOKE FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
