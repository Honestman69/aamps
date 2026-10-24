/**
 * 配置解析的覆盖语义。
 *
 * 重点测三类容易写错的地方：空值不能抹掉上层、非法值要能被发现、来源要能追溯。
 */

import { describe, expect, it } from 'vitest';

import { resolveConfig } from '@/modules/config/resolver';
import { DEFAULT_AGENT_CONFIG, type ConfigBundle } from '@/modules/config/types';

function bundle(overrides: Partial<ConfigBundle['instance']> = {}, rest: Partial<ConfigBundle> = {}): ConfigBundle {
  return {
    instance: {
      credentialId: null,
      modelMain: null,
      modelCheap: null,
      modelFallback: null,
      modelTemperature: DEFAULT_AGENT_CONFIG.modelTemperature,
      rateLimitPerMin: DEFAULT_AGENT_CONFIG.rateLimitPerMin,
      dailyMsgCap: DEFAULT_AGENT_CONFIG.dailyMsgCap,
      nightQuiet: DEFAULT_AGENT_CONFIG.nightQuiet,
      activePersonaId: null,
      dailyBudgetCents: DEFAULT_AGENT_CONFIG.dailyBudgetCents,
      monthlyBudgetCents: DEFAULT_AGENT_CONFIG.monthlyBudgetCents,
      budgetPolicy: DEFAULT_AGENT_CONFIG.budgetPolicy,
      ...overrides,
    },
    persona: null,
    session: null,
    ...rest,
  };
}

describe('ConfigResolver：四级覆盖', () => {
  it('实例什么都没配时，全部取默认值且来源为 default', () => {
    const { config, provenance } = resolveConfig(bundle());
    expect(config.modelMain).toBe(DEFAULT_AGENT_CONFIG.modelMain);
    expect(provenance.modelMain).toBe('default');
    expect(provenance.credentialId).toBe('default');
  });

  it('实例配置覆盖默认值，来源标为 instance', () => {
    const { config, provenance } = resolveConfig(
      bundle({ modelMain: 'gpt-5', modelCheap: 'gpt-5-mini', credentialId: 'cred-1' }),
    );
    expect(config.modelMain).toBe('gpt-5');
    expect(config.modelCheap).toBe('gpt-5-mini');
    expect(config.credentialId).toBe('cred-1');
    expect(provenance.modelMain).toBe('instance');
  });

  it('空白字符串等同于没配，不能把默认值抹成空', () => {
    const { config, provenance } = resolveConfig(
      bundle({ modelMain: '   ', modelFallback: '' , nightQuiet: '' }),
    );
    expect(config.modelMain).toBe(DEFAULT_AGENT_CONFIG.modelMain);
    expect(config.modelFallback).toBeNull();
    expect(config.nightQuiet).toBe(DEFAULT_AGENT_CONFIG.nightQuiet);
    expect(provenance.modelMain).toBe('default');
  });

  it('温度越界不静默接受：保持默认，来源仍是 default（表示"设了但被拒"）', () => {
    const tooHigh = resolveConfig(bundle({ modelTemperature: 3 }));
    expect(tooHigh.config.modelTemperature).toBe(DEFAULT_AGENT_CONFIG.modelTemperature);
    expect(tooHigh.provenance.modelTemperature).toBe('default');

    const negative = resolveConfig(bundle({ modelTemperature: -0.5 }));
    expect(negative.config.modelTemperature).toBe(DEFAULT_AGENT_CONFIG.modelTemperature);
  });

  it('温度合法时按实例值，边界值（0 与 1.5）也接受', () => {
    expect(resolveConfig(bundle({ modelTemperature: 1.2 })).config.modelTemperature).toBe(1.2);
    expect(resolveConfig(bundle({ modelTemperature: 0 })).config.modelTemperature).toBe(0);
    expect(resolveConfig(bundle({ modelTemperature: 1.5 })).config.modelTemperature).toBe(1.5);
  });

  it('限速与日上限必须是正整数，否则回落默认', () => {
    const bad = resolveConfig(bundle({ rateLimitPerMin: 0, dailyMsgCap: -1 }));
    expect(bad.config.rateLimitPerMin).toBe(DEFAULT_AGENT_CONFIG.rateLimitPerMin);
    expect(bad.config.dailyMsgCap).toBe(DEFAULT_AGENT_CONFIG.dailyMsgCap);

    const good = resolveConfig(bundle({ rateLimitPerMin: 5, dailyMsgCap: 200 }));
    expect(good.config.rateLimitPerMin).toBe(5);
    expect(good.config.dailyMsgCap).toBe(200);
  });

  it('会话可以临时换人设，会话层优先级最高', () => {
    const { config, provenance } = resolveConfig(
      bundle(
        { activePersonaId: 'persona-instance' },
        {
          persona: { id: 'persona-instance', behaviorJson: '{}' },
          session: { id: 's1', personaId: 'persona-session', aiPaused: false, reviewMode: false, muted: false },
        },
      ),
    );
    expect(config.personaId).toBe('persona-session');
    expect(provenance.personaId).toBe('session');
  });

  it('会话没指定人设时用实例的 activePersonaId', () => {
    const { config, provenance } = resolveConfig(
      bundle({ activePersonaId: 'persona-1' }, { session: { id: 's1', personaId: null, aiPaused: false, reviewMode: false, muted: false } }),
    );
    expect(config.personaId).toBe('persona-1');
    expect(provenance.personaId).toBe('instance');
  });

  it('会话开关会原样带出（Pipeline 每轮都要读）', () => {
    const { sessionFlags } = resolveConfig(
      bundle({}, { session: { id: 's1', personaId: null, aiPaused: true, reviewMode: true, muted: true } }),
    );
    expect(sessionFlags).toEqual({ aiPaused: true, reviewMode: true, muted: true });
  });

  it('没有会话时开关全为 false（不存在 undefined）', () => {
    expect(resolveConfig(bundle()).sessionFlags).toEqual({
      aiPaused: false,
      reviewMode: false,
      muted: false,
    });
  });

  it('每个字段都有确定的来源，不存在漏标', () => {
    const { provenance } = resolveConfig(bundle({ modelMain: 'x' }));
    for (const key of Object.keys(DEFAULT_AGENT_CONFIG)) {
      expect(provenance[key as keyof typeof provenance]).toBeDefined();
    }
  });
});
