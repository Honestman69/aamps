import { describe, expect, it } from 'vitest';

import {
  buildTranscript,
  DEFAULT_MEMORY_OPTIONS,
  MemoryService,
  type ReflectionModel,
} from '@/modules/memory/memory.service';
import type {
  IMemoryRepository,
  PromptQuery,
  TranscriptMessage,
} from '@/modules/memory/ports';
import type { MemoryDraft, MemoryRecord } from '@/modules/memory/types';

const NOW = new Date('2026-10-27T12:00:00');

function msg(id: string, role: 'user' | 'assistant', content: string): TranscriptMessage {
  return {
    id,
    role,
    senderName: role === 'user' ? '阿明' : null,
    content,
    createdAt: NOW,
  };
}

class FakeRepo implements IMemoryRepository {
  messages: TranscriptMessage[] = [];
  lastAt: Date | null = null;
  /** 已存在的记忆正文（去重要用到） */
  existing = new Set<string>();
  facts: MemoryRecord[] = [];
  summaries: MemoryRecord[] = [];
  added: MemoryDraft[] = [];
  failList = false;
  failAdd = false;

  async listForPrompt(
    query: PromptQuery,
  ): Promise<{ facts: MemoryRecord[]; summaries: MemoryRecord[] }> {
    if (this.failList) {
      throw new Error('db down');
    }
    return { facts: this.facts, summaries: this.summaries };
  }

  async lastEpisodicAt(): Promise<Date | null> {
    return this.lastAt;
  }

  async countMessagesSince(): Promise<number> {
    return this.messages.length;
  }

  async listRecentMessages(): Promise<TranscriptMessage[]> {
    return this.messages;
  }

  async existingContents(_i: string, _s: string, contents: string[]): Promise<Set<string>> {
    return new Set(contents.filter((content) => this.existing.has(content)));
  }

  async addMany(drafts: MemoryDraft[]): Promise<MemoryRecord[]> {
    if (this.failAdd) {
      throw new Error('insert failed');
    }
    const rows = drafts.map((draft, index) => ({
      id: `mem-${this.added.length + index + 1}`,
      scope: draft.scope,
      kind: draft.kind,
      content: draft.content,
      importance: draft.importance,
      subjectId: draft.subjectId,
      sessionId: draft.sessionId,
      createdAt: NOW,
    }));
    this.added.push(...drafts);
    return rows;
  }
}

class FakeModel implements ReflectionModel {
  calls: Array<{ purpose: string; messages: unknown; sessionId: string }> = [];
  reply = '{}';
  fail = false;

  async chat(input: {
    instanceId: string;
    ownerUserId: string;
    sessionId: string;
    purpose: 'reflection';
    messages: unknown;
  }): Promise<{ text: string }> {
    this.calls.push({ purpose: input.purpose, messages: input.messages, sessionId: input.sessionId });
    if (this.fail) {
      throw new Error('model boom');
    }
    return { text: this.reply };
  }
}

class FakeEvolution {
  calls: Array<{ instanceId: string; proposal: unknown; memoryIds: string[] }> = [];
  applied = true;

  async evolve(input: {
    instanceId: string;
    proposal: unknown;
    memoryIds: readonly string[];
  }): Promise<{ applied: boolean; reason: string }> {
    this.calls.push({
      instanceId: input.instanceId,
      proposal: input.proposal,
      memoryIds: [...input.memoryIds],
    });
    return { applied: this.applied, reason: this.applied ? 'applied' : 'no-change' };
  }
}

function makeService(
  repo: FakeRepo,
  model: FakeModel,
  options = DEFAULT_MEMORY_OPTIONS,
  evolution?: FakeEvolution,
) {
  return new MemoryService(repo, model, options, evolution);
}

const INPUT = {
  instanceId: 'inst-1',
  ownerUserId: 'user-1',
  sessionId: 'session-1',
  subjectId: 'peer-1',
  now: NOW,
};

/** 造一段够长的聊天：默认阈值 30 条 */
function fillMessages(repo: FakeRepo, count: number): void {
  repo.messages = Array.from({ length: count }, (_, i) =>
    msg(`m-${i}`, i % 2 === 0 ? 'user' : 'assistant', `第 ${i} 句`),
  );
}

describe('反思触发（MemoryService.maybeReflect）', () => {
  it('没攒够条数：一次模型调用都不花', async () => {
    const repo = new FakeRepo();
    const model = new FakeModel();
    fillMessages(repo, DEFAULT_MEMORY_OPTIONS.reflectEvery - 1);

    const outcome = await makeService(repo, model).maybeReflect(INPUT);

    expect(outcome).toEqual({ written: 0, reason: 'below-threshold' });
    expect(model.calls).toHaveLength(0);
    expect(repo.added).toHaveLength(0);
  });

  it('刚好攒够：调一次 reflection 通道的模型，摘要挂会话、事实挂人', async () => {
    const repo = new FakeRepo();
    const model = new FakeModel();
    fillMessages(repo, DEFAULT_MEMORY_OPTIONS.reflectEvery);
    model.reply = JSON.stringify({
      summary: '他聊了聊周末的安排',
      facts: [{ content: '他在做后端', kind: 'fact', importance: 4 }],
    });

    const outcome = await makeService(repo, model).maybeReflect(INPUT);

    expect(outcome).toEqual({ written: 2, reason: 'ok' });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.purpose).toBe('reflection');

    const summary = repo.added.find((draft) => draft.scope === 'episodic');
    const fact = repo.added.find((draft) => draft.scope === 'semantic');

    expect(summary).toMatchObject({
      kind: 'summary',
      content: '他聊了聊周末的安排',
      sessionId: 'session-1',
      subjectId: 'peer-1',
    });
    // 事实跨会话成立：sessionId 必须是 null，否则换个群就"想不起来"
    expect(fact).toMatchObject({
      kind: 'fact',
      content: '他在做后端',
      sessionId: null,
      subjectId: 'peer-1',
      importance: 4,
    });
    // 溯源：能指回真实消息（最多留 20 个 id，够定位区间就行）
    const ids = fact?.sourceMsgIds?.split(',') ?? [];
    expect(ids).toHaveLength(Math.min(20, repo.messages.length));
    expect(ids.at(-1)).toBe(`m-${repo.messages.length - 1}`);
  });

  it('去重：已经存过的正文不再写第二遍', async () => {
    const repo = new FakeRepo();
    const model = new FakeModel();
    fillMessages(repo, DEFAULT_MEMORY_OPTIONS.reflectEvery);
    model.reply = JSON.stringify({
      summary: '他聊了聊周末的安排',
      facts: [{ content: '他在做后端' }],
    });
    repo.existing.add('他聊了聊周末的安排');

    const outcome = await makeService(repo, model).maybeReflect(INPUT);

    expect(outcome).toEqual({ written: 1, reason: 'ok' });
    expect(repo.added.map((draft) => draft.content)).toEqual(['他在做后端']);
  });

  it('全都被去重掉：不报错，也不算写过', async () => {
    const repo = new FakeRepo();
    const model = new FakeModel();
    fillMessages(repo, DEFAULT_MEMORY_OPTIONS.reflectEvery);
    model.reply = JSON.stringify({ summary: '同一件事', facts: [{ content: '同一件事' }] });
    repo.existing.add('同一件事');

    const outcome = await makeService(repo, model).maybeReflect(INPUT);

    expect(outcome).toEqual({ written: 0, reason: 'nothing-to-remember' });
    expect(repo.added).toHaveLength(0);
  });

  it('模型输出不是 JSON：不写，也不抛', async () => {
    const repo = new FakeRepo();
    const model = new FakeModel();
    fillMessages(repo, DEFAULT_MEMORY_OPTIONS.reflectEvery);
    model.reply = '这段好像没什么可记的';

    const outcome = await makeService(repo, model).maybeReflect(INPUT);

    expect(outcome).toEqual({ written: 0, reason: 'nothing-to-remember' });
    expect(repo.added).toHaveLength(0);
  });

  it('模型抛错：吞掉（这一步在消息已发出之后，抛出去会触发兜底话术）', async () => {
    const repo = new FakeRepo();
    const model = new FakeModel();
    fillMessages(repo, DEFAULT_MEMORY_OPTIONS.reflectEvery);
    model.fail = true;

    const outcome = await makeService(repo, model).maybeReflect(INPUT);

    expect(outcome.reason).toBe('failed');
    expect(outcome.written).toBe(0);
    expect(outcome.detail).toContain('model boom');
  });

  it('写库失败：吞掉', async () => {
    const repo = new FakeRepo();
    const model = new FakeModel();
    fillMessages(repo, DEFAULT_MEMORY_OPTIONS.reflectEvery);
    model.reply = JSON.stringify({ summary: '聊了聊', facts: [] });
    repo.failAdd = true;

    const outcome = await makeService(repo, model).maybeReflect(INPUT);

    expect(outcome.reason).toBe('failed');
    expect(outcome.written).toBe(0);
  });

  it('空会话：不调模型', async () => {
    const repo = new FakeRepo();
    const model = new FakeModel();

    const outcome = await makeService(repo, model).maybeReflect(INPUT);

    expect(outcome.reason).toBe('below-threshold');
    expect(model.calls).toHaveLength(0);
  });
});

describe('读回（MemoryService.loadForPrompt）', () => {
  const QUERY = { instanceId: 'inst-1', sessionId: 'session-1', subjectId: 'peer-1' };

  it('只把正文交给 prompt（不带 id / 时间）', async () => {
    const repo = new FakeRepo();
    repo.facts = [
      {
        id: 'f1',
        scope: 'semantic',
        kind: 'fact',
        content: '他在做后端',
        importance: 4,
        subjectId: 'peer-1',
        sessionId: null,
        createdAt: NOW,
      },
    ];
    repo.summaries = [
      {
        id: 'e1',
        scope: 'episodic',
        kind: 'summary',
        content: '聊了聊周末',
        importance: 3,
        subjectId: 'peer-1',
        sessionId: 'session-1',
        createdAt: NOW,
      },
    ];

    const memory = await makeService(repo, new FakeModel()).loadForPrompt(QUERY);

    expect(memory).toEqual({ facts: ['他在做后端'], summaries: ['聊了聊周末'] });
  });

  it('仓储炸了：返回空记忆，不抛', async () => {
    const repo = new FakeRepo();
    repo.failList = true;

    const memory = await makeService(repo, new FakeModel()).loadForPrompt(QUERY);

    expect(memory).toEqual({ facts: [], summaries: [] });
  });
});

describe('反思原料（buildTranscript）', () => {
  it('机器人自称"我"，对方用昵称；没有昵称就"对方"', () => {
    const text = buildTranscript([
      msg('m1', 'user', '在吗'),
      msg('m2', 'assistant', '在的'),
      { ...msg('m3', 'user', '   '), senderName: null, content: '  嗯  ' },
    ]);
    expect(text).toBe('阿明：在吗\n我：在的\n对方：嗯');
  });

  it('不带 id 与时间（否则模型会把时间戳抄进摘要）', () => {
    const text = buildTranscript([msg('m-abc', 'user', '你好')]);
    expect(text).toBe('阿明：你好');
    expect(text).not.toContain('m-abc');
    expect(text).not.toContain('2026');
  });

  it('超长时从最新往前保留，老消息先被丢', () => {
    // 每条约 200 字（单条上限），40 条肯定超过 4000 字的总预算
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg(`m-${i}`, 'user', `第${i}句${'字'.repeat(200)}`),
    );
    const text = buildTranscript(messages);
    const lines = text.split('\n');

    expect(text).toContain('第39句');
    expect(text).not.toContain('第0句');
    // 保留的是**连续的一段尾部**：最老的那条一定是某个 第N句（N > 0），而不是东拼西凑
    expect(lines.at(-1)).toContain('第39句');
    expect(lines[0]).toMatch(/^阿明：第([1-9]\d?)句/);
  });
});

describe('反思与人格演化的衔接（M5-2 / D046）', () => {
  it('把这次真正写入的记忆 id 递给演化层（溯源，不是让模型报 id）', async () => {
    const repo = new FakeRepo();
    const model = new FakeModel();
    fillMessages(repo, DEFAULT_MEMORY_OPTIONS.reflectEvery);
    model.reply = JSON.stringify({
      summary: '聊了聊他最近的压力',
      facts: [{ content: '他在赶一个上线' }],
      self: { traits: { edge: 0.02 } },
    });
    const evolution = new FakeEvolution();

    const outcome = await makeService(repo, model, DEFAULT_MEMORY_OPTIONS, evolution).maybeReflect(INPUT);

    expect(outcome.written).toBe(2);
    expect(outcome.evolution).toEqual({ applied: true, reason: 'applied' });
    expect(evolution.calls).toHaveLength(1);
    // 两条记忆都写了 → 两个 id 都递过去
    expect(evolution.calls[0]?.memoryIds).toEqual(['mem-1', 'mem-2']);
    expect(evolution.calls[0]?.proposal).toEqual({ traits: { edge: 0.02 } });
  });

  it('全被去重掉（没写新记忆）→ 完全不碰演化层', async () => {
    const repo = new FakeRepo();
    const model = new FakeModel();
    fillMessages(repo, DEFAULT_MEMORY_OPTIONS.reflectEvery);
    model.reply = JSON.stringify({
      summary: '同一件事',
      facts: [{ content: '同一件事' }],
      self: { traits: { edge: 0.02 } },
    });
    repo.existing.add('同一件事');
    const evolution = new FakeEvolution();

    const outcome = await makeService(repo, model, DEFAULT_MEMORY_OPTIONS, evolution).maybeReflect(INPUT);

    expect(outcome.reason).toBe('nothing-to-remember');
    expect(evolution.calls).toHaveLength(0);
  });

  it('演化层抛错：记忆照写，返回结果里标 failed', async () => {
    const repo = new FakeRepo();
    const model = new FakeModel();
    fillMessages(repo, DEFAULT_MEMORY_OPTIONS.reflectEvery);
    model.reply = JSON.stringify({ summary: '聊了聊', facts: [{ content: '他在做后端' }] });
    const evolution = new FakeEvolution();
    evolution.evolve = async () => {
      throw new Error('gate exploded');
    };

    const outcome = await makeService(repo, model, DEFAULT_MEMORY_OPTIONS, evolution).maybeReflect(INPUT);

    expect(outcome.written).toBe(2);
    expect(outcome.evolution).toEqual({ applied: false, reason: 'failed' });
  });
});
