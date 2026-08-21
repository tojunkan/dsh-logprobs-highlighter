/**
 * logprobs-highlighter — 客户端 tokens 数据核心（无 react 依赖，可 Node 单测）
 *
 * 共享缓存（IMP-3/t15）：
 * - in-flight Promise 去重：并发同键只发一次请求（第二个调用复用同一个 Promise）；
 * - 结果短缓存（RESULT_TTL 10s）：仅终态写缓存——captured:true，或
 *   非 assoc-pending 的 captured:false；assoc-pending 不缓存（与重试语义兼容）；
 * - 失败不缓存（inflight 清理后允许重试）；
 * - 组件卸载不取消共享 Promise（useTokens 只取消自己的订阅/状态）。
 *
 * @module logprobs-highlighter/client/tokens-core
 */

export const RETRY_DELAYS = [500, 1000, 2000];
export const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;
export const RESULT_TTL = 10_000;

/** 共享缓存：key = `${sessionId}|${turn}|${step}`。 */
const inflight = new Map(); // key -> Promise<{status, body}>
const results = new Map(); // key -> { body, at }

/** 测试用：清空共享缓存。 */
export function resetTokenCache() {
  inflight.clear();
  results.clear();
}

function cacheKey(sessionId, turn, step) {
  return `${sessionId}|${turn}|${step}`;
}

/**
 * 共享缓存 fetch：同键并发只发一次（复用 in-flight Promise）；
 * 终态结果缓存 10s；assoc-pending / 失败不缓存。
 * @returns {Promise<{status: number, body: any}>}
 */
export async function fetchTokenData(sessionId, turn, step) {
  const key = cacheKey(sessionId, turn, step);
  const hit = results.get(key);
  if (hit && Date.now() - hit.at < RESULT_TTL) return hit.body;
  const pending = inflight.get(key);
  if (pending) return pending;
  const url =
    `/plugins/logprobs-highlighter/tokens?session=${encodeURIComponent(sessionId)}` +
    `&turn=${encodeURIComponent(turn)}&step=${encodeURIComponent(step)}`;
  const promise = (async () => {
    const res = await fetch(url, { cache: "no-store" });
    const body = await res.json();
    return { status: res.status, body };
  })();
  inflight.set(key, promise);
  try {
    const out = await promise;
    const b = out.body;
    // 终态才写结果缓存（与 assoc-pending 重试语义兼容）
    if (out.status >= 200 && out.status < 300 && b && b.ok === true && b.captured === true) {
      results.set(key, { body: out, at: Date.now() });
    } else if (out.status >= 200 && out.status < 300 && b && b.ok === true && b.notCapturedReason !== "assoc-pending") {
      results.set(key, { body: out, at: Date.now() });
    }
    return out;
  } finally {
    inflight.delete(key);
  }
}
