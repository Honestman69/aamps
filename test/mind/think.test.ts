import { describe, expect, it } from 'vitest';

import { DEFAULT_THINK_POLICY, parseThinkPolicy } from '@/modules/mind/reflection/policy';
import {
  MAX_EMOTION_SHIFT,
  buildDirectorBlock,
  buildThinkSystem,
  parseThink,
} from '@/modules/mind/reflection/think';

const VALID = {
  want_to_reply: 0.8,
  emotion_shift: -0.15,
  intent: '对方在抱怨加班，想被安慰',
  key_points: ['共情', '不问细节', '提一句上次的项目'],
  tone: '有点心疼，别太用力',
  length_hint: '短，1-2句',
};

describe('parseThink', () => {
  it('正常 JSON 全字段解析', () => {
    const think = parseThink(JSON.stringify(VALID));
    expect(think).toEqual({
      wantToReply: 0.8,
      emotionShift: -0.15,
      intent: '对方在抱怨加班，想被安慰',
      keyPoints: ['共情', '不问细节', '提一句上次的项目'],
      tone: '有点心疼，别太用力',
      lengthHint: '短，1-2句',
    });
  });

  it('容忍前后解释与 ```json 代码块', () => {
    const raw = `好的，我先想想：\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`\n这样应该可以。`;
    expect(parseThink(raw)?.intent).toContain('抱怨加班');
  });

  it('不是 JSON / 对不上任何字段 → null（调用方回落单阶段）', () => {
    expect(parseThink('我觉得还行吧')).toBeNull();
    expect(parseThink('{"foo":"bar"}')).toBeNull();
    expect(parseThink('{坏掉的 json}')).toBeNull();
  });

  it('情绪增量被夹在单轮上限内（防性格跳变）', () => {
    expect(parseThink(JSON.stringify({ ...VALID, emotion_shift: 0.9 }))?.emotionShift).toBe(
      MAX_EMOTION_SHIFT,
    );
    expect(parseThink(JSON.stringify({ ...VALID, emotion_shift: -5 }))?.emotionShift).toBe(
      -MAX_EMOTION_SHIFT,
    );
  });

  it('want_to_reply 缺失时取中性值，越界被夹回 0~1', () => {
    const missing = parseThink(JSON.stringify({ intent: '随便聊聊' }));
    expect(missing?.wantToReply).toBe(0.5);
    expect(parseThink(JSON.stringify({ ...VALID, want_to_reply: 3 }))?.wantToReply).toBe(1);
  });

  it('key_points 只取前 5 条，非字符串被丢掉', () => {
    const think = parseThink(
      JSON.stringify({ key_points: ['a', 1, '', 'b', 'c', 'd', 'e', 'f'] }),
    );
    expect(think?.keyPoints).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('buildDirectorBlock', () => {
  it('把独白翻译成"不要说出来"的导演指令', () => {
    const block = buildDirectorBlock(parseThink(JSON.stringify(VALID)));
    expect(block).toContain('不要说出口');
    expect(block).toContain('对方在抱怨加班');
    expect(block).toContain('共情；不问细节');
    expect(block).toContain('有点心疼');
    expect(block).toContain('短，1-2句');
  });

  it('没有独白时返回空串（B 阶段不加任何东西）', () => {
    expect(buildDirectorBlock(null)).toBe('');
  });

  it('想说但不太想说：加一句"能一句说完就一句"', () => {
    const block = buildDirectorBlock(
      parseThink(JSON.stringify({ ...VALID, want_to_reply: 0.1 })),
    );
    expect(block).toContain('懒得展开');
  });
});

describe('buildThinkSystem', () => {
  it('人格设定在前，思考指令在后，且要求只输出 JSON', () => {
    const system = buildThinkSystem('你是一个有自己性格的人。');
    expect(system.startsWith('你是一个有自己性格的人。')).toBe(true);
    expect(system).toContain('只输出一个 JSON');
    expect(system).toContain('want_to_reply');
  });
});

describe('parseThinkPolicy', () => {
  it('默认开启', () => {
    expect(parseThinkPolicy(null)).toEqual(DEFAULT_THINK_POLICY);
    expect(parseThinkPolicy('{}')).toEqual(DEFAULT_THINK_POLICY);
  });

  it('可以显式关掉', () => {
    expect(parseThinkPolicy('{"think":{"enabled":false}}')).toEqual({ enabled: false });
  });

  it('脏数据回落默认（开启）', () => {
    expect(parseThinkPolicy('{')).toEqual(DEFAULT_THINK_POLICY);
    expect(parseThinkPolicy('{"think":"off"}')).toEqual(DEFAULT_THINK_POLICY);
  });
});
