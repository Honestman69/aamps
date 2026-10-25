/**
 * 出站媒体文件落盘（D033）。
 *
 * 出来的语音不落内存也不送到临时目录：OneBot 的 `record.file` 最稳的用法是**本机绝对路径**，
 * 如果给的是我们的内存 buffer，就总得想办法先变成协议端能读到的东西。
 *
 * ## 文件名与安全
 *
 * 文件名是 `sha256(模型 + 音色 + 文本)` 的前 32 位，**绝不用模型生成的文本命名**：
 * 那等于把拼接路径的权力交给模型（`../../` 之类）。同一个内容只会落一个文件，天然做了缓存。
 *
 * ## 已知限制
 *
 * 没有自动清理。语音文件按内容去重后增长很慢（同一句话只存一份），
 * 清理属于 M6 的 worker（按 mtime 保留 N 天），现在不做半套。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface IMediaFileStore {
  /** 命中返回绝对路径，没有返回 null */
  find(kind: string, key: string, ext: string): Promise<string | null>;
  write(kind: string, key: string, ext: string, data: Buffer): Promise<string>;
}

export function contentKey(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

export function resolveMediaDir(): string {
  return process.env.MEDIA_DIR?.trim() || path.join(process.cwd(), 'data', 'media');
}

export class LocalMediaFileStore implements IMediaFileStore {
  constructor(private readonly dir: string = resolveMediaDir()) {}

  private filePath(kind: string, key: string, ext: string): string {
    // kind 只允许字母：防 `../` 从调用方漏进来
    const safeKind = /^[a-z]+$/.test(kind) ? kind : 'misc';
    const safeExt = /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'bin';
    return path.join(this.dir, safeKind, `${key}.${safeExt}`);
  }

  async find(kind: string, key: string, ext: string): Promise<string | null> {
    const file = this.filePath(kind, key, ext);
    try {
      const data = await readFile(file);
      return data.byteLength > 0 ? file : null;
    } catch {
      return null;
    }
  }

  async write(kind: string, key: string, ext: string, data: Buffer): Promise<string> {
    const file = this.filePath(kind, key, ext);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
    return file;
  }
}
