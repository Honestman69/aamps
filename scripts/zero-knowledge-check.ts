/**
 * 零知识验收：**绕过所有接口**，直连数据库看能看到什么。
 *
 * 这是 SECURITY.md 第 8 节第 5～6 条的落地验收：
 *   部署者（superadmin）拿到整库，仍然只能看到掩码，看不到任何一把 Key。
 *
 * 做法不是"检查几个字段"，而是**把整库所有表的所有字符串列翻一遍**：
 *   1. 每一把 `apiKeyEnc` 都是 `dek:v1:` 密文（不是 `wrap:v1:`，更不是明文）；
 *   2. 每一把 `keyMasked` 都是掩码形态；
 *   3. 全库（含审计日志、用户表）搜不到指定的明文靶子。
 *
 * 用法（先跑完 `http-smoke.ts`，它会留一条 `zk-keep` 凭据当靶子）：
 *   DATABASE_URL="file:../data/zk.db" ZK_PLAINTEXT="sk-smoke-zk-marker-4c3b2a19" \
 *     npx tsx scripts/zero-knowledge-check.ts
 */

import assert from 'node:assert/strict';

import { PrismaClient } from '@prisma/client';

/** 与 `http-smoke.ts` 中的默认值保持一致 */
const PLAINTEXT = process.env.ZK_PLAINTEXT ?? 'sk-smoke-zk-marker-4c3b2a19';

const DEK_SEALED = /^dek:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

type Row = Record<string, unknown>;

function step(name: string): void {
  process.stdout.write(`• ${name}\n`);
}

function stringValues(row: Row): string[] {
  return Object.values(row).filter((value): value is string => typeof value === 'string');
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    step('凭据表：每一把 Key 都是 dek:v1 密文');
    const credentials = await prisma.$queryRawUnsafe<Row[]>('SELECT * FROM "Credential"');
    assert.ok(credentials.length > 0, '没有凭据可供验收，请先跑 http-smoke.ts');

    for (const credential of credentials) {
      const enc = credential.apiKeyEnc;
      assert.equal(typeof enc, 'string', 'apiKeyEnc 缺失');
      assert.match(enc as string, DEK_SEALED, `凭据 ${String(credential.id)} 的密文格式不是 dek:v1`);
      assert.ok(
        !(enc as string).startsWith('wrap:v1:'),
        `凭据 ${String(credential.id)} 存的是包裹后的 DEK，说明用错了加密路径`,
      );
      assert.ok(
        !(enc as string).includes(PLAINTEXT),
        `凭据 ${String(credential.id)} 的密文字段里出现了明文`,
      );
    }

    step('凭据表：keyMasked 是掩码，不是完整 Key');
    for (const credential of credentials) {
      const masked = credential.keyMasked;
      assert.equal(typeof masked, 'string');
      assert.ok((masked as string).includes('****'), `掩码格式不对：${String(masked)}`);
      assert.ok((masked as string).length <= 16, `掩码过长，可能泄漏了原文：${String(masked)}`);
      assert.notEqual(masked, PLAINTEXT);
    }

    step('全库扫描：所有表的所有字符串列都搜不到明文靶子');
    const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'",
    );
    assert.ok(tables.length > 0, '没读到任何表，DATABASE_URL 是否指错了库？');

    let scannedColumns = 0;
    const hits: string[] = [];
    for (const { name } of tables) {
      const rows = await prisma.$queryRawUnsafe<Row[]>(`SELECT * FROM "${name.replace(/"/g, '""')}"`);
      for (const row of rows) {
        for (const value of stringValues(row)) {
          scannedColumns += 1;
          if (value.includes(PLAINTEXT)) {
            hits.push(`${name}`);
          }
          assert.ok(
            !value.startsWith('enc:v1:'),
            `表 ${name} 里出现了旧格式密文 enc:v1:，必须迁移后才能上线`,
          );
        }
      }
    }
    assert.deepEqual(hits, [], `明文出现在这些表里：${hits.join(', ')}`);

    step('汇总');
    process.stdout.write(
      `  表 ${tables.length} 张，扫描字符串值 ${scannedColumns} 个，凭据 ${credentials.length} 条，命中明文 0 条\n`,
    );
    for (const credential of credentials) {
      process.stdout.write(
        `  - ${String(credential.provider)} / ${String(credential.label)} → ${String(credential.keyMasked)}\n`,
      );
    }

    process.stdout.write('\nZERO-KNOWLEDGE CHECK PASSED\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`\nZERO-KNOWLEDGE CHECK FAILED: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
