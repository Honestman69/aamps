import { describe, expect, it } from 'vitest';

import { assemblePrompt, type PersonaSeed } from '@/modules/persona/prompt';

const seed = (overrides: Partial<PersonaSeed> = {}): PersonaSeed => ({
  name: '小雅',
  tagline: '22 岁，话多、心软',
  identityJson: '{}',
  promptBlocksJson: '[]',
  examplesJson: '[]',
  boundariesJson: '[]',
  ...overrides,
});

const ctx = (overrides: Partial<Parameters<typeof assemblePrompt>[1]> = {}) => ({
  peerName: '阿明',
  channel: 'private' as const,
  selfName: '小雅',
  ...overrides,
});

describe('prompt 组装顺序（D020）', () => {
  it('system 里先出现"人"，再出现"出生设定"，再出现"对方"', () => {
    const { system } = assemblePrompt(
      seed({ identityJson: JSON.stringify({ name: '小雅', background: '从小在海边长大' }) }),
      ctx(),
    );
    const human = system.indexOf('有自己性格的人');
    const seedPos = system.indexOf('你出生时的设定');
    const peer = system.indexOf('正在和你说话的人');
    expect(human).toBeGreaterThanOrEqual(0);
    expect(seedPos).toBeGreaterThan(human);
    expect(peer).toBeGreaterThan(seedPos);
  });

  it('出生设定用过去时叙述，不出现命令句"你必须"', () => {
    const { system } = assemblePrompt(
      seed({ identityJson: JSON.stringify({ name: '小雅', age: 22 }) }),
      ctx(),
    );
    expect(system).toContain('你出生时的设定');
    expect(system).not.toContain('你必须');
  });
});

describe('种子字段解析', () => {
  it('identity 的离散字段拼成一句，背景故事单独成段', () => {
    const { system } = assemblePrompt(
      seed({
        identityJson: JSON.stringify({ name: '小雅', age: 22, gender: '女', background: '从小在海边长大' }),
      }),
      ctx(),
    );
    expect(system).toContain('名字叫「小雅」');
    expect(system).toContain('22 岁');
    expect(system).toContain('女');
    expect(system).toContain('从小在海边长大');
  });

  it('tagline 放在种子段最前', () => {
    const { system } = assemblePrompt(seed({ tagline: '一句话定位' }), ctx());
    expect(system.indexOf('一句话定位')).toBeLessThan(system.indexOf('正在和你说话的人'));
  });

  it('promptBlocks 只取 enabled 的块，按顺序', () => {
    const blocks = JSON.stringify([
      { key: 'a', title: 'A', content: '第一块', enabled: true },
      { key: 'b', title: 'B', content: '被禁用的块', enabled: false },
      { key: 'c', title: 'C', content: '第二块', enabled: true },
    ]);
    const { system } = assemblePrompt(seed({ promptBlocksJson: blocks }), ctx());
    expect(system).toContain('第一块');
    expect(system).toContain('第二块');
    expect(system).not.toContain('被禁用的块');
    expect(system.indexOf('第一块')).toBeLessThan(system.indexOf('第二块'));
  });

  it('软禁区拼成"会避开的话题"，而不是红线', () => {
    const { system } = assemblePrompt(
      seed({ boundariesJson: JSON.stringify(['政治', '宗教']) }),
      ctx(),
    );
    expect(system).toContain('你不爱谈、会主动避开的话题');
    expect(system).toContain('政治');
  });
});

describe('宽容解析：坏数据不崩，只是少一段', () => {
  it('identityJson 是坏 JSON → 跳过种子段，但不抛错', () => {
    const { system } = assemblePrompt(seed({ identityJson: '{not-json' }), ctx());
    expect(system).toContain('有自己性格的人');
  });

  it('examplesJson 是坏 JSON → examples 为空', () => {
    const { examples } = assemblePrompt(seed({ examplesJson: 'oops' }), ctx());
    expect(examples).toEqual([]);
  });

  it('examples 里缺 user 或 assistant 时，只保留有值的那半', () => {
    const examples = JSON.stringify([
      { user: '你好', assistant: '嗨' },
      { user: '只有 user' },
      { assistant: '只有 assistant' },
    ]);
    const result = assemblePrompt(seed({ examplesJson: examples }), ctx());
    // user 与 assistant 各自独立成一条消息，缺半就只留那半
    expect(result.examples).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '嗨' },
      { role: 'user', content: '只有 user' },
      { role: 'assistant', content: '只有 assistant' },
    ]);
  });
});

describe('few-shot 与 system 分离', () => {
  it('examples 不进 system 文本', () => {
    const { system, examples } = assemblePrompt(
      seed({ examplesJson: JSON.stringify([{ user: '在吗', assistant: '在呢' }]) }),
      ctx(),
    );
    expect(system).not.toContain('在吗');
    expect(system).not.toContain('在呢');
    expect(examples).toHaveLength(2);
  });
});

describe('情境', () => {
  it('群聊有"多个人同时说话"的提示', () => {
    const { system } = assemblePrompt(seed(), ctx({ channel: 'group' }));
    expect(system).toContain('多个人同时说话');
  });

  it('私聊提示"单独说话"', () => {
    const { system } = assemblePrompt(seed(), ctx({ channel: 'private' }));
    expect(system).toContain('单独');
  });

  it('没有对方昵称时不塞"正在和…说话"', () => {
    const { system } = assemblePrompt(seed(), ctx({ peerName: null }));
    expect(system).not.toContain('正在和你说话的人');
  });
});

describe('语气提示（M3 瞬态状态）', () => {
  it('不传状态时完全不出现语气段', () => {
    const { system } = assemblePrompt(seed(), ctx());
    expect(system).not.toContain('很困');
    expect(system).not.toContain('心情不错');
  });

  it('精力正常时不啰嗦"你现在很精神"', () => {
    const { system } = assemblePrompt(seed(), ctx({ state: { mood: 0, energy: 0.9 } }));
    expect(system).not.toContain('很困');
    expect(system).not.toContain('有点累');
  });

  it('低精力说现象，不下指令', () => {
    const { system } = assemblePrompt(seed(), ctx({ state: { mood: 0, energy: 0.2 } }));
    expect(system).toContain('很困');
    expect(system).not.toMatch(/请|必须|不要超过/);
  });

  it('情绪偏离常态时才提，且语气提示在最后一段', () => {
    const { system } = assemblePrompt(
      seed({ boundariesJson: '["前任"]' }),
      ctx({ state: { mood: -0.6, energy: 0.8 } }),
    );
    expect(system).toContain('情绪不太好');
    expect(system.indexOf('情绪不太好')).toBeGreaterThan(system.indexOf('不爱谈'));
  });
});

describe('媒体能力说明（D033）', () => {
  it('不传能力时完全不提图片与语音', () => {
    const { system } = assemblePrompt(seed(), ctx());
    expect(system).not.toContain('[img]');
    expect(system).not.toContain('[voice]');
  });

  it('只支持图片时只提图片', () => {
    const { system } = assemblePrompt(seed(), ctx({ capabilities: { imageReply: true, voiceReply: false } }));
    expect(system).toContain('[img]');
    expect(system).not.toContain('[voice]');
  });

  it('两项都可用时都在，且要求标记独占一行', () => {
    const { system } = assemblePrompt(seed(), ctx({ capabilities: { imageReply: true, voiceReply: true } }));
    expect(system).toContain('[img]');
    expect(system).toContain('[voice]');
    expect(system).toContain('单独写一行');
  });

  it('提醒不要滥用：避免每句都带媒体', () => {
    const { system } = assemblePrompt(seed(), ctx({ capabilities: { imageReply: true, voiceReply: true } }));
    expect(system).toContain('正常打字');
  });
});
