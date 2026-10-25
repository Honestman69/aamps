/**
 * 远程 URL 的安全校验（D033）。
 *
 * ## 为什么要在这里拦
 *
 * 两类 URL 都会离开我们、交给别人去访问：
 *
 *   - **入站图片**：由我们自己下载（`fetcher.ts`），内网地址等于让我们去扫内网；
 *   - **出站图片**：由 NapCat 下载后发到 QQ，内网地址等于让别人替我们扫内网。
 *
 * 两处的归宿不同，但门槛必须一致。所以校验只写一份，只有 `allowHttp` 与白名单两个开关不同：
 * 入站必须允许 http（QQ 图床就是 http），出站只允许 https（模型给的链接没有理由不是 https）。
 *
 * ## 拦什么
 *
 * | 拦 | 理由 |
 * |---|---|
 * | 非 http/https（file/ftp/data…） | `file:///etc/passwd` 这类不该出现在网络位置 |
 * | IP 字面量（含 IPv6） | 公网图片几乎没有直接用 IP 的，而判断私网段是漏一处就破 |
 * | 单标签域名 / `.local` `.internal` 等 | 典型的内网主机名 |
 * | 带 user:pass 的 URL | 会被当成"看起来正常"的绕道手段 |
 *
 * **不做 DNS 解析后再判**：解析一次再连一次会有 TOCTOU 窗口，而这里的目标是
 * "别让模型一句话把请求打到内网"，拦字面量与内网后缀已经覆盖绝大多数情况；
 * 真要连内网，需要用户自己把域名放进白名单（那是显式决定，不是被模型诱导）。
 */

export type UrlRejectReason =
  | 'bad_url'
  | 'bad_scheme'
  | 'ip_literal'
  | 'private_host'
  | 'has_credentials'
  | 'not_allowlisted';

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: UrlRejectReason };

/** 内网后缀：`.local` 是 mDNS，`.internal` 云厂商内网，`.lan`/`.home.arpa` 家用 */
const PRIVATE_SUFFIXES = ['.local', '.internal', '.localhost', '.lan', '.home.arpa'];

function isIpLiteral(hostname: string): boolean {
  // URL 里的 IPv6 带方括号：http://[::1]:8080/x
  if (hostname.startsWith('[') || hostname.includes(':')) {
    return true;
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * 私有网段。
 *
 * 只在 `isIpLiteral` 为真时用得上；单列出来是为了让"10.x 是内网"这件事在代码里可读，
 * 而不是散在正则里。
 */
const PRIVATE_IPV4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
];

function isPrivateIpv4(hostname: string): boolean {
  return PRIVATE_IPV4.some((pattern) => pattern.test(hostname));
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost') {
    return true;
  }
  if (!host.includes('.')) {
    // 单标签域名（http://intranet/xxx）无法判断归属，一律拒绝
    return true;
  }
  return PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** 白名单匹配：完全相同或以 `.域名` 结尾（避免 evil-example.com 命中 example.com） */
export function isHostAllowlisted(hostname: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) {
    return true;
  }
  const host = hostname.toLowerCase();
  return allowed.some((entry) => {
    const target = entry.trim().toLowerCase();
    return target.length > 0 && (host === target || host.endsWith(`.${target}`));
  });
}

export function checkRemoteUrl(
  raw: string,
  options: { allowHttp: boolean; allowHosts: readonly string[] },
): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'bad_url' };
  }

  const scheme = url.protocol.toLowerCase();
  const schemeOk = scheme === 'https:' || (options.allowHttp && scheme === 'http:');
  if (!schemeOk) {
    return { ok: false, reason: 'bad_scheme' };
  }

  if (url.username || url.password) {
    return { ok: false, reason: 'has_credentials' };
  }

  const hostname = url.hostname.toLowerCase();
  if (isIpLiteral(hostname)) {
    // IP 字面量：私网直接拒；公网 IP 也拒（无法与白名单对齐，且真实图床都用域名）
    return { ok: false, reason: isPrivateIpv4(hostname) ? 'private_host' : 'ip_literal' };
  }

  if (isPrivateHostname(hostname)) {
    return { ok: false, reason: 'private_host' };
  }

  if (!isHostAllowlisted(hostname, options.allowHosts)) {
    return { ok: false, reason: 'not_allowlisted' };
  }

  return { ok: true, url };
}

/** 把 `a.com, b.com` 解析成数组。空串 = 不限制（仍受上面的私网规则约束） */
export function parseHostAllowlist(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}
