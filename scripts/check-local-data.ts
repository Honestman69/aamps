/**
 * 提交前的一道闸：**协议端（NapCat / NTQQ）的本地数据绝不允许进版本库**。
 *
 * 为什么这条要做成脚本而不是写在文档里：
 *   `.gitignore` 只防"误加"，防不住 `git add -f`、也防不住有人把目录拷到别的路径下。
 *   而这些文件里是 QQ 的登录会话 —— 一旦进了仓库又推上去，等于把账号控制权公开，
 *   而且 git 历史删不干净，只能rewrite。宁可提交时红一次。
 *
 * 检查两条来源：
 *   1. 已被跟踪的文件（`git ls-files`）—— 已经加进去了，最危险；
 *   2. 未跟踪且**没被忽略**的文件（`git ls-files --others --exclude-standard`）——
 *      说明 `.gitignore` 漏了这个路径，下次 `git add -A` 就会被带进去。
 *
 * 用法：pnpm check:local-data
 */

import { execFileSync } from 'node:child_process';

/** 命中任意一条即视为"协议端数据" */
const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: 'NapCat 数据目录', pattern: /^(.*\/)?(napcat|napcat-data|NapCat[^/]*|ntqq|qq-data)\//i },
  { name: 'QQ 客户端数据目录', pattern: /(^|\/)\.config\/QQ\//i },
  { name: 'NapCat 按账号配置（含 access_token）', pattern: /(^|\/)onebot_[^/]*\.json$/i },
  { name: 'NTQQ 会话文件', pattern: /(^|\/)ntqq_[^/]*\.json$/i },
  { name: 'SQLite 数据库', pattern: /\.db(-wal|-shm)?$/i },
  { name: 'data 目录下的文件（应只在本地生成）', pattern: /^data\/(?!\.gitkeep$).+/ },
];

function gitList(args: string[]): string[] {
  const output = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return output.split('\u0000').filter((line) => line.length > 0);
}

function offenders(files: string[]): Array<{ file: string; reason: string }> {
  const hits: Array<{ file: string; reason: string }> = [];
  for (const file of files) {
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(file)) {
        hits.push({ file, reason: rule.name });
        break;
      }
    }
  }
  return hits;
}

function main(): void {
  const tracked = gitList(['ls-files', '-z']);
  const untracked = gitList(['ls-files', '-z', '--others', '--exclude-standard']);

  const problems = [
    ...offenders(tracked).map((hit) => ({ ...hit, state: '已跟踪' as const })),
    ...offenders(untracked).map((hit) => ({ ...hit, state: '未被忽略' as const })),
  ];

  if (problems.length === 0) {
    process.stdout.write(`LOCAL-DATA CHECK PASSED（检查 ${tracked.length} 个已跟踪文件）\n`);
    return;
  }

  process.stderr.write('\nLOCAL-DATA CHECK FAILED：以下文件属于协议端本地数据，不能进版本库\n\n');
  for (const problem of problems) {
    process.stderr.write(`  [${problem.state}] ${problem.file}\n      ${problem.reason}\n`);
  }
  process.stderr.write(
    '\n处理方式：\n' +
      '  - 已跟踪的：git rm --cached <文件>，然后确认 .gitignore 覆盖它\n' +
      '  - 未被忽略的：把所在路径加进 .gitignore（不要靠"下次注意"）\n' +
      '  - 若已经提交过：需要重写历史并从所有远端删除，光删文件不够\n\n' +
      '这些目录里是 QQ 登录态，等同于账号控制权；迁移或换机时应在本地重新扫码生成，不要搬运。\n',
  );
  process.exitCode = 1;
}

main();
