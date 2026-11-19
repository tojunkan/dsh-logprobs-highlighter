/**
 * logprobs-highlighter — dsh 消息模型 → DeepSeek Chat Completions 请求体
 *
 * 输入是 dsh `GenerateOptions`（provider 中立词汇，见 @deepseek-ai/dsh-llm
 * `types.d.ts`：GenerateOptions / RequestMessage / ContentBlock），输出是
 * DeepSeek `/chat/completions` 的 JSON body（OpenAI 兼容 + logprobs 扩展）。
 *
 * 映射约定（只覆盖本插件声明支持的 text 路由）：
 * - system / user / assistant / tool 四类消息原样映射；developer 消息只承载
 *   tool-addition / tool-removal（OpenAI 无对应概念）→ 跳过，工具声明由
 *   `options.tools` 全量下发。
 * - assistant 的 reasoning 块 → `reasoning_content`（DeepSeek 扩展；多轮思考
 *   模式必须回传，否则上游 400）。
 * - assistant 的 tool-call 块 → `tool_calls[]`（arguments 保持原始 JSON 字符串）。
 * - 图片 / 文件块：本插件不接管附件服务，统一降级为文本占位（inputModalities
 *   声明为 text-only，dsh 侧不会把图片路由到这条 provider）。
 *
 * @module logprobs-highlighter/wire
 */

/** 拼接一组 text 块。 */
function joinText(blocks) {
  let out = "";
  for (const b of blocks) {
    if (b && b.type === "text" && typeof b.text === "string") out += b.text;
  }
  return out;
}

/** 拼接一组 reasoning 块。 */
function joinReasoning(blocks) {
  let out = "";
  for (const b of blocks) {
    if (b && b.type === "reasoning" && typeof b.text === "string") out += b.text;
  }
  return out;
}

/** 收集 tool-call 块 → OpenAI tool_calls。 */
function toToolCalls(blocks) {
  const calls = [];
  for (const b of blocks) {
    if (!b || b.type !== "tool-call") continue;
    calls.push({
      id: String(b.id ?? ""),
      type: "function",
      function: {
        name: String(b.name ?? ""),
        arguments: typeof b.arguments === "string" ? b.arguments : "{}",
      },
    });
  }
  return calls;
}

/**
 * 一条 dsh 消息 → 零到多条 OpenAI 消息。
 * @param {object} message RequestMessage（role + content[]）
 * @returns {object[]}
 */
function mapMessage(message) {
  if (!message || typeof message !== "object") return [];
  const content = Array.isArray(message.content) ? message.content : [];
  switch (message.role) {
    case "system": {
      const text = joinText(content);
      return text ? [{ role: "system", content: text }] : [];
    }
    case "developer":
      // tool-addition / tool-removal 在 Chat Completions 无对应表达；工具声明
      // 由 body.tools 全量下发，这里跳过不会丢工具。
      return [];
    case "user": {
      const text = joinText(content);
      const hasAttachment = content.some((b) => b && (b.type === "image" || b.type === "file"));
      const parts = [];
      if (text) parts.push(text);
      if (hasAttachment) parts.push("[附件：图片或文件已省略]");
      return parts.length ? [{ role: "user", content: parts.join("\n") }] : [];
    }
    case "assistant": {
      const text = joinText(content);
      const reasoning = joinReasoning(content);
      const toolCalls = toToolCalls(content);
      const out = { role: "assistant", content: text };
      if (reasoning) out.reasoning_content = reasoning;
      if (toolCalls.length) out.tool_calls = toolCalls;
      // 空 assistant 消息（无文本无工具）会让部分上游拒绝，跳过。
      if (!text && !reasoning && toolCalls.length === 0) return [];
      return [out];
    }
    case "tool": {
      return [{
        role: "tool",
        tool_call_id: String(message.toolCallId ?? ""),
        content: joinText(content),
      }];
    }
    default:
      return [];
  }
}

/**
 * dsh 消息数组 → OpenAI messages 数组。
 * @param {object[]} messages
 */
export function toOpenAIMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) out.push(...mapMessage(m));
  return out;
}

/** tools → OpenAI function 声明。 */
function toOpenAITools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const mapped = [];
  for (const t of tools) {
    if (!t || typeof t.name !== "string" || !t.name) continue;
    mapped.push({
      type: "function",
      function: {
        name: t.name,
        description: typeof t.description === "string" ? t.description : "",
        parameters: t.parameters && typeof t.parameters === "object" ? t.parameters : { type: "object", properties: {} },
      },
    });
  }
  return mapped.length ? mapped : undefined;
}

/**
 * 构造 `/chat/completions` 请求体。
 *
 * @param {object} input
 * @param {object} input.options GenerateOptions
 * @param {number} input.topLogprobs top_logprobs（0 / 2 / 5 / 20）
 * @param {boolean} [input.thinking] 是否显式开启思考模式
 * @param {boolean} [input.injectLogprobs] false = 降级重试（去掉 logprobs）
 * @returns {object}
 */
export function buildRequestBody({ options, topLogprobs = 2, thinking = false, injectLogprobs = true }) {
  const messages = toOpenAIMessages(options.messages);
  if (typeof options.system === "string" && options.system.length > 0) {
    messages.unshift({ role: "system", content: options.system });
  }

  const body = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (typeof options.temperature === "number") body.temperature = options.temperature;
  if (typeof options.maxTokens === "number") body.max_tokens = options.maxTokens;
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop;

  const tools = toOpenAITools(options.tools);
  if (tools) body.tools = tools;

  // 思考模式：DeepSeek Chat Completions 用 thinking.type=enabled；
  // reasoning_effort 由 dsh 的模型能力声明透传（low / high / max）。
  if (thinking) body.thinking = { type: "enabled" };
  if (typeof options.reasoningEffort === "string" && options.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort;
  }

  if (injectLogprobs) {
    body.logprobs = true;
    body.top_logprobs = topLogprobs;
  }

  return body;
}

/**
 * DeepSeek usage → dsh TokenUsage（计数字段互斥：inputTokens 是非缓存输入）。
 * @param {object} usage
 * @returns {{inputTokens:number, outputTokens:number, totalTokens?:number, cacheReadTokens?:number, reasoningTokens?:number}}
 */
export function toTokenUsage(usage) {
  const prompt = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const cached = typeof usage?.prompt_cache_hit_tokens === "number" ? usage.prompt_cache_hit_tokens : undefined;
  const miss = typeof usage?.prompt_cache_miss_tokens === "number" ? usage.prompt_cache_miss_tokens : undefined;
  const completion = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0;
  const reasoning = typeof usage?.completion_tokens_details?.reasoning_tokens === "number"
    ? usage.completion_tokens_details.reasoning_tokens
    : typeof usage?.reasoning_tokens === "number" ? usage.reasoning_tokens : undefined;

  const out = {
    inputTokens: miss !== undefined ? miss : Math.max(0, prompt - (cached ?? 0)),
    outputTokens: completion,
  };
  if (prompt + completion > 0) out.totalTokens = prompt + completion;
  if (cached !== undefined) out.cacheReadTokens = cached;
  if (reasoning !== undefined) out.reasoningTokens = reasoning;
  return out;
}

/** DeepSeek finish_reason → dsh FinishReason。 */
export function toFinishReason(reason) {
  switch (reason) {
    case "tool_calls":
      return { kind: "tool-calls" };
    case "length":
      return { kind: "max-tokens" };
    default:
      return { kind: "stop" };
  }
}