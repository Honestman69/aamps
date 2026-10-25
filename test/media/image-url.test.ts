import { describe, expect, it } from 'vitest';

import {
  checkRemoteUrl,
  isHostAllowlisted,
  parseHostAllowlist,
} from '@/modules/media/image-url';

describe('checkRemoteUrl（出站：只允许 https）', () => {
  const outbound = { allowHttp: false, allowHosts: [] as string[] };

  it('公网 https 图片放行', () => {
    const check = checkRemoteUrl('https://example.com/a.jpg', outbound);
    expect(check.ok).toBe(true);
  });

  it('出站 http 不行，入站可以（QQ 图床是 http）', () => {
    expect(checkRemoteUrl('http://example.com/a.jpg', outbound).ok).toBe(false);
    expect(
      checkRemoteUrl('http://multimedia.nt.qq.com.cn/a.jpg', { allowHttp: true, allowHosts: [] }).ok,
    ).toBe(true);
  });

  it('非 http(s) 协议一律拒绝', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/a.jpg', 'data:image/png;base64,AA']) {
      const check = checkRemoteUrl(url, { allowHttp: true, allowHosts: [] });
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toBe('bad_scheme');
    }
  });

  it('内网与回环地址拒绝', () => {
    for (const url of [
      'http://127.0.0.1/a.jpg',
      'http://10.1.2.3/a.jpg',
      'http://192.168.1.5/a.jpg',
      'http://172.16.0.9/a.jpg',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/a.jpg',
      'http://localhost/a.jpg',
      'http://nas.local/a.jpg',
      'http://intranet/a.jpg',
    ]) {
      const check = checkRemoteUrl(url, { allowHttp: true, allowHosts: [] });
      expect(check.ok, url).toBe(false);
    }
  });

  it('公网 IP 字面量也拒绝（真实图床都用域名）', () => {
    const check = checkRemoteUrl('https://1.2.3.4/a.jpg', outbound);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('ip_literal');
  });

  it('带 user:pass 的 URL 拒绝', () => {
    const check = checkRemoteUrl('https://user:pass@example.com/a.jpg', outbound);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('has_credentials');
  });

  it('白名单生效：只放行列出的域名及其子域', () => {
    const allow = ['example.com'];
    expect(checkRemoteUrl('https://example.com/a.jpg', { allowHttp: false, allowHosts: allow }).ok).toBe(true);
    expect(checkRemoteUrl('https://img.example.com/a.jpg', { allowHttp: false, allowHosts: allow }).ok).toBe(true);
    const evil = checkRemoteUrl('https://evil-example.com/a.jpg', { allowHttp: false, allowHosts: allow });
    expect(evil.ok).toBe(false);
    if (!evil.ok) expect(evil.reason).toBe('not_allowlisted');
  });

  it('坏 URL 不抛错，返回 bad_url', () => {
    const check = checkRemoteUrl('not a url', outbound);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('bad_url');
  });
});

describe('白名单解析', () => {
  it('逗号分隔、去空格、小写', () => {
    expect(parseHostAllowlist(' Example.com , img.QQ.com ,, ')).toEqual(['example.com', 'img.qq.com']);
    expect(parseHostAllowlist('')).toEqual([]);
  });

  it('空白名单 = 不限制', () => {
    expect(isHostAllowlisted('anything.example', [])).toBe(true);
  });
});
