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
import { existsSync } from 'node:fs';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { PLATFORM_CAPABILITIES } from '@newjob/contracts';
import type { InboundMessage, OutboundAction } from '@newjob/contracts';

import { encryptWithDek, randomDek } from '../src/common/crypto';
import { RuntimeKeyStore } from '../src/modules/auth/runtime-key-store';
import { GatewayService } from '../src/modules/model/gateway/gateway.service';
import { MediaAssetService } from '../src/modules/media/assets/asset.service';
import { PrismaMediaAssetRepository } from '../src/modules/media/assets/repositories/prisma-media-asset.repository';
import type { IImageFetcher } from '../src/modules/media/fetcher';
import { LocalMediaFileStore } from '../src/modules/media/file-store';
import { TtsService } from '../src/modules/media/tts';
import { PrismaMindStateRepository } from '../src/modules/mind/state/repositories/prisma-mind-state.repository';
import { MemoryService, type ReflectionModel } from '../src/modules/memory/memory.service';
import { PrismaMemoryRepository } from '../src/modules/memory/repositories/prisma-memory.repository';
import { PrismaPipelineRepository } from '../src/modules/pipeline/repositories/prisma-pipeline.repository';
import { PipelineService } from '../src/modules/pipeline/pipeline.service';
import { PrismaSessionAdminRepository } from '../src/modules/session/repositories/prisma-session-admin.repository';
import { PrismaSessionRepository } from '../src/modules/session/repositories/prisma-session.repository';
import { SessionAdminService } from '../src/modules/session/session-admin.service';
import { PrismaSessionWindowRepository } from '../src/modules/session/repositories/prisma-session-window.repository';
import { DEFAULT_AGENT_CONFIG } from '../src/modules/config/types';

const prisma = new PrismaClient();
const DEK = randomDek();
const SESSION = 'smoke-session';
/** QQ 的能力声明：图片与语音都支持 */
const CAPS = PLATFORM_CAPABILITIES.qq;

/** 可变回复：用来切换"模型决定用图片/语音回"的场景 */
let gatewayReply = '你好呀，我是小雅';
/** 可变配置：媒体能力要显式打开（D033） */
let agentConfig: typeof DEFAULT_AGENT_CONFIG = { ...DEFAULT_AGENT_CONFIG };

/** A 阶段（think）返回的内心独白 */
const THINK_JSON = JSON.stringify({
  want_to_reply: 0.7,
  emotion_shift: 0.2,
  intent: '随便聊聊',
  key_points: ['接话'],
  tone: '轻松',
  length_hint: '短',
});

/** 反思（M5-1）返回的记忆：一句摘要 + 一条事实，固定内容便于断言与去重 */
const MEMORY_JSON = JSON.stringify({
  summary: '他聊了聊最近的加班和家里的猫。',
  facts: [{ content: '他养了一只叫豆豆的猫', kind: 'fact', importance: 5 }],
});

/** 记录每次调用的 purpose：验证双阶段（think → chat） */
const purposes: string[] = [];

/** 记录 chat 阶段发给模型的 system（验证记忆有没有真的进 prompt） */
const systemPrompts: string[] = [];

/** 固定返回"你好呀"的 Gateway stub，不真出网 */
const gatewayStub = {
  chat: async (input: {
    purpose?: string;
    messages?: Array<{ role: string; content: unknown }>;
  }): Promise<{
    text: string;
    model: string;
    provider: string;
    credentialId: string;
    usage: { tokenIn: number; tokenOut: number };
    costCents: number;
    attempts: never[];
  }> => {
    purposes.push(input.purpose ?? 'chat');
    if (input.purpose === 'reflection') {
      return {
        text: MEMORY_JSON,
        model: 'deepseek-chat',
        provider: 'deepseek',
        credentialId: 'cred-1',
        usage: { tokenIn: 20, tokenOut: 10 },
        costCents: 0,
        attempts: [],
      };
    }
    if (input.purpose === 'think') {
      return {
        text: THINK_JSON,
        model: 'deepseek-chat',
        provider: 'deepseek',
        credentialId: 'cred-1',
        usage: { tokenIn: 5, tokenOut: 5 },
        costCents: 0,
        attempts: [],
      };
    }
    // chat 阶段：把 system 记下来，后面验证"记忆真的进了 prompt"
    const system = input.messages?.[0]?.content;
    systemPrompts.push(typeof system === 'string' ? system : '');

    return {
      text: gatewayReply,
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
      config: agentConfig,
      sessionFlags: { aiPaused: false, reviewMode: false, muted: false },
    }),
  };

  // 语音合成：不真的出网，只验证"调度 + 落盘 + 出站段"这条链
  // 图片抓取：不出网，直接给固定字节（冒烟验证的是落盘与出站段，不是图床）
  const imageFetcher: IImageFetcher = {
    fetch: async () => ({ data: Buffer.from('smoke-png-bytes'), mime: 'image/png' }),
    fetchAsDataUrl: async () => ({
      dataUrl: 'data:image/png;base64,c21va2UtcG5nLWJ5dGVz',
      bytes: 16,
    }),
  };
  const mediaDir = `${process.cwd()}/data/media-smoke`;
  const assetService = new MediaAssetService({
    repo: new PrismaMediaAssetRepository(prisma),
    store: new LocalMediaFileStore(mediaDir),
    images: imageFetcher,
  });

  const tts = new TtsService({
    credentials: {
      findForUser: async () => ({
        id: 'cred-tts',
        provider: 'openai',
        baseUrl: 'https://api.example.com/v1',
        authStyle: 'bearer',
        apiKeyEnc: encryptWithDek('sk-smoke-tts', DEK),
      }),
    },
    keyStore,
    store: new LocalMediaFileStore(mediaDir),
    speak: async () => Buffer.from('ID3-fake-mp3'),
  });

  const sent: OutboundAction[] = [];
  const sleeps: number[] = [];

  // 记忆（M5-1）：主流程用默认阈值（30 条），保证 ①–⑪ 的断言不受反思干扰；
  // ⑫ 单独造一个"攒 2 条就反思"的实例，用真实库跑一遍写入。
  const memoryRepo = new PrismaMemoryRepository(prisma);
  const memory = new MemoryService(memoryRepo, gatewayStub as unknown as ReflectionModel);
  const memoryAggressive = new MemoryService(
    memoryRepo,
    gatewayStub as unknown as ReflectionModel,
    { reflectEvery: 2, transcriptLimit: 40, factLimit: 6, summaryLimit: 3 },
  );

  const baseDeps = {
    pipeline: pipelineRepo,
    sessions: sessionRepo,
    windowRepo,
    mind: mindRepo,
    images: imageFetcher,
    tts,
    assets: assetService,
    memory,
    config,
    gateway: gatewayStub,
    clock: () => new Date(),
    // 表达层会等几秒（M3-3）；冒烟只验证"有没有请求延迟"，不真的等
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };

  const pipeline = new PipelineService(baseDeps);

  // ① 第一条消息：私聊，回最后一条 → 不引用
  await pipeline.handle(inbound({ instanceId: instance.id, plainText: '你好', segments: [{ type: 'text', text: '你好' }] }), async (a) => {
    sent.push(a);
    return { messageId: 'out-1' };
  }, { capabilities: CAPS });

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
      { capabilities: CAPS },
    );
  }
  assert.equal(sent.length, 3, '三轮对话应出站 3 次');
  // 表达层：每条前面都要请求一次延迟（拟人），且延迟有下限
  assert.ok(sleeps.length >= 3, `应请求过延迟，实际 ${sleeps.length}`);
  assert.ok(sleeps.every((ms) => ms > 0), '延迟应为正数');
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

  // ⑦ M3 媒体（D033）：模型自己决定用图片和语音回，代码负责执行
  agentConfig = {
    ...DEFAULT_AGENT_CONFIG,
    ttsCredentialId: 'cred-tts',
    ttsModel: 'tts-1',
    ttsVoice: 'nova',
  };
  gatewayReply = '给你看\n[img]https://example.com/cat.jpg[/img]\n[voice]晚安[/voice]';

  const mediaBefore = sent.length;
  await pipeline.handle(
    inbound({ instanceId: instance.id, plainText: '发张图', segments: [{ type: 'text', text: '发张图' }] }),
    async (a) => {
      sent.push(a);
      return { messageId: 'out-media' };
    },
    { capabilities: CAPS },
  );

  const mediaActions = sent.slice(mediaBefore);
  // M3-3 起：文本、图片、语音分别是独立的一条（真人也这么发）
  assert.equal(mediaActions.length, 3, '应发出三条：文本、图片、语音');
  const mediaText = mediaActions[0];
  assert.equal(mediaText?.kind, 'send');
  if (mediaText?.kind === 'send') {
    assert.equal(mediaText.segments[0]?.type, 'text');
  }
  const mediaImage = mediaActions[1];
  assert.equal(mediaImage?.kind, 'send');
  if (mediaImage?.kind === 'send') {
    const image = mediaImage.segments[0];
    assert.ok(image?.type === 'image' && image.url === 'https://example.com/cat.jpg');
  }
  const mediaVoice = mediaActions[2];
  assert.equal(mediaVoice?.kind, 'send');
  if (mediaVoice?.kind === 'send') {
    assert.equal(mediaVoice.segments[0]?.type, 'voice');
    const voice = mediaVoice.segments[0];
    if (voice?.type === 'voice') {
      // 落盘必须是真实的本地文件：NapCat 的 record.file 要的是可读路径
      assert.ok(existsSync(voice.url), `语音文件应存在：${voice.url}`);
    }
  }
  process.stdout.write(`⑦ 媒体：文本 / 图片 / 语音各 1 条，语音已落盘\n`);

  // ⑧ 素材库存（D034）：模型说"存下来"，代码把这条消息里的图落盘并建别名
  agentConfig = { ...DEFAULT_AGENT_CONFIG };
  gatewayReply = '存好了\n[save]猫猫[/save]';
  const imageMsg = inbound({
    instanceId: instance.id,
    segments: [
      { type: 'text', text: '看这个' },
      { type: 'image', url: 'http://multimedia.nt.qq.com.cn/download?fileid=x' },
    ],
    plainText: '看这个[图片]',
  });
  await pipeline.handle(
    imageMsg,
    async (a) => {
      sent.push(a);
      return { messageId: 'out-save' };
    },
    { capabilities: CAPS },
  );

  const stored = await prisma.mediaAsset.findMany({ where: { instanceId: instance.id } });
  assert.equal(stored.length, 1, '应存下一条素材');
  assert.equal(stored[0]?.alias, '猫猫');
  const assetPath = path.join(mediaDir, 'assets', `${stored[0]?.sha256}.${stored[0]?.ext}`);
  assert.ok(existsSync(assetPath), `素材文件应存在：${assetPath}`);
  process.stdout.write(`⑧ 素材库：别名「${stored[0]?.alias}」已落盘（${stored[0]?.bytes} 字节）\n`);

  // ⑨ 素材库取：模型用别名，出站 image 段指向本地文件
  gatewayReply = '喏\n[use]猫猫[/use]';
  const useBefore = sent.length;
  await pipeline.handle(
    inbound({ instanceId: instance.id, plainText: '再来一张', segments: [{ type: 'text', text: '再来一张' }] }),
    async (a) => {
      sent.push(a);
      return { messageId: 'out-use' };
    },
    { capabilities: CAPS },
  );

  const useActions = sent.slice(useBefore);
  // 文本一条 + 图片一条（M3-3 起图片单独发）
  assert.equal(useActions.length, 2, '用素材应发文本与图片各一条');
  const useImage = useActions[1];
  assert.equal(useImage?.kind, 'send');
  if (useImage?.kind === 'send') {
    const image = useImage.segments.find((seg) => seg.type === 'image');
    assert.ok(image && image.type === 'image', '应带一个图片段');
    // 路径分隔符随平台变，按"同一个文件"判断而不是按字符串
    assert.equal(path.resolve(image.url), path.resolve(assetPath), '图片段应指向素材库文件');
  }
  const used = await prisma.mediaAsset.findFirst({ where: { instanceId: instance.id } });
  assert.equal(used?.useCount, 1, '用过一次要记账');
  process.stdout.write(`⑨ 素材库：按别名取出并发送，useCount=${used?.useCount}\n`);

  // ⑩ 双阶段生成（M3-4）：A 阶段 think 用 modelCheap，B 阶段带导演指令；独白落库
  const thinkBefore = purposes.length;
  gatewayReply = '听着就累。';
  await pipeline.handle(
    inbound({ instanceId: instance.id, plainText: '今天加班到十点', segments: [{ type: 'text', text: '今天加班到十点' }] }),
    async (a) => {
      sent.push(a);
      return { messageId: 'out-think' };
    },
    { capabilities: CAPS },
  );
  assert.deepEqual(purposes.slice(thinkBefore), ['think', 'chat'], '应先 think 再 chat');
  const thinkRow = await prisma.message.findFirst({
    where: { sessionId: (await prisma.session.findFirst({ where: { instanceId: instance.id } }))!.id, role: 'assistant' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(thinkRow?.thinkJson, '回复应带上内心独白');
  assert.ok(thinkRow?.thinkJson?.includes('随便聊聊'), '独白内容应落库');
  // 情绪被这一轮推动（0.2）
  const stateAfter = await prisma.agentState.findUnique({ where: { instanceId: instance.id } });
  assert.ok((stateAfter?.mood ?? 0) > 0, `mood 应被推动，实际 ${stateAfter?.mood}`);
  process.stdout.write(`⑩ 双阶段：think → chat，独白已落库，mood=${stateAfter?.mood?.toFixed(2)}\n`);

  // ⑪ 会话查看（D043）：真实 SQL 上的列表与分页
  const adminSessions = new SessionAdminService({
    sessions: new PrismaSessionAdminRepository(prisma),
  });
  const listed = await adminSessions.listSessions({ userId: user.id }, instance.id, { limit: 20 });
  assert.equal(listed.items.length, 1, '应只有一个会话（同一 peer 只 upsert 出一条）');
  assert.ok(listed.total >= 1);
  const summaryRow = listed.items[0]!;
  assert.ok(summaryRow.messageCount > 0, `消息条数应实时算出来，实际 ${summaryRow.messageCount}`);
  assert.equal(summaryRow.lastMessage?.role, 'assistant', '最后一条应是机器人的回复');
  // 实时统计必须与真实条数一致（Session.messageCount 列从未被维护，不能拿它充数）
  const realCount = await prisma.message.count({ where: { sessionId: summaryRow.id } });
  assert.equal(summaryRow.messageCount, realCount, '实时条数必须等于库里真实条数');

  const page = await adminSessions.listMessages({ userId: user.id }, summaryRow.id, { limit: 5 });
  assert.equal(page.hasMore, true, '超过 5 条时应标记还有更早的');
  assert.equal(page.items.length, 5);
  // 返回按时间升序（界面从前到后读）
  const times = page.items.map((item) => Date.parse(item.createdAt));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), '消息应按时间升序返回');
  const older = await adminSessions.listMessages({ userId: user.id }, summaryRow.id, {
    limit: 5,
    before: page.items[0]!.id,
  });
  assert.ok(older.items.length > 0, '游标翻页应能取到更早的消息');
  assert.ok(
    Date.parse(older.items[0]!.createdAt) <= Date.parse(page.items[0]!.createdAt),
    '更早那页的时间不应晚于当前页最早那条',
  );
  // 别人的会话读不到
  const otherUser = await prisma.user.create({
    data: {
      tenantId: user.tenantId,
      username: 'smoke_other',
      role: 'user',
      passwordHash: 'x',
      keySalt: 'y',
    },
  });
  await assert.rejects(
    () => adminSessions.listMessages({ userId: otherUser.id }, summaryRow.id, { limit: 5 }),
    /会话不存在/,
    '别人的会话必须 404',
  );
  process.stdout.write(
    `⑪ 会话查看：${listed.items.length} 个会话 / ${summaryRow.messageCount} 条消息 / 游标翻页 OK\n`,
  );

  // ⑫ 记忆（M5-1 / D045）：反思写入 → 下一轮读回 prompt → 重复内容不重复存
  const aggressivePipeline = new PipelineService({ ...baseDeps, memory: memoryAggressive });
  const sessionForMemory = await prisma.session.findFirst({ where: { instanceId: instance.id } });
  assert.ok(sessionForMemory, '应有会话');

  // 把阈值降到 2 条再跑一轮：真实 SQL 上会真的调一次"反思"（gateway stub 回固定 JSON）
  purposes.length = 0;
  systemPrompts.length = 0;
  gatewayReply = '嗯，豆豆好可爱。';
  await aggressivePipeline.handle(
    inbound({
      instanceId: instance.id,
      plainText: '今天豆豆又拆家了',
      segments: [{ type: 'text', text: '今天豆豆又拆家了' }],
    }),
    async (a) => {
      sent.push(a);
      return { messageId: 'out-memory-1' };
    },
    { capabilities: CAPS },
  );

  assert.ok(
    purposes.includes('reflection'),
    `攒够条数应触发反思，实际调用：${purposes.join(',') || '（无）'}`,
  );

  const memoryRows = await prisma.memoryItem.findMany({
    where: { instanceId: instance.id },
    orderBy: { createdAt: 'asc' },
  });
  const episodic = memoryRows.filter((row) => row.scope === 'episodic');
  const semantic = memoryRows.filter((row) => row.scope === 'semantic');

  assert.equal(episodic.length, 1, `应写一条情节摘要，实际 ${episodic.length}`);
  assert.equal(episodic[0]?.sessionId, sessionForMemory.id, '摘要挂在会话上');
  assert.equal(episodic[0]?.kind, 'summary');
  // 溯源：`sourceMsgIds` 存的是**落库后的**消息 id（不是入站时的平台 id），
  // 所以要拿它回查 Message 表 —— 这才是"这段记忆是从哪些话里总结出来的"。
  const sourceIds = (episodic[0]?.sourceMsgIds ?? '').split(',').filter(Boolean);
  assert.ok(sourceIds.length > 0, '摘要应带 sourceMsgIds');
  const traced = await prisma.message.count({ where: { id: { in: sourceIds } } });
  assert.equal(traced, sourceIds.length, '溯源 id 必须都能在 Message 表里查到');

  assert.equal(semantic.length, 1, `应写一条事实，实际 ${semantic.length}`);
  // 事实挂人而不是挂会话：换个会话（群聊）也该记得"他养了只猫"
  assert.equal(semantic[0]?.sessionId, null, '事实的 sessionId 必须为空');
  assert.equal(semantic[0]?.subjectId, 'peer-1');
  assert.equal(semantic[0]?.importance, 5);

  // 再跑一条：读回路径 —— 记忆要真的出现在 system prompt 里
  systemPrompts.length = 0;
  await aggressivePipeline.handle(
    inbound({
      instanceId: instance.id,
      plainText: '它还小，不懂事',
      segments: [{ type: 'text', text: '它还小，不懂事' }],
    }),
    async (a) => {
      sent.push(a);
      return { messageId: 'out-memory-2' };
    },
    { capabilities: CAPS },
  );

  const promptWithMemory = systemPrompts[0] ?? '';
  assert.ok(
    promptWithMemory.includes('他养了一只叫豆豆的猫'),
    '记忆应注入 system prompt（否则等于没记住）',
  );
  assert.ok(
    promptWithMemory.includes('不用复述'),
    '应带上"别汇报记忆"的约束（否则每轮都会复读一遍）',
  );

  // 去重：同一批内容再反思一次，不应该再存一遍
  const countBefore = memoryRows.length;
  await aggressivePipeline.handle(
    inbound({
      instanceId: instance.id,
      plainText: '它今天特别闹',
      segments: [{ type: 'text', text: '它今天特别闹' }],
    }),
    async (a) => {
      sent.push(a);
      return { messageId: 'out-memory-3' };
    },
    { capabilities: CAPS },
  );
  const countAfter = await prisma.memoryItem.count({ where: { instanceId: instance.id } });
  assert.equal(countAfter, countBefore, '相同内容不应重复入库（去重按正文）');

  process.stdout.write(
    `⑫ 记忆：反思写出 ${episodic.length} 条摘要 + ${semantic.length} 条事实，` +
      `下一轮 prompt 已带上，重复内容未重存\n`,
  );

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
