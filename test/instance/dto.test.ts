/**
 * 实例入参的两条硬约束（D041）：
 *
 * 1. 账号信息必须来自 `accountId` 或 `adapterConfig` 之一 —— 两个都不给，连接时不知道该用哪个号；
 * 2. 两者**不能同时出现**。同一件事有两个来源，就会出现"我改了 adapterConfig 但平铺字段又盖回去了"
 *    这种无法从日志判断的故障。
 */

import { describe, expect, it } from 'vitest';

import { createInstanceSchema, updateInstanceSchema } from '@/modules/instance/dto';

const CONFIG = { mode: 'server', wsUrl: 'ws://127.0.0.1:3002', selfId: '10001' };

function parseCreate(input: unknown) {
  return createInstanceSchema.safeParse(input);
}

describe('createInstanceSchema：账号来源二选一', () => {
  it('平铺字段的老写法继续可用（脚本与冒烟都在用）', () => {
    expect(parseCreate({ name: '主号', accountId: '10001' }).success).toBe(true);
  });

  it('只给 adapterConfig 也可以（账号在其内部）', () => {
    expect(parseCreate({ name: '主号', adapterConfig: CONFIG }).success).toBe(true);
  });

  it('两个都不给 → 400', () => {
    const result = parseCreate({ name: '主号' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain('accountId');
  });

  it('两个一起给 → 400（同一件事有两个来源）', () => {
    const result = parseCreate({ name: '主号', accountId: '10001', adapterConfig: CONFIG });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain('不能同时提供');
  });

  it('adapterConfig 只与"槽位字段"互斥，与模型/预算无关', () => {
    expect(
      parseCreate({
        name: '主号',
        adapterConfig: CONFIG,
        modelMain: 'deepseek-chat',
        dailyBudgetCents: 500,
      }).success,
    ).toBe(true);
  });

  it('接入配置项过多 → 400（防止把整个对象当垃圾桶塞进来）', () => {
    const huge: Record<string, string> = {};
    for (let i = 0; i < 21; i += 1) {
      huge[`k${i}`] = 'v';
    }
    expect(parseCreate({ name: '主号', adapterConfig: huge }).success).toBe(false);
  });
});

describe('updateInstanceSchema：接入配置是增量', () => {
  it('只传 adapterConfig 的一个键就够', () => {
    expect(updateInstanceSchema.safeParse({ adapterConfig: { selfId: '20002' } }).success).toBe(true);
  });

  it('adapterConfig 与平铺槽位字段同时出现 → 400', () => {
    expect(
      updateInstanceSchema.safeParse({ adapterConfig: { selfId: '2' }, endpoint: 'ws://x:1' })
        .success,
    ).toBe(false);
  });

  it('空对象仍然 400（"什么都没改"不该发请求）', () => {
    expect(updateInstanceSchema.safeParse({}).success).toBe(false);
  });
});
