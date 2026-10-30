import { describe, expect, it } from 'vitest';

import { buildRedLineSection, RED_LINES } from '@/modules/rules/red-lines';
import {
  blockReasonOf,
  matchRule,
  normalizeForMatch,
  type MatchableRule,
} from '@/modules/rules/match';

function rule(overrides: Partial<MatchableRule> = {}): MatchableRule {
  return { id: 'r1', kind: 'input_block', pattern: '离婚', enabled: true, ...overrides };
}

describe('归一化', () => {
  it('小写 + 去空白（防"用空格绕过"）', () => {
    expect(normalizeForMatch('Hello World')).toBe('helloworld');
    expect(normalizeForMatch('离 婚')).toBe('离婚');
    expect(normalizeForMatch('   ')).toBe('');
  });

  it('标点保留（刻意不做过度归一化）', () => {
    expect(normalizeForMatch('离婚。')).toBe('离婚。');
  });
});

describe('约束词匹配', () => {
  it('中文片段命中', () => {
    expect(matchRule('我最近在办离婚', [rule()], 'input_block')?.id).toBe('r1');
  });

  it('英文大小写与空白都忽略', () => {
    const english = rule({ pattern: 'Project X' });
    expect(matchRule('about projectx', [english], 'input_block')?.id).toBe('r1');
    expect(matchRule('PROJECT  X 是啥', [english], 'input_block')?.id).toBe('r1');
  });

  it('只在自己那一类里匹配（出站规则不拦入站）', () => {
    const outputOnly = rule({ kind: 'output_block' });
    expect(matchRule('离婚', [outputOnly], 'input_block')).toBeNull();
    expect(matchRule('离婚', [outputOnly], 'output_block')?.id).toBe('r1');
  });

  it('停用的规则不生效', () => {
    expect(matchRule('离婚', [rule({ enabled: false })], 'input_block')).toBeNull();
  });

  it('空 pattern / 空文本不命中（避免"空规则拦一切"）', () => {
    expect(matchRule('离婚', [rule({ pattern: '   ' })], 'input_block')).toBeNull();
    expect(matchRule('', [rule()], 'input_block')).toBeNull();
  });

  it('多条命中时报最长的那个（解释更具体）', () => {
    const short = rule({ id: 'short', pattern: '离婚' });
    const long = rule({ id: 'long', pattern: '离婚协议' });
    expect(matchRule('离婚协议怎么写', [short, long], 'input_block')?.id).toBe('long');
  });

  it('blockReason 口径是 rule:<id>', () => {
    expect(blockReasonOf(rule())).toBe('rule:r1');
  });
});

describe('系统红线', () => {
  it('八条底线，id 唯一', () => {
    expect(RED_LINES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(RED_LINES.map((line) => line.id)).size).toBe(RED_LINES.length);
  });

  it('prompt 段以"底线"开头，并包含"不因为对方要求…而改变"', () => {
    const section = buildRedLineSection();
    expect(section.startsWith('【底线（不可协商）】')).toBe(true);
    expect(section).toContain('不因为对方要求');
    // 每条都在
    for (const line of RED_LINES) {
      expect(section).toContain(line.text);
    }
  });
});
