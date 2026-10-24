/**
 * 接入地址护栏测试。
 *
 * 核心断言只有一句：**公网地址默认拒绝，内网地址默认放行**。
 * 这条规则是"QQ 登录态只能留在自己机器上"的技术兜底，不能靠使用者自觉。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  ALLOW_REMOTE_ADAPTER_ENV,
  assertEndpointAllowed,
  isLocalOrPrivateHost,
} from '@/modules/instance/endpoint-guard';

const ENV_KEY = ALLOW_REMOTE_ADAPTER_ENV;
const original = process.env[ENV_KEY];

afterEach(() => {
  if (original === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = original;
  }
});

describe('isLocalOrPrivateHost', () => {
  it('accepts loopback and local names', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'napcat', 'napcat.local']) {
      expect(isLocalOrPrivateHost(host), host).toBe(true);
    }
  });

  it('accepts RFC1918 private ranges and Tailscale CGNAT', () => {
    for (const host of [
      '10.0.0.5',
      '192.168.1.20',
      '172.16.0.9',
      '172.31.255.1',
      '169.254.1.1',
      '100.101.102.103', // Tailscale
    ]) {
      expect(isLocalOrPrivateHost(host), host).toBe(true);
    }
  });

  it('rejects public addresses and DNS names', () => {
    for (const host of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', 'napcat.example.com']) {
      expect(isLocalOrPrivateHost(host), host).toBe(false);
    }
  });
});

describe('assertEndpointAllowed', () => {
  it('allows localhost endpoints without any switch', () => {
    delete process.env[ENV_KEY];
    expect(() => assertEndpointAllowed('ws://127.0.0.1:3001')).not.toThrow();
    expect(() => assertEndpointAllowed('ws://napcat:3001')).not.toThrow();
  });

  it('blocks public endpoints by default and explains how to proceed', () => {
    delete process.env[ENV_KEY];
    expect(() => assertEndpointAllowed('ws://bot.example.com:3001')).toThrowError(/公网/);
    try {
      assertEndpointAllowed('ws://203.0.113.9:3001');
    } catch (err) {
      const error = err as { code: string; httpStatus: number; message: string };
      expect(error.code).toBe('REMOTE_ENDPOINT_BLOCKED');
      expect(error.httpStatus).toBe(400);
      expect(error.message).toContain(ENV_KEY);
    }
  });

  it('allows public endpoints only when the switch is explicitly on', () => {
    process.env[ENV_KEY] = 'true';
    expect(() => assertEndpointAllowed('ws://bot.example.com:3001')).not.toThrow();
    expect(() => assertEndpointAllowed('ws://bot.example.com:3002', 'server')).not.toThrow();
  });

  it('explains listening risk, not dial-out risk, in reverse mode', () => {
    // 反向模式下这段地址是**我们自己要监听的**，风险方向相反：
    // 不是"连到别人的 NapCat"，而是"在公网上开了一个口子"
    delete process.env[ENV_KEY];
    try {
      assertEndpointAllowed('ws://203.0.113.9:3002', 'server');
      throw new Error('应当被拒绝');
    } catch (err) {
      const error = err as { code: string; message: string };
      expect(error.code).toBe('REMOTE_ENDPOINT_BLOCKED');
      expect(error.message).toContain('监听');
      expect(error.message).toContain('127.0.0.1');
    }
  });

  it('blocks 0.0.0.0 for listening by default (that would be every interface)', () => {
    delete process.env[ENV_KEY];
    expect(() => assertEndpointAllowed('ws://0.0.0.0:3002', 'server')).toThrowError(/公网|监听/);
    // 回环地址才是反向模式的正常填法
    expect(() => assertEndpointAllowed('ws://127.0.0.1:3002', 'server')).not.toThrow();
  });

  it('only treats true / 1 (after trim, case-insensitive) as consent', () => {
    for (const value of ['true', 'TRUE', ' 1 ']) {
      process.env[ENV_KEY] = value;
      expect(() => assertEndpointAllowed('ws://bot.example.com:3001'), value).not.toThrow();
    }
    for (const value of ['yes', 'on', 'ok', 'y', '2', '']) {
      process.env[ENV_KEY] = value;
      expect(() => assertEndpointAllowed('ws://bot.example.com:3001'), value).toThrow();
    }
  });

  it('rejects non-websocket schemes', () => {
    expect(() => assertEndpointAllowed('http://127.0.0.1:3001')).toThrowError(/ws:\/\//);
    expect(() => assertEndpointAllowed('not-a-url')).toThrowError(/合法 URL/);
  });
});
