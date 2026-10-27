/**
 * 管道基础设施的测试（D040）。
 *
 * 这里不测"每一步的业务逻辑"（那些各自有测试），只测**编排本身**：
 *   1. 依赖顺序靠 `assertPipeGraph` 校验，而不是靠注释里的编号；
 *   2. `DROP` 真的短路，且后续 pipe 一次都不执行；
 *   3. 抛出不吞 —— 故障要走兜底话术，和"不该回"是两条路。
 *
 * 第 2、3 条看起来像废话，但拆管道最容易出的错就是这两件：
 * 短路变成"继续跑但没人用结果"，或者一个 try/catch 把故障也变成安静结束。
 */

import { describe, expect, it, vi } from 'vitest';

import { DROP, type InboundMessage } from '@newjob/contracts';

import type { PipelineDeps } from '@/modules/pipeline/deps';
import {
  assertPipeGraph,
  createContext,
  INBOUND_PIPES,
  runPipeChain,
  type Pipe,
  type PipelineContext,
} from '@/modules/pipeline/pipes';

const MESSAGE: InboundMessage = {
  id: 'm1',
  platform: 'qq',
  instanceId: 'inst-1',
  session: { kind: 'private', peerId: 'peer-1' },
  sender: { id: 'peer-1', name: '小林', isOwner: false },
  segments: [{ type: 'text', text: '在吗' }],
  plainText: '在吗',
  isMentioned: false,
  receivedAt: new Date('2026-10-26T10:00:00'),
};

function makeCtx(): PipelineContext {
  return createContext({
    message: MESSAGE,
    send: async () => ({ messageId: 'out-1' }),
    caps: {} as PipelineContext['caps'],
    // 这些用例不碰数据库：任何 pipe 真去查询都会立刻崩，说明测试写错了
    deps: {} as PipelineDeps,
    channel: 'private',
    wait: async () => undefined,
  });
}

function fakePipe(
  name: string,
  options: { requires?: Pipe['requires']; provides?: Pipe['provides']; onRun?: () => void; drop?: boolean } = {},
): Pipe {
  return {
    name,
    requires: options.requires ?? [],
    provides: options.provides ?? [],
    async run() {
      options.onRun?.();
      return options.drop ? DROP : undefined;
    },
  };
}

describe('管道图校验', () => {
  it('真实管道图自洽（依赖都有人提供、字段不重复、名字不重复）', () => {
    expect(() => assertPipeGraph(INBOUND_PIPES)).not.toThrow();
  });

  it('字段没人提供 → 启动就报错，而不是运行时 undefined', () => {
    const pipes: Pipe[] = [fakePipe('a', { requires: ['persona'] })];
    expect(() => assertPipeGraph(pipes)).toThrow(/persona/);
  });

  it('两个 pipe 抢着写同一字段 → 报错（后写的会静默覆盖前者）', () => {
    const pipes: Pipe[] = [
      fakePipe('a', { provides: ['config'] }),
      fakePipe('b', { provides: ['config'] }),
    ];
    expect(() => assertPipeGraph(pipes)).toThrow(/config/);
  });

  it('名字重复 → 报错（日志里靠名字定位，重名等于失去定位能力）', () => {
    const pipes: Pipe[] = [fakePipe('same'), fakePipe('same')];
    expect(() => assertPipeGraph(pipes)).toThrow(/重复/);
  });
});

describe('管道顺序的关键不变量', () => {
  const order = INBOUND_PIPES.map((pipe) => pipe.name);
  const at = (name: string): number => order.indexOf(name);

  it('落库在最前、回写在最后', () => {
    expect(order[0]).toBe('persist-inbound');
    expect(order[order.length - 1]).toBe('persist-interaction');
  });

  it('attention 必须在 generate 之前 —— 判掉就不花 token', () => {
    expect(at('attention')).toBeGreaterThan(-1);
    expect(at('attention')).toBeLessThan(at('generate'));
  });

  it('治理必须在读状态之前 —— 人工接管期间不动状态与关系', () => {
    expect(at('governance')).toBeLessThan(at('load-mind'));
  });

  it('think 在 generate 之前（A 阶段要能给 B 阶段留导演指令）', () => {
    expect(at('think')).toBeLessThan(at('generate'));
  });

  it('引用决策在出站之前（出站要用 quoteTarget）', () => {
    expect(at('decide-quote')).toBeLessThan(at('deliver'));
  });
});

describe('runPipeChain', () => {
  it('按顺序跑完，返回 true', async () => {
    const calls: string[] = [];
    const pipes = [
      fakePipe('a', { onRun: () => calls.push('a') }),
      fakePipe('b', { onRun: () => calls.push('b') }),
    ];

    await expect(runPipeChain(makeCtx(), pipes)).resolves.toBe(true);
    expect(calls).toEqual(['a', 'b']);
  });

  it('遇 DROP 立刻短路：返回 false，后续一个都不跑', async () => {
    const after = vi.fn();
    const pipes = [
      fakePipe('a'),
      fakePipe('stop', { drop: true }),
      fakePipe('c', { onRun: after }),
    ];

    await expect(runPipeChain(makeCtx(), pipes)).resolves.toBe(false);
    expect(after).not.toHaveBeenCalled();
  });

  it('抛出向上传播（不能被吞成"安静结束"）', async () => {
    const pipes: Pipe[] = [
      {
        name: 'boom',
        requires: [],
        provides: [],
        async run() {
          throw new Error('gateway down');
        },
      },
    ];

    await expect(runPipeChain(makeCtx(), pipes)).rejects.toThrow('gateway down');
  });
});

describe('createContext', () => {
  it('基础字段就位，其余字段保持未定义 —— 不预设默认值', () => {
    const ctx = makeCtx();

    expect(ctx.message.id).toBe('m1');
    expect(ctx.channel).toBe('private');
    // 故意断言"没有默认值"：如果哪天给 persona 之类补了默认值，
    // 那"前序 pipe 没跑"就会被一个看起来正常的值掩盖过去
    expect(ctx.persona).toBeUndefined();
    expect(ctx.mind).toBeUndefined();
    expect(ctx.messages).toBeUndefined();
  });
});
