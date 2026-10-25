import { describe, expect, it } from 'vitest';

import {
  MAX_IMAGES_PER_REPLY,
  MAX_VOICE_CHARS,
  parseMediaIntent,
  stripStrayMediaTags,
} from '@/modules/media/intent';

const both = { allowImage: true, allowVoice: true };

describe('parseMediaIntent', () => {
  it('正文 + 图片指令：正文剥离出来，图片按顺序收集', () => {
    const intent = parseMediaIntent('给你看个东西\n[img]https://example.com/a.jpg[/img]', both);
    expect(intent.text).toBe('给你看个东西');
    expect(intent.images).toEqual(['https://example.com/a.jpg']);
    expect(intent.voice).toBeNull();
  });

  it('指令必须独占一行：正文里顺嘴提到不会被当成指令', () => {
    const intent = parseMediaIntent('我发了 [img]https://example.com/a.jpg[/img] 你看到了吗', both);
    expect(intent.images).toEqual([]);
    expect(intent.text).toContain('[img]');
  });

  it('出站图片只允许 https', () => {
    const intent = parseMediaIntent('[img]http://example.com/a.jpg[/img]', both);
    expect(intent.images).toEqual([]);
    expect(intent.dropped[0]).toEqual({ kind: 'image', reason: 'bad_scheme' });
  });

  it('内网地址被拦，标记不会留在正文里', () => {
    const intent = parseMediaIntent('看\n[img]https://192.168.1.2/a.jpg[/img]', both);
    expect(intent.images).toEqual([]);
    expect(intent.text).toBe('看');
    expect(intent.dropped[0]?.reason).toBe('private_host');
  });

  it('白名单外的域名被拦', () => {
    const intent = parseMediaIntent('[img]https://evil.example.net/a.jpg[/img]', {
      ...both,
      imageHosts: 'example.com',
    });
    expect(intent.images).toEqual([]);
    expect(intent.dropped[0]?.reason).toBe('not_allowlisted');
  });

  it('图片最多两张', () => {
    const raw = [
      '[img]https://example.com/1.jpg[/img]',
      '[img]https://example.com/2.jpg[/img]',
      '[img]https://example.com/3.jpg[/img]',
    ].join('\n');
    const intent = parseMediaIntent(raw, both);
    expect(intent.images).toHaveLength(MAX_IMAGES_PER_REPLY);
    expect(intent.dropped).toEqual([{ kind: 'image', reason: 'too_many' }]);
  });

  it('语音只取第一条，超长截断', () => {
    const long = '啊'.repeat(MAX_VOICE_CHARS + 50);
    const intent = parseMediaIntent(`[voice]${long}[/voice]\n[voice]第二句[/voice]`, both);
    expect(intent.voice).toHaveLength(MAX_VOICE_CHARS);
    expect(intent.dropped).toEqual([{ kind: 'voice', reason: 'too_many' }]);
  });

  it('平台不支持语音：内容转到 voiceAsText，由调用方当文字发', () => {
    const intent = parseMediaIntent('[voice]晚安[/voice]', { allowImage: true, allowVoice: false });
    expect(intent.voice).toBeNull();
    expect(intent.voiceAsText).toBe('晚安');
    expect(intent.dropped[0]).toEqual({ kind: 'voice', reason: 'disabled' });
  });

  it('空语音标签被丢弃', () => {
    const intent = parseMediaIntent('[voice]   [/voice]', both);
    expect(intent.voice).toBeNull();
    expect(intent.dropped[0]).toEqual({ kind: 'voice', reason: 'empty' });
  });

  it('没有指令时原样返回正文', () => {
    const intent = parseMediaIntent('就普通聊两句\n第二行', both);
    expect(intent.text).toBe('就普通聊两句\n第二行');
    expect(intent.images).toEqual([]);
    expect(intent.voice).toBeNull();
  });
});

describe('stripStrayMediaTags', () => {
  it('写错的标签整行删掉，正文不受影响', () => {
    const text = '好的\n[img]https://example.com/a.jpg[/image]\n明天见';
    expect(stripStrayMediaTags(text)).toBe('好的\n明天见');
  });

  it('正文里的普通方括号保留', () => {
    expect(stripStrayMediaTags('这是 [重点] 内容')).toBe('这是 [重点] 内容');
  });
});

describe('素材库指令（D034）', () => {
  it('用素材：别名进 uses，不混进正文', () => {
    const intent = parseMediaIntent('哈哈哈\n[use]猫猫震惊[/use]', both);
    expect(intent.uses).toEqual(['猫猫震惊']);
    expect(intent.text).toBe('哈哈哈');
    expect(intent.images).toEqual([]);
  });

  it('存素材：最多一条，第二条被丢', () => {
    const intent = parseMediaIntent('[save]猫猫[/save]\n[save]狗子[/save]', both);
    expect(intent.saves).toEqual(['猫猫']);
    expect(intent.dropped).toEqual([{ kind: 'save', reason: 'too_many' }]);
  });

  it('外链与素材共用图片数量上限', () => {
    const raw = [
      '[img]https://example.com/1.jpg[/img]',
      '[img]https://example.com/2.jpg[/img]',
      '[use]猫猫[/use]',
    ].join('\n');
    const intent = parseMediaIntent(raw, both);
    expect(intent.images).toHaveLength(2);
    expect(intent.uses).toHaveLength(0);
    expect(intent.dropped[0]).toEqual({ kind: 'use', reason: 'too_many' });
  });

  it('平台不支持图片时，use/save 都不生效', () => {
    const intent = parseMediaIntent('[use]猫猫[/use]\n[save]狗子[/save]', {
      allowImage: false,
      allowVoice: false,
    });
    expect(intent.uses).toEqual([]);
    expect(intent.saves).toEqual([]);
    expect(intent.dropped.map((d) => d.kind)).toEqual(['use', 'save']);
  });

  it('空别名被丢弃', () => {
    const intent = parseMediaIntent('[use][/use]\n[save]   [/save]', both);
    expect(intent.uses).toEqual([]);
    expect(intent.saves).toEqual([]);
    expect(intent.dropped.map((d) => d.reason)).toEqual(['empty', 'empty']);
  });

  it('写错的 use/save 标签不会漏给用户', () => {
    expect(stripStrayMediaTags('好的\n[use]猫猫[/uses]\n嗯')).toBe('好的\n嗯');
  });
});
