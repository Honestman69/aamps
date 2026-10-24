/**
 * 连接一个实例（M1 阶段的临时「后台」）。
 *
 * 为什么需要它：管理后台要到 M4 才做（见 `docs/STATUS.md`），而 M1 验收必须真的
 * 走一遍「登录 → 解锁 → 连接 → 收 pong」。手动 curl 要自己管 cookie，
 * 这里把三步串起来，省掉拼参数的功夫。
 *
 * 用法（密码从环境变量读，不落盘、不进 shell 历史）：
 *
 *   ADMIN_USERNAME=你的用户名 ADMIN_PASSWORD=你的密码 pnpm tsx scripts/connect-instance.ts
 *
 * 可选：
 *   BASE_URL=http://127.0.0.1:3000   # 服务地址
 *   INSTANCE_ID=<id>                 # 有多个实例时指定；只有一个实例会自动选
 *
 * 登录 = 验密码 + 解锁（DEK 进内存），所以这个脚本跑完，实例的 token 才解得开。
 */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';

/**
 * 去掉包裹的引号。
 * 现实里有人的 `.env` 写成 `BOOTSTRAP_ADMIN_PASSWORD="xxx"`，
 * 手动 `cp` 到命令行时会连引号一起带上 —— 那会得到一个"密码错误"的 401，
 * 而真实原因只是多了两个字符。这里按 dotenv 的规则先剥一层。
 */
function unquote(value: string): string {
  const text = value.trim();
  const quoted =
    (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"));
  return quoted ? text.slice(1, -1) : text;
}

const USERNAME = unquote(process.env.ADMIN_USERNAME ?? '');
const PASSWORD = unquote(process.env.ADMIN_PASSWORD ?? '');
const WANTED_ID = process.env.INSTANCE_ID ?? '';

type InstanceRow = {
  id: string;
  name: string;
  accountId: string;
  adapterMode: string;
  endpoint: string | null;
  hasAccessToken: boolean;
  status: string;
};

let cookie = '';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (cookie) {
    headers.cookie = cookie;
  }
  // 本机服务不该走代理；设了也没关系，但显式禁用更稳
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    cookie = setCookie.map((item) => item.split(';')[0]).join('; ');
  }
  const raw = await response.text();
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 保留文本
  }
  if (!response.ok) {
    const message =
      typeof parsed === 'object' && parsed && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : raw.slice(0, 200);
    throw new Error(`${method} ${path} → HTTP ${response.status}：${message}`);
  }
  return parsed as T;
}

function maskAccount(accountId: string): string {
  return accountId.length <= 4 ? '****' : `${accountId.slice(0, 2)}****${accountId.slice(-2)}`;
}

async function main(): Promise<void> {
  if (!USERNAME || !PASSWORD) {
    console.error('缺少 ADMIN_USERNAME / ADMIN_PASSWORD 环境变量');
    process.exit(2);
  }

  const login = await call<{ user: { username: string; role: string }; unlocked: boolean }>(
    'POST',
    '/api/auth/login',
    { username: USERNAME, password: PASSWORD },
  );
  console.log(`已登录：${login.user.username}（${login.user.role}），解锁=${login.unlocked}`);
  if (!login.unlocked) {
    throw new Error('登录成功但没有解锁，实例 token 解不开，无法连接');
  }

  const instances = await call<InstanceRow[]>('GET', '/api/instances');
  if (instances.length === 0) {
    console.log('没有任何实例。先用 POST /api/instances 建一条（QQ 号 + 接入地址 + token）。');
    return;
  }

  console.log('\n实例列表：');
  for (const row of instances) {
    console.log(
      `  ${row.id}  ${row.name}  ${maskAccount(row.accountId)}  ` +
        `${row.adapterMode}  ${row.endpoint ?? '(无地址)'}  ` +
        `token=${row.hasAccessToken ? '有' : '无'}  status=${row.status}`,
    );
  }

  const target = WANTED_ID ? instances.find((row) => row.id === WANTED_ID) : instances[0];
  if (!target) {
    throw new Error(`找不到实例 ${WANTED_ID}`);
  }
  if (!WANTED_ID && instances.length > 1) {
    throw new Error('有多个实例，请用 INSTANCE_ID 指定要连哪一个');
  }

  console.log(`\n连接 ${target.name}（${target.adapterMode} → ${target.endpoint}）...`);
  const result = await call<{ status: string; accountId: string; platform: string }>(
    'POST',
    `/api/instances/${target.id}/connect`,
  );
  console.log(`连接成功：status=${result.status} platform=${result.platform}`);

  if (target.adapterMode === 'server') {
    console.log(
      `\n反向模式：本服务已在 ${target.endpoint} 上监听，NapCat 会自己连进来（重试间隔常见 5 秒）。` +
        `\n如果状态不是 online，说明 NapCat 还没连上，看它的日志里的「反向WebSocket」。`,
    );
  }

  console.log('\n下一步：用 QQ 给这个号发一条消息，应该收到 pong。');
  console.log('看服务日志：node dist/src/main.js 的输出（或你的进程管理器）。');
}

main().catch((err) => {
  console.error(`失败：${(err as Error).message}`);
  process.exit(1);
});
