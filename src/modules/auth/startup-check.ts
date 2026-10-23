/**
 * 启动自检：扫描库里的密文字段，确认全部是当前格式（SECURITY.md 第 8 条第 12 条）。
 *
 * 防的是什么事故：开发期用全局 KEK 存过几条 `enc:v1:`，上线后忘了迁移。
 * 那会同时存在两条解密路径 —— 而后门就藏在这种"临时兼容"里。
 * 宁可启动失败并提示迁移，也不带着双路径上线。
 *
 * 注意：这是**唯一**允许全表扫描凭据的地方，且只 select 密文列与主键，
 * 不取 label / owner 之外的任何业务字段，也不解密。
 */

import { AppError } from '@newjob/contracts';
import type { PrismaClient } from '@prisma/client';

import { DEK_SEAL_PREFIX, LEGACY_SEAL_PREFIX, isDekSealed } from '../../common/crypto';

export type CiphertextIssue = {
  table: 'Credential' | 'BotInstance';
  rowId: string;
  field: string;
  reason: string;
};

function describe(value: string): string {
  if (value.startsWith(LEGACY_SEAL_PREFIX)) {
    return '旧格式 enc:v1:，必须迁移后重新录入';
  }
  // 只描述形态，不打印密文本身
  return `前缀不是 ${DEK_SEAL_PREFIX}`;
}

export async function scanCiphertextPrefixes(prisma: PrismaClient): Promise<CiphertextIssue[]> {
  const issues: CiphertextIssue[] = [];

  const credentials = await prisma.credential.findMany({
    select: { id: true, apiKeyEnc: true },
  });
  for (const row of credentials) {
    if (!isDekSealed(row.apiKeyEnc)) {
      issues.push({
        table: 'Credential',
        rowId: row.id,
        field: 'apiKeyEnc',
        reason: describe(row.apiKeyEnc),
      });
    }
  }

  const instances = await prisma.botInstance.findMany({
    select: { id: true, accessTokenEnc: true, appSecretEnc: true },
  });
  for (const row of instances) {
    // 两个字段都可空：null 代表"没配"，不是问题
    for (const [field, value] of [
      ['accessTokenEnc', row.accessTokenEnc],
      ['appSecretEnc', row.appSecretEnc],
    ] as const) {
      if (value !== null && !isDekSealed(value)) {
        issues.push({ table: 'BotInstance', rowId: row.id, field, reason: describe(value) });
      }
    }
  }

  return issues;
}

/** 启动时调用：有问题直接抛，不要降级 */
export async function assertNoLegacyCiphertexts(prisma: PrismaClient): Promise<void> {
  const issues = await scanCiphertextPrefixes(prisma);
  if (issues.length === 0) {
    return;
  }
  const summary = issues
    .slice(0, 5)
    .map((issue) => `${issue.table}.${issue.field}#${issue.rowId}(${issue.reason})`)
    .join('; ');
  throw new AppError(
    'LEGACY_CIPHERTEXT',
    `启动自检失败：${issues.length} 条密文前缀不合法，须先迁移（${summary}）`,
    500,
  );
}
