import { describe, expect, it } from 'vitest';

import {
  buildReflectMessages,
  parseReflection,
  REFLECT_INSTRUCTION,
  REFLECT_LIMITS,
} from '@/modules/memory/reflect';

describe('反思结果解析（D045 的代码闸门）', () => {
  it('解析正常 JSON，允许前后有解释与代码块', () => {
    const raw = [
      '好的，整理如下：',
      '```json',
      JSON.stringify({
        summary: '他最近在赶一个后端项目，压力有点大。',
        facts: [
          { content: '他养了一只叫豆豆的猫', kind: 'fact', importance: 5 },
          { content: '他不吃香菜', kind: 'preference', importance: 3 },
        ],
      }),
      '```',
    ].join('\n');

    const digest = parseReflection(raw);
    expect(digest?.summary).toBe('他最近在赶一个后端项目，压力有点大。');
    expect(digest?.facts).toEqual([
      { content: '他养了一只叫豆豆的猫', kind: 'fact', importance: 5 },
      { content: '他不吃香菜', kind: 'preference', importance: 3 },
    ]);
  });

  it('facts 允许纯字符串形态（省事的模型），默认 fact / 3', () => {
    const digest = parseReflection(JSON.stringify({ summary: '随便聊了聊', facts: ['他在做后端'] }));
    expect(digest?.facts).toEqual([{ content: '他在做后端', kind: 'fact', importance: 3 }]);
  });

  it('事实超过字数上限：**丢弃**而不是截断（截断只会得到半句话）', () => {
    const long = '他'.repeat(REFLECT_LIMITS.factChars + 1);
    const digest = parseReflection(
      JSON.stringify({ summary: null, facts: [{ content: long }, { content: '他在做后端' }] }),
    );
    expect(digest?.facts.map((f) => f.content)).toEqual(['他在做后端']);
  });

  it('摘要超长：截断（摘要本来就是概括）', () => {
    const long = '啊'.repeat(REFLECT_LIMITS.summaryChars + 50);
    const digest = parseReflection(JSON.stringify({ summary: long, facts: [] }));
    expect(digest?.summary).toHaveLength(REFLECT_LIMITS.summaryChars);
  });

  it('事实条数封顶，多写的丢掉', () => {
    const facts = Array.from({ length: 9 }, (_, i) => ({ content: `事实第${i}条` }));
    const digest = parseReflection(JSON.stringify({ summary: null, facts }));
    expect(digest?.facts).toHaveLength(REFLECT_LIMITS.facts);
  });

  it('去重忽略空白与标点："他养了只猫。" 与 "他养了只猫" 是同一条', () => {
    const digest = parseReflection(
      JSON.stringify({
        summary: null,
        facts: [{ content: '他养了只猫。' }, { content: ' 他养了只猫 ' }],
      }),
    );
    expect(digest?.facts).toHaveLength(1);
  });

  it('kind 不在白名单 → 退回 fact；importance 越界 → 夹到 1-5', () => {
    const digest = parseReflection(
      JSON.stringify({
        summary: null,
        facts: [
          { content: '他在做后端', kind: 'summary', importance: 99 },
          { content: '他讨厌开会', kind: 'preference', importance: 0 },
        ],
      }),
    );
    expect(digest?.facts).toEqual([
      { content: '他在做后端', kind: 'fact', importance: 5 },
      { content: '他讨厌开会', kind: 'preference', importance: 1 },
    ]);
  });

  it('一条都没解析出来 → null（不写空记录）', () => {
    expect(parseReflection('{"summary":"","facts":[]}')).toBeNull();
    expect(parseReflection('这段没什么可记的')).toBeNull();
    expect(parseReflection('')).toBeNull();
  });

  it('只有摘要没有事实也算有收获', () => {
    const digest = parseReflection(JSON.stringify({ summary: '聊了聊周末', facts: [] }));
    expect(digest).toEqual({ summary: '聊了聊周末', facts: [] });
  });

  it('输入只有 system + 记录，不带 id/时间（免得被写进摘要）', () => {
    const messages = buildReflectMessages('对方：你好\n我：在的');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe(REFLECT_INSTRUCTION);
    expect(messages[1]?.content).toBe('对方：你好\n我：在的');
  });
});
