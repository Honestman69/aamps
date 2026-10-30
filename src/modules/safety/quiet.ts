/**
 * 夜间静默的**纯函数**（M6-2 / D049）。
 *
 * ARCHITECTURE 7.1 一直写着"夜间静默 00:30–07:30，除 @ 外不响应"，
 * `nightQuiet` 这一列也一直存在 —— 但从来没有人读过它。这一版把它接上。
 *
 * ## 三个刻意的选择
 *
 * 1. **区间左闭右开**：`[start, end)`。写 `00:30-07:30` 的意思是"00:30 开始别说话，
 *    07:30 可以说话了"，07:30 整必须放行 —— 否则"整点到底算不算"永远说不清。
 * 2. **跨零点靠 `start > end` 表达**，不需要额外字段（`23:00-08:00` 就是跨零点）。
 * 3. **配错了就不静默**：解析失败返回 `null`（等于关闭）。理由是"配错"的后果不对称 ——
 *    静默一整天会让用户以为服务坏了，而不静默只是少了这一层保护。
 *    坏值应该在接口层被 zod 拦掉（`nightQuietSchema`），这里只是最后一层兜底。
 *
 * ## 为什么不用 `cron` 判断"现在是不是夜里"
 *
 * 这是一个**每条消息都要问一次**的问题。纯函数按分钟算，比查库、比定时开关都便宜。
 */

export type QuietWindow = {
  /** 从零点起的分钟数，含 */
  startMin: number;
  /** 从零点起的分钟数，不含 */
  endMin: number;
};

/** `off` / 空 / 非法 → `null`（= 不静默） */
export function parseQuietWindow(text: string | null | undefined): QuietWindow | null {
  if (!text) {
    return null;
  }
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'off' || trimmed === 'none') {
    return null;
  }

  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const [, sh, sm, eh, em] = match;
  const startHour = Number(sh);
  const startMinute = Number(sm);
  const endHour = Number(eh);
  const endMinute = Number(em);
  if (
    startHour > 23 ||
    endHour > 23 ||
    startMinute > 59 ||
    endMinute > 59
  ) {
    return null;
  }

  const window = { startMin: startHour * 60 + startMinute, endMin: endHour * 60 + endMinute };
  // 起止相同 = 空窗口 = 关闭（不要解释成"全天静默"）
  if (window.startMin === window.endMin) {
    return null;
  }
  return window;
}

/**
 * 现在是否落在静默窗口内。
 *
 * `@` 是否放行不在这里判：那是"这条消息有多重要"的问题，属于管道
 * （`governance` 拿到 `message.isMentioned` 再决定）。这里只回答"现在是不是夜里"。
 */
export function isWithinQuiet(now: Date, text: string | null | undefined): boolean {
  const window = parseQuietWindow(text);
  if (!window) {
    return false;
  }
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (window.startMin < window.endMin) {
    return minutes >= window.startMin && minutes < window.endMin;
  }
  // 跨零点：23:00-08:00 → [23:00, 24:00) ∪ [00:00, 08:00)
  return minutes >= window.startMin || minutes < window.endMin;
}
