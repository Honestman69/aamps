/**
 * 接入地址护栏：**默认只允许连本机 / 内网的协议端**。
 *
 * 为什么需要它：
 *   我们的设计里 `endpoint` 是数据，用户想填什么就能填什么（D016）。
 *   但"能填"不等于"该填"——指向一个陌生地址的 NapCat，等于把 QQ 登录态交给对方
 *   （对方能读所有消息、能以你的身份发消息）。这个风险不该靠"记得别填"来避免。
 *
 * 判定口径：**内网地址放行，公网地址必须显式打开 `ALLOW_REMOTE_ADAPTER=true`**。
 * 开关默认关，且只认 `true` / `1`（见 `boolEnv`），写错字不会意外打开。
 */

import { AppError } from '@newjob/contracts';

import { boolEnv } from '../../common/config/env';

export const ALLOW_REMOTE_ADAPTER_ENV = 'ALLOW_REMOTE_ADAPTER';

/** 100.64.0.0/10（CGNAT）常被 Tailscale 等组网工具使用，按"内网"对待 */
function isTailscaleRange(octets: number[]): boolean {
  return octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return true; // 回环
  if (a === 10) return true; // 私有 A
  if (a === 192 && b === 168) return true; // 私有 C
  if (a === 172 && b >= 16 && b <= 31) return true; // 私有 B
  if (a === 169 && b === 254) return true; // 链路本地
  return isTailscaleRange(octets);
}

/** 单标签主机名（如 docker compose 里的 `napcat`）与常见的内部域名后缀 */
function isInternalName(host: string): boolean {
  if (host === 'localhost') return true;
  if (!host.includes('.')) return true;
  return /\.(localhost|local|internal|lan|home\.arpa)$/i.test(host);
}

export function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '::1') return true;
  if (isInternalName(host)) return true;
  return isPrivateIpv4(host);
}

export function remoteEndpointsAllowed(): boolean {
  return boolEnv(ALLOW_REMOTE_ADAPTER_ENV);
}

/**
 * 校验一个接入地址是否允许。不合法直接抛 400，并把"为什么"和"怎么改"一起说清楚。
 * 在 create / update / connect 三处都调用：存储时拦一次，真正拨号前再拦一次，
 * 防止"当时开关开着存进去、后来关掉了还照连"。
 *
 * `mode` 决定这段地址的**用途**，风险方向相反，所以文案也必须相反：
 *   - `client`（拨号）：我们连过去 → 风险是"连到别人的 NapCat，登录态被对方拿走"
 *   - `server`（监听）：对方连过来 → 风险是"在公网开了一个口子，谁扫到都能试"
 */
export function assertEndpointAllowed(endpoint: string, mode?: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AppError('ENDPOINT_INVALID', '接入地址不是合法 URL', 400);
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new AppError('ENDPOINT_INVALID', '接入地址必须是 ws:// 或 wss://', 400);
  }
  if (isLocalOrPrivateHost(url.hostname) || remoteEndpointsAllowed()) {
    return;
  }

  if (mode === 'server') {
    throw new AppError(
      'REMOTE_ENDPOINT_BLOCKED',
      `拒绝在公网地址 ${url.hostname} 上监听：这会在公网上开一个 OneBot 端口，` +
        `扫描到的人就能拿到这个 QQ 号的控制权。反向模式请填回环地址（ws://127.0.0.1:3002），` +
        `让 NapCat 从本机或内网连进来；确实要跨公网时先建隧道（Tailscale / SSH），` +
        `或显式设置 ${ALLOW_REMOTE_ADAPTER_ENV}=true 表示你清楚这个风险。`,
      400,
    );
  }

  throw new AppError(
    'REMOTE_ENDPOINT_BLOCKED',
    `拒绝连接公网地址 ${url.hostname}：对方将持有该 QQ 号的登录态。` +
      `请把 NapCat 部署在本机或内网；确实需要跨机时先建隧道（Tailscale / SSH），` +
      `或显式设置 ${ALLOW_REMOTE_ADAPTER_ENV}=true 表示你清楚这个风险。`,
    400,
  );
}
