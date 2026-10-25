/**
 * Pipeline 端到端冒烟：真实 SQLite + 真实 Prisma 仓储，走一遍"私聊能对话"。
 *
 * 单元测试用假仓储，这一步验证的是**真实 SQL 层**：
 *   upsert 会话 → 入站落库 → 窗口取数（按 target 定位）→ 拼 prompt →（Gateway stub）→
 *   引用决策 → 出站落库。
 *
 * Gateway 用 stub 而不是真调 LLM：真调要花 API 钱，而这里要验证的是"编排 + SQL"，
 * 不是模型质量。模型接入本身由 `scripts/http-smoke.ts`（连真服务）覆盖。
 *
 * 用法（独立库，别碰 dev.db）：
 *   rm -f data/pipeline-smoke.db
 *   DATABASE_URL="file:../data/pipeline-smoke.db" npx prisma migrate deploy
 *   DATABASE_URL="file:../data/pipeline-smoke.db" npx tsx scripts/pipeline-smoke.ts
 */

import assert from 'node:assert/strict';

import { PrismaClient } from '@prisma/client';
import type { InboundMessage, OutboundAction } from '@newjob/contracts';

import { encryptWithDek, randomDek } from '../src/common/crypto';
import { RuntimeKeyStore } from '../src/modules/auth/runtime-key-store';
import { GatewayService } from '../src/modules/model/gateway/gateway.service';
import { PrismaMindStateRepository } from '../src/modules/mind/state/repositories/prisma-mind-state.repository';
import { PrismaPipelineRepository } from '../src/modules/pipeline/repositories/prisma-pipeline.repository';
import { PipelineService } from '../src/modules/pipeline/pipeline.service';
import { PrismaSessionRepository } from '../src/modules/session/repositories/prisma-session.repository';
import { PrismaSessionWindowRepository } from '../src/modules/session/repositories/prisma-session-window.repository';
import { DEFAULT_AGENT_CONFIG } from '../src/modules/config/types';

const prisma = new PrismaClient();
const DEK = randomDek();
const SESSION = 'smoke-session';

/** 固定返回"你好呀"的 Gateway stub，不真出网 */
const gatewayStub = {
  chat: async (input: unknown): Promise<{
    text: string;
    model: string;
    provider: string;
    credentialId: string;
    usage: { tokenIn: number; tokenOut: number };
    costCents: number;
    attempts: never[];
  }> => {
    return {
      text: '你好呀，我是小雅',
      model: 'deepseek-chat',
      provider: 'deepseek',
      credentialId: 'cred-1',
      usage: { tokenIn: 10, tokenOut: 5 },
      costCents: 1,
      attempts: [],
    };
  },
} as unknown as GatewayService;

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: `smoke-msg-${Math.random().toString(36).slice(2, 8)}`,
    platform: 'qq',
    instanceId: overrides.instanceId ?? 'inst-1',
    session: { kind: 'private', peerId: 'peer-1' },
    sender: { id: 'peer-1', name: '阿明', isOwner: false },
    segments: [{ type: 'text', text: '你好' }],
    plainText: '你好',
    isMentioned: false,
    receivedAt: new Date(),
    ...overrides,
  };
}

async function main(): Promise<void> {
  const tenant = await prisma.tenant.create({ data: { name: 'Pipeline 冒烟' } });
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      username: 'pipeline_smoke_user',
      passwordHash: 'not-a-real-hash',
      keySalt: '00'.repeat(16),
      wrappedDek: 'wrap:v1:placeholder',
    },
  });

  // 建一个实例，绑一个默认人设（验证 prompt 拼装走真实 Persona 字段）
  const instance = await prisma.botInstance.create({
    data: {
      tenantId: tenant.id,
      ownerUserId: user.id,
      name: '小雅',
      accountId: 'bot-1',
      adapterMode: 'client',
    },
  });

  const persona = await prisma.persona.create({
    data: {
      instanceId: instance.id,
      name: '小雅',
      tagline: '22 岁，话多、心软',
      identityJson: JSON.stringify({ name: '小雅', age: 22, gender: '女' }),
      examplesJson: '[]',
      fallbacksJson: JSON.stringify({
        shortOutage: { private: '稍等', group: null },
        longOutage: { private: '晚点找你', group: null },
        budgetLimit: { private: '今天累了', group: null },
      }),
      quoteTendency: 'normal',
    },
  });
  await prisma.botInstance.update({
    where: { id: instance.id },
    data: { activePersonaId: persona.id },
  });

  const pipelineRepo = new PrismaPipelineRepository(prisma);
  const sessionRepo = new PrismaSessionRepository(prisma);
  const windowRepo = new PrismaSessionWindowRepository(prisma);
  const mindRepo = new PrismaMindStateRepository(prisma);
  const keyStore = new RuntimeKeyStore();
  keyStore.set(SESSION, user.id, DEK);

  const config = {
    get: async () => ({
      config: DEFAULT_AGENT_CONFIG,
      sessionFlags: { aiPaused: false, reviewMode: false, muted: false },
    }),
  };

  const sent: OutboundAction[] = [];
  const pipeline = new PipelineService({
    pipeline: pipelineRepo,
    sessions: sessionRepo,
    windowRepo,
    mind: mindRepo,
    config,
    gateway: gatewayStub,
    clock: () => new Date(),
  });

  // ① 第一条消息：私聊，回最后一条 → 不引用
  await pipeline.handle(inbound({ instanceId: instance.id, plainText: '你好', segments: [{ type: 'text', text: '你好' }] }), async (a) => {
    sent.push(a);
    return { messageId: 'out-1' };
  });

  assert.equal(sent.length, 1, '第一条消息应出站一次');
  const first = sent[0];
  assert.equal(first?.kind, 'send');
  if (first?.kind === 'send') {
    assert.equal(first.replyToMessageId, undefined, '私聊回最后一条不应引用');
    assert.equal(first.segments[0]?.type === 'text' ? first.segments[0].text : '', '你好呀，我是小雅');
  }

  // 验证落库：第一条消息后应有 2 条（入站 + 出站）
  const firstMessageCount = await prisma.message.count();
  assert.equal(firstMessageCount, 2, '应有一条入站 + 一条出站');
  process.stdout.write(`① 第一条消息：出站 1 次、不引用、落库 2 条消息\n`);

  // ② 连续多轮：每轮都是"回最新一条"，私聊里即时回复不应引用
  for (const text of ['在吗', '问你个事']) {
    await pipeline.handle(
      inbound({ instanceId: instance.id, plainText: text, segments: [{ type: 'text', text }] }),
      async (a) => {
        sent.push(a);
        return { messageId: 'out-x' };
      },
    );
  }
  assert.equal(sent.length, 3, '三轮对话应出站 3 次');
  // 每轮都是即时回复（target 就是最新一条），私聊都不应引用
  for (const a of sent) {
    if (a.kind === 'send') {
      assert.equal(a.replyToMessageId, undefined, '私聊即时回复不应引用');
    }
  }
  process.stdout.write(`② 连续三轮对话，均即时回复、不引用\n`);

  // 验证窗口取数：现在库里应有 6 条消息（3 入 + 3 出）
  const totalMessages = await prisma.message.count();
  assert.equal(totalMessages, 6, `应有 6 条消息，实际 ${totalMessages}`);
  process.stdout.write(`③ 落库正确：${totalMessages} 条消息\n`);

  // ④ 会话唯一：同一 peer 只 upsert 出一个会话
  const sessionCount = await prisma.session.count({ where: { instanceId: instance.id } });
  assert.equal(sessionCount, 1, '同一 peer 不应重复建会话');
  process.stdout.write(`④ 会话唯一：${sessionCount} 个\n`);

  // ⑤ M3 状态：三轮对话后应有且只有一行 AgentState，精力被消耗、时间戳推进
  const state = await prisma.agentState.findUnique({ where: { instanceId: instance.id } });
  assert.ok(state, '对话后应写入 AgentState');
  assert.ok(state.energy <= 0.8, `回话应消耗精力，实际 ${state.energy}`);
  assert.ok(state.lastDecayAt <= new Date(), 'lastDecayAt 不应在未来');
  const stateRows = await prisma.agentState.count({ where: { instanceId: instance.id } });
  assert.equal(stateRows, 1, 'AgentState 应按实例 upsert 成一行');
  process.stdout.write(`⑤ AgentState 单行 upsert：energy=${state.energy.toFixed(3)}\n`);

  // ⑥ M3 关系：亲密度随交互增长，且同一对方只有一行
  const rel = await prisma.relationship.findUnique({
    where: { instanceId_peerId: { instanceId: instance.id, peerId: 'peer-1' } },
  });
  assert.ok(rel, '对话后应写入 Relationship');
  assert.ok(rel.affinity > 0, `亲密度应随交互增长，实际 ${rel.affinity}`);
  assert.ok(rel.lastInteractionAt, 'lastInteractionAt 应有值');
  process.stdout.write(`⑥ Relationship 单行 upsert：affinity=${rel.affinity}\n`);

  process.stdout.write('\nPIPELINE SMOKE PASSED\n');
}

main()
  .catch((err) => {
    process.stdout.write(`\nPIPELINE SMOKE FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
