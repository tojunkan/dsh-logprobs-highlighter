/**
 * logprobs-highlighter — 共享逻辑（server 各模块与自测共用）
 *
 * 与 scripts/m0-probe.mjs 保持一致：
 * - classifySegment：角色分类三规则（README §3.3 / architecture-v4 §0.4.2）
 * - 双字段 logprobs 解析（logprobs.content + logprobs.reasoning_content，M0 实测硬要求）
 * - 剥皮：删除 choices[i].logprobs（两字段一并剥掉）后重序列化
 * - 400/422 降级判定（t1 §5.2 / README §5.1）
 * - 模型目录匹配（modelGlob，默认 deepseek-*，兼容 deepseek-v4-* 与旧别名）
 *
 * @module logprobs-highlighter/shared
 */

/** 插件版本（与 package.json version 保持同步；/status 用）。 */
export const PLUGIN_VERSION = "0.1.0";

/**
 * 角色分类三规则（与 m0-probe.mjs classifySegment 完全一致，M1 必须照此实现）：
 * ① 非空 content 优先（content 与 reasoning 同 chunk 时按 text 算）；
 * ② reasoning_content 键存在但为 null 不算 reasoning（思考模式 content chunk 的
 *    delta 形如 {"content":"202","reasoning_content":null}，按"键存在即 reasoning"
 *    会把 24 个 content chunk 吞进 reasoning 段——t4 已修复的 bug，不得复现）；
 * ③ 空内容角色宣告/过渡块按键存在性兜底（thinking 首 chunk 宣告 reasoning、
 *    no-thinking 宣告 content）。
 *
 * @param {object} delta chunk 的 choices[0].delta
 * @returns {"text"|"reasoning"|"tool-call"|"other"}
 */
export function classifySegment(delta) {
  const hasContentStr = typeof delta.content === "string" && delta.content.length > 0;
  const hasReasoningStr = typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0;
  if (Array.isArray(delta.tool_calls)) return "tool-call";
  if (hasContentStr) return "text";
  if (hasReasoningStr) return "reasoning";
  if (delta.reasoning_content !== undefined) return "reasoning";
  if (delta.content !== undefined) return "text";
  return "other";
}

/**
 * 归一化单个 logprobs 条目 → 捕获存储最小字段 {text, logprob, top[]}。
 * bytes 仅在捕获期做 token↔文本对齐校验用，默认不落捕获存储（arch §3.3）。
 * @param {{token?:string, logprob?:number, top_logprobs?:Array}} t
 */
export function normalizeToken(t) {
  return {
    text: typeof t?.token === "string" ? t.token : String(t?.token ?? ""),
    logprob: typeof t?.logprob === "number" ? t.logprob : null,
    top: Array.isArray(t?.top_logprobs)
      ? t.top_logprobs
          .filter((x) => x && typeof x.token === "string")
          .map((x) => ({ token: x.token, logprob: typeof x.logprob === "number" ? x.logprob : null }))
      : [],
  };
}

/**
 * 剥皮：删除每个 choice 的 logprobs 字段（content 与 reasoning_content 一并剥掉），
 * 其余字段原样保留；返回可重序列化的对象（不修改入参的兄弟引用，安全）。
 * @param {object} parsed JSON.parse 后的 chunk
 */
export function stripLogprobs(parsed) {
  if (parsed && Array.isArray(parsed.choices)) {
    for (const choice of parsed.choices) {
      if (choice && choice.logprobs !== undefined) delete choice.logprobs;
    }
  }
  return parsed;
}

/**
 * 400/422 且错误体含 logprobs 相关关键字 → 判为该模型/模式不支持 logprobs。
 * 关键字白名单：logprobs / top_logprobs / not supported / unsupported / not allowed。
 * @param {number} status
 * @param {string} bodyText 上游错误响应体原文
 */
export function isLogprobsRejection(status, bodyText) {
  if (status !== 400 && status !== 422) return false;
  const lower = String(bodyText || "").toLowerCase();
  return /logprobs|top_logprobs|not supported|unsupported|not allowed/.test(lower);
}

/**
 * 模型目录匹配：把 modelGlob（如 "deepseek-*"）转成正则做全匹配。
 * 默认目录兼容 deepseek-v4-* 与旧别名（deepseek-chat / deepseek-reasoner 也以
 * deepseek-* 命中，命中后由上游/降级兜底处理）。
 * @param {string} model
 * @param {string} glob
 */
export function matchesModelGlob(model, glob) {
  if (typeof model !== "string" || !model) return false;
  const g = typeof glob === "string" && glob ? glob : "deepseek-*";
  const escaped = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(model);
}

/** usage 归一化（OpenAI 兼容 → 捕获存储结构 {inputTokens, outputTokens, reasoningTokens}）。 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const reasoning =
    usage.completion_tokens_details && typeof usage.completion_tokens_details.reasoning_tokens === "number"
      ? usage.completion_tokens_details.reasoning_tokens
      : typeof usage.reasoning_tokens === "number"
        ? usage.reasoning_tokens
        : null;
  return {
    inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
    outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
    reasoningTokens: reasoning,
  };
}
