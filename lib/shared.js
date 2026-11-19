/**
 * logprobs-highlighter — 共享常量与小工具
 *
 * provider 模式下不再有 SSE 剥皮、角色分类、模型 glob 匹配等反代逻辑，
 * 只保留两个跨模块复用项：版本号与 logprobs 条目归一化。
 *
 * @module logprobs-highlighter/shared
 */

/** 插件版本（与 package.json version 保持同步；/status 用）。 */
export const PLUGIN_VERSION = "0.2.0";

/**
 * 归一化单个 logprobs 条目 → { text, logprob, top[] }。
 * 保留上游 top_logprobs 的原始顺序（top[0] 即 Top-1）。
 * @param {{token?:string, logprob?:number, top_logprobs?:Array}} t
 */
export function normalizeToken(t) {
  return {
    text: typeof t?.token === "string" ? t.token : String(t?.token ?? ""),
    logprob: typeof t?.logprob === "number" ? t.logprob : null,
    // DeepSeek 对半个 UTF-8 字的 token.text 是转义串；bytes 才是权威值。
    bytes: Array.isArray(t?.bytes) ? t.bytes.slice() : null,
    top: Array.isArray(t?.top_logprobs)
      ? t.top_logprobs
        .filter((x) => x && typeof x.token === "string")
        .map((x) => ({
          token: x.token,
          logprob: typeof x.logprob === "number" ? x.logprob : null,
          bytes: Array.isArray(x.bytes) ? x.bytes.slice() : null,
        }))
      : [],
  };
}