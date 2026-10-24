/**
 * Provider 预设的契约测试。
 *
 * 这些看着像"常识"的断言，其实是防两类真实事故：
 *   1. 有人为了 UI 好看，给没实测的厂商编一个余额接口 → 上线后一直报错或显示假余额；
 *   2. 有人把余额判断写成 `if (provider === 'deepseek')` → 每加一家就改一次代码。
 */

import { describe, expect, it } from 'vitest';

import {
  PROVIDER_PRESETS,
  balanceCapability,
  findProviderPreset,
} from '@/modules/model/providers/presets';

describe('Provider 预设', () => {
  it('id 唯一，且每个都带展示名与充值落地页（custom/ollama 允许空）', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.name.length).toBeGreaterThan(0);
      if (preset.id !== 'custom') {
        expect(preset.baseUrl.length).toBeGreaterThan(0);
      }
    }
  });

  it('DeepSeek 的余额声明完整（官方 /user/balance，金额单位是元）', () => {
    const deepseek = findProviderPreset('deepseek');
    expect(deepseek?.balanceSupport).toBe('api');
    expect(deepseek?.balance).toMatchObject({
      method: 'GET',
      path: '/user/balance',
      amountPath: 'balance_infos[0].total_balance',
      availablePath: 'is_available',
      unit: 'yuan',
    });
  });

  it('查不到余额的厂商必须老实标 inferred，不许编接口', () => {
    for (const id of ['openai', 'anthropic', 'gemini']) {
      const preset = findProviderPreset(id);
      expect(preset?.balanceSupport).toBe('inferred');
      // 没有实测就不许给声明，否则会拿一个不存在的路径去请求
      expect(preset?.balance).toBeUndefined();
    }
  });

  it('只有 balanceSupport=api 的才有 balance 声明（其余一律没有）', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.balanceSupport === 'api') {
        expect(preset.balance).toBeDefined();
      } else {
        expect(preset.balance).toBeUndefined();
      }
    }
  });

  it('未知 provider 返回 unverified，而不是假装支持', () => {
    expect(balanceCapability('some-new-vendor')).toBe('unverified');
    expect(findProviderPreset('some-new-vendor')).toBeNull();
  });
});
