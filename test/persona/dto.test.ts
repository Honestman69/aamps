import { describe, expect, it } from 'vitest';

import { BadRequestError } from '@newjob/contracts';

import {
  createPersonaSchema,
  parseOrThrow,
  toPersonaDTO,
  updatePersonaSchema,
} from '@/modules/persona/dto';
import type { PersonaRow } from '@/modules/persona/ports';

const create = (input: unknown) => parseOrThrow(createPersonaSchema, input);
const update = (input: unknown) => parseOrThrow(updatePersonaSchema, input);

describe('人设创建校验', () => {
  it('最小体：只给名字就能建', () => {
    expect(create({ name: '小雅' })).toEqual({ name: '小雅' });
  });

  it('缺名字 / 名字为空 → 400', () => {
    expect(() => create({})).toThrow(BadRequestError);
    expect(() => create({ name: '   ' })).toThrow(BadRequestError);
  });

  it('行为参数越界直接 400，而不是存进去再被静默夹掉', () => {
    expect(() => create({ name: 'x', behavior: { expression: { typingCps: 0 } } })).toThrow(
      BadRequestError,
    );
    expect(() => create({ name: 'x', behavior: { expression: { splitChance: 2 } } })).toThrow(
      BadRequestError,
    );
    expect(() => create({ name: 'x', behavior: { attention: { thresholdGroup: 5 } } })).toThrow(
      BadRequestError,
    );
  });

  it('行为参数拼错字段名 → 400（否则会"保存成功但没生效"）', () => {
    expect(() =>
      create({ name: 'x', behavior: { attention: { thresholdGrop: 0.5 } } }),
    ).toThrow(BadRequestError);
    expect(() => create({ name: 'x', behavior: { expressions: {} } })).toThrow(BadRequestError);
  });

  it('合法行为参数原样通过（含 think 开关）', () => {
    const parsed = create({
      name: 'x',
      behavior: {
        attention: { thresholdGroup: 0.4, weights: { mention: 0.5 } },
        expression: { typingCps: 6, maxSegments: 2 },
        think: { enabled: false },
      },
    });
    expect(parsed.behavior).toMatchObject({
      attention: { thresholdGroup: 0.4 },
      expression: { typingCps: 6 },
      think: { enabled: false },
    });
  });

  it('故障话术允许 null（明确表示这种情况不说话）', () => {
    const parsed = create({
      name: 'x',
      fallbacks: { longOutage: { private: null, group: '晚点说' } },
    });
    expect(parsed.fallbacks).toEqual({ longOutage: { private: null, group: '晚点说' } });
  });

  it('引用倾向只接受四个枚举值', () => {
    expect(create({ name: 'x', quoteTendency: 'rare' }).quoteTendency).toBe('rare');
    expect(() => create({ name: 'x', quoteTendency: 'always' })).toThrow(BadRequestError);
  });

  it('未知字段 → 400（契约要显式，不能悄悄忽略）', () => {
    expect(() => create({ name: 'x', nickname: 'y' })).toThrow(BadRequestError);
  });

  it('示例至少要有一句', () => {
    expect(create({ name: 'x', examples: [{ user: '在吗' }] }).examples).toHaveLength(1);
    expect(() => create({ name: 'x', examples: [{}] })).toThrow(BadRequestError);
  });
});

describe('人设更新校验', () => {
  it('空对象 → 400（没有要改的字段就别发请求）', () => {
    expect(() => update({})).toThrow(BadRequestError);
  });

  it('只改一个字段也合法', () => {
    expect(update({ tagline: '话少' })).toEqual({ tagline: '话少' });
  });

  it('name 可以改但不能改成空', () => {
    expect(update({ name: '小雅' })).toEqual({ name: '小雅' });
    expect(() => update({ name: '' })).toThrow(BadRequestError);
  });
});

describe('出参形状', () => {
  const row: PersonaRow = {
    id: 'p1',
    instanceId: 'i1',
    name: '小雅',
    avatar: null,
    tagline: '22 岁',
    identityJson: JSON.stringify({ name: '小雅', age: '22' }),
    promptBlocksJson: JSON.stringify([{ content: '别用敬语', enabled: true }]),
    examplesJson: '[]',
    openingJson: '{}',
    boundariesJson: JSON.stringify(['前任']),
    variablesJson: '{}',
    behaviorJson: JSON.stringify({ expression: { typingCps: 5 } }),
    fallbacksJson: '{}',
    quoteTendency: 'normal',
    version: 2,
    status: 'published',
    publishedAt: new Date('2026-10-26T10:00:00'),
    archivedAt: null,
    createdAt: new Date('2026-10-26T09:00:00'),
    updatedAt: new Date('2026-10-26T10:00:00'),
  };

  it('JSON 字符串被还原成对象，active 由实例指针决定', () => {
    const dto = toPersonaDTO(row, 'p1');
    expect(dto.identity).toEqual({ name: '小雅', age: '22' });
    expect(dto.boundaries).toEqual(['前任']);
    expect(dto.behavior).toEqual({ expression: { typingCps: 5 } });
    expect(dto.active).toBe(true);
    // 时间用本地时区构造，比较时统一走 ISO（避免依赖测试机器的时区）
    expect(dto.publishedAt).toBe(new Date('2026-10-26T10:00:00').toISOString());
  });

  it('库里 JSON 被手改坏 → 回落空结构，不炸编辑页', () => {
    const broken = toPersonaDTO({ ...row, behaviorJson: '{坏掉', boundariesJson: 'null' }, null);
    expect(broken.behavior).toEqual({});
    expect(broken.boundaries).toEqual([]);
    expect(broken.active).toBe(false);
  });
});
