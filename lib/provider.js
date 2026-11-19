/**
 * logprobs-highlighter — 自注册 provider（DeepSeek Chat Completions + logprobs）
 *
 * 这是路 C 的核心：插件不接管 baseURL、不开反代，而是向 dsh 的 llm 服务
 * `registerAdapter()` 注册一条自己的 provider 路由（`deepseek-logprobs`）。
 * dsh 把完整请求以 `GenerateOptions` 交给我们，我们：
 *   ① 映射成 DeepSeek `/chat/completions` body（注入 logprobs/top_logprobs）
 *   ② 逐 chunk 解析上游 SSE，映射回 dsh 的 `StreamChunk`
 *   ③ 同一条 chunk 里的 logprobs 顺手存进捕获存储 + 落盘
 *
 * 与旧反代方案的差别：
 * - 不再剥皮转发（logprobs 天生不进入 dsh 的流，只进我们的捕获）
 * - sessionId 由 `GenerateOptions.sessionId` 直接给出，不再靠 HTTP 头
 * - `purpose`（compaction / session-title）直接可得，用于跳过关联
 *
 * @module logprobs-highlighter/provider
 */

import { randomUUID } from "node:crypto";
import { createEntry } from "./capture.js";
import { buildRequestBody, toTokenUsage, toFinishReason } from "./wire.js";
import { normalizeToken } from "./shared.js";

/** 本插件向 dsh 注册的 provider 路由名。 */
export const PROVIDER = "deepseek-logprobs";

/** provider 默认显示名。 */
const DISPLAY_NAME = "DeepSeek (logprobs)";

/** 默认模型目录（与 dsh 官方 DeepSeek 适配器的当前模型一致）。 */
const DEFAULT_MODELS = [
  { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", description: "logprobs 采集路由（含图片能力降级为文本）" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", description: "logprobs 采集路由（text only）" },
];

/** 可选的 reasoning effort（DeepSeek Chat Completions 接受 low / high / max）。 */
const REASONING_EFFORTS = [
  { id: "low", name: "Low" },
  { id: "high", name: "High" },
  { id: "max", name: "Max" },
];

/**
 * 解析上游地址：`{base}/chat/completions`。
 * @param {string} baseUrl
 */
function completionsUrl(baseUrl) {
  const base = String(baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  return `${base}/chat/completions`;
}

/** 判断 400/422 是否在抱怨 logprobs（用于降级重试）。 */
function isLogprobsRejection(status, bodyText) {
  if (status !== 400 && status !== 422) return false;
  return /logprobs|top_logprobs|not supported|unsupported|not allowed/i.test(String(bodyText || ""));
}

/**
 * 解析一条 SSE 事件（可能多行 data:）。
 * @param {string} event
 * @returns {object|null}
 */
function parseEvent(event) {
  const lines = event.split("\n");
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return { done: true };
  try {
    return { chunk: JSON.parse(payload) };
  } catch {
    return null;
  }
}

/**
 * 从 session 事件日志读取当前 step。
 *
 * dsh 在每次 LLM 请求**之前** append `step/start`（turn, step），而
 * `assistant/message` 是请求之后才写的。因此 `step/start` 才是本次请求的
 * 权威归属；用 `assistant/message` 做前置关联会慢一拍。
 *
 * @param {object} ctx cordis ctx（需能拿到 sessions 服务）
 * @param {string} sessionId
 * @returns {{turn:number, step:number, at?:number}|null}
 */
function resolveStep(ctx, sessionId) {
  try {
    const sessions = ctx.get?.("sessions");
    const session = sessions?.get?.(sessionId);
    if (!session || typeof session.snapshotEvents !== "function") return null;
    const events = session.snapshotEvents();
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      const d = ev?.data;
      if (ev?.type === "step/start" && d && typeof d.turn === "number" && typeof d.step === "number") {
        return { turn: d.turn, step: d.step, at: ev.time };
      }
    }
  } catch {
    // 关联失败不能影响模型请求本身。
  }
  return null;
}

/**
 * 创建 adapter 实例。
 *
 * dsh 的 LlmAdapter / LlmError / attributionHeaders / credentialRef 以 `platform`
 * 注入（而不是顶层 import），便于在无 dsh 依赖的环境里做单元测试。
 *
 * @param {object} deps
 * @param {object} deps.ctx cordis ctx（用于 credentials / 启动环境）
 * @param {object} deps.config 已解包的插件配置
 * @param {object} deps.capture capture store
 * @param {object} deps.recorder 落盘器
 * @param {object} deps.platform { LlmAdapter, LlmError, attributionHeaders, credentialRef }
 * @param {object} deps.logger
 */
export function createAdapter({ ctx, config, capture, recorder, annotations, logger = console, platform }) {
  const { LlmAdapter, LlmError, attributionHeaders, credentialRef } = platform;
  const models = Array.isArray(config.models) && config.models.length > 0 ? config.models : DEFAULT_MODELS;
  const modelIndex = new Map(models.map((m) => [m.id, m]));

  /** 每次请求解析一次凭证（支持运行期轮换；不落盘、不打印）。 */
  async function resolveApiKey() {
    const refName = config.apiKeyEnv || "DEEPSEEK_API_KEY";
    const ref = credentialRef(refName);
    const credentials = ctx.get?.("credentials");
    if (credentials !== undefined && credentials !== null) {
      const hit = await credentials.resolve(ref);
      if (hit !== undefined && hit !== null && typeof hit.value === "string" && hit.value.length > 0) {
        return hit.value.trim();
      }
    }
    const ambient = process.env[refName];
    if (typeof ambient === "string" && ambient.length > 0) return ambient.trim();
    throw new LlmError(
      `logprobs-highlighter: 找不到 API key（凭证引用 ${refName}）。请在 dsh 的 Models 设置里配置，或在启动环境里导出该变量。`,
      "MISSING_CREDENTIAL",
    );
  }

  /** 发一次请求（带/不带 logprobs）。 */
  async function post(options, injectLogprobs, signal) {
    const apiKey = await resolveApiKey();
    const body = buildRequestBody({
      options,
      topLogprobs: config.topLogprobs,
      thinking: config.thinking !== false,
      injectLogprobs,
    });
    const url = completionsUrl(config.baseUrl);
    const resp = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        ...attributionHeaders(),
        "content-type": "application/json",
        accept: "text/event-stream",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });
    return { resp, body };
  }

  /** 把上游错误体转成 LlmError。 */
  async function toError(resp, url) {
    let text = "";
    try { text = await resp.text(); } catch { /* 读不到就用状态码 */ }
    const code = resp.status === 401 || resp.status === 403
      ? "AUTH"
      : resp.status === 429
        ? "RATE_LIMIT"
        : resp.status >= 500 ? "SERVER" : "PROVIDER";
    const detail = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    return new LlmError(
      `logprobs-highlighter: ${url} 返回 HTTP ${resp.status}${detail ? `：${detail}` : ""}`,
      code,
      { status: resp.status },
    );
  }

  class DeepSeekLogprobsAdapter extends LlmAdapter {
    providerInfo(provider) {
      return { id: provider, name: DISPLAY_NAME };
    }

    async listModels(provider) {
      return models.map((m) => ({
        provider,
        id: m.id,
        name: m.name || m.id,
        description: m.description,
        inputModalities: ["text"],
      }));
    }

    async resolveModel(provider, model) {
      const catalog = modelIndex.get(model);
      return {
        provider,
        id: model,
        name: catalog?.name ?? model,
        description: catalog?.description,
        inputModalities: ["text"],
        context: { contextWindow: config.defaultContextWindow },
        defaultMaxTokens: config.maxTokens,
        reasoning: {
          efforts: REASONING_EFFORTS,
          defaultEffort: config.reasoningEffort,
        },
      };
    }

    async *stream(options) {
      const model = options.model;
      const entry = createEntry({
        id: `req-${randomUUID()}`,
        sessionId: options.sessionId !== undefined && options.sessionId !== null ? String(options.sessionId) : null,
        provider: options.provider,
        model,
        purpose: options.purpose ?? null,
      });
      const startedAt = Date.now();
      entry.sampling = {
        temperature: typeof options.temperature === "number" ? options.temperature : null,
        topP: typeof options.topP === "number" ? options.topP : null,
        thinking: config.thinking !== false,
        reasoningEffort: typeof options.reasoningEffort === "string"
          ? options.reasoningEffort
          : (config.reasoningEffort ?? null),
      };
      // 请求前 dsh 已写入 step/start，直接拿到本次请求的 (turn, step)。
      if (entry.sessionId && !entry.purpose) {
        const meta = resolveStep(ctx, entry.sessionId);
        if (meta) capture.bind(entry, meta);
      }
      const blockByRole = {
        text: entry.blocks[0],
        reasoning: entry.blocks[1],
        "tool-call": entry.blocks[2],
      };

      // —— dsh 流块状态 ——
      const opened = []; // [{ index, kind, text, id, name, args }]
      const openByIndex = new Map();
      const toolIndexByUpstream = new Map(); // 上游 tool_calls[].index → dsh index
      let nextIndex = 0;
      let activeText = null;
      let activeReasoning = null;
      let pendingUsage = null;
      let finishReason = null;
      let sawReasoning = false;
      let sawFinish = false;
      let complete = false;

      const toBlock = (st) => {
        if (st.kind === "text") return { type: "text", text: st.text };
        if (st.kind === "reasoning") return { type: "reasoning", text: st.text };
        return { type: "tool-call", id: st.id, name: st.name, arguments: st.args || "{}" };
      };

      try {
        const url = completionsUrl(config.baseUrl);
        let { resp } = await post(options, true, options.signal);

        // 400/422 且上游抱怨 logprobs → 去掉注入重试一次（并记模型黑名单）
        if (!resp.ok && (resp.status === 400 || resp.status === 422)) {
          let errText = "";
          try { errText = await resp.clone().text(); } catch { /* ignore */ }
          if (isLogprobsRejection(resp.status, errText)) {
            logger.warn?.(`provider: ${model} 拒绝 logprobs（HTTP ${resp.status}），去掉注入重试一次`);
            const retry = await post(options, false, options.signal);
            resp = retry.resp;
            if (resp.ok) {
              capture.markUnsupported(model);
              logger.warn?.(`provider: ${model} 重试成功 → 记入模型黑名单（本次仍会映射流，但无 logprobs）`);
            }
          }
        }

        if (!resp.ok) throw await toError(resp, url);
        if (!resp.body) throw new LlmError("logprobs-highlighter: 上游返回空响应体", "EMPTY_RESPONSE");

        const decoder = new TextDecoder();
        let buffer = "";

        for await (const bytes of resp.body) {
          buffer += decoder.decode(bytes, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");
          let cut;
          while ((cut = buffer.indexOf("\n\n")) !== -1) {
            const event = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const parsed = parseEvent(event);
            if (parsed === null) continue;
            if (parsed.done) continue;
            const chunk = parsed.chunk;
            entry.chunks = (entry.chunks ?? 0) + 1;

            // usage（缓存到收尾统一 yield，保证在 finish 之前）
            if (chunk.usage) {
              pendingUsage = toTokenUsage(chunk.usage);
              entry.usage = pendingUsage;
            }

            const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
            if (!choice) continue;
            const delta = choice.delta ?? {};

            // —— reasoning ——
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
              sawReasoning = true;
              if (activeReasoning === null) {
                activeReasoning = nextIndex++;
                const st = { index: activeReasoning, kind: "reasoning", text: "" };
                openByIndex.set(activeReasoning, st);
                opened.push(st);
                yield { type: "block-start", index: activeReasoning, blockType: "reasoning" };
              }
              openByIndex.get(activeReasoning).text += delta.reasoning_content;
              blockByRole.reasoning.text += delta.reasoning_content;
              yield { type: "reasoning-delta", index: activeReasoning, text: delta.reasoning_content };
            }

            // —— text ——
            if (typeof delta.content === "string" && delta.content.length > 0) {
              if (activeText === null) {
                activeText = nextIndex++;
                const st = { index: activeText, kind: "text", text: "" };
                openByIndex.set(activeText, st);
                opened.push(st);
                yield { type: "block-start", index: activeText, blockType: "text" };
              }
              openByIndex.get(activeText).text += delta.content;
              blockByRole.text.text += delta.content;
              yield { type: "text-delta", index: activeText, text: delta.content };
            }

            // —— tool calls ——
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const upstreamIndex = typeof tc?.index === "number" ? tc.index : 0;
                let idx = toolIndexByUpstream.get(upstreamIndex);
                if (idx === undefined) {
                  idx = nextIndex++;
                  toolIndexByUpstream.set(upstreamIndex, idx);
                  const st = {
                    index: idx,
                    kind: "tool-call",
                    id: typeof tc?.id === "string" && tc.id ? tc.id : `call_${upstreamIndex}`,
                    name: "",
                    args: "",
                  };
                  openByIndex.set(idx, st);
                  opened.push(st);
                  yield { type: "block-start", index: idx, blockType: "tool-call" };
                }
                const st = openByIndex.get(idx);
                if (typeof tc?.id === "string" && tc.id) st.id = tc.id;
                if (typeof tc?.function?.name === "string" && tc.function.name) st.name = tc.function.name;
                const argsDelta = typeof tc?.function?.arguments === "string" ? tc.function.arguments : "";
                if (argsDelta) st.args += argsDelta;
                yield {
                  type: "tool-call-delta",
                  index: idx,
                  id: st.id,
                  name: st.name || undefined,
                  argumentsDelta: argsDelta,
                };
              }
            }

            // —— logprobs 采集（双字段：content / reasoning_content）——
            const lp = choice.logprobs;
            if (lp && Array.isArray(lp.content)) {
              for (const t of lp.content) blockByRole.text.tokens.push(normalizeToken(t));
            }
            if (lp && Array.isArray(lp.reasoning_content)) {
              sawReasoning = true;
              for (const t of lp.reasoning_content) blockByRole.reasoning.tokens.push(normalizeToken(t));
            }

            if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
              finishReason = choice.finish_reason;
              sawFinish = true;
            }
          }
        }

        // —— 收尾：关闭所有块 → usage → finish ——
        for (const st of opened) {
          yield { type: "block-end", index: st.index, block: toBlock(st) };
        }
        if (pendingUsage) yield { type: "usage", usage: pendingUsage };
        yield { type: "finish", reason: toFinishReason(finishReason) };
        complete = sawFinish || pendingUsage !== null;
      } catch (err) {
        if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) {
          // 交给 LlmRuntime 规范化为 aborted finish；这里只负责落盘。
          throw err;
        }
        if (err instanceof LlmError) throw err;
        throw new LlmError(`logprobs-highlighter: 流处理失败（${err?.message ?? err}）`, "TRANSPORT", { cause: err });
      } finally {
        entry.durationMs = Date.now() - startedAt;
        entry.complete = complete;
        entry.reasoningState = blockByRole.reasoning.tokens.length > 0
          ? "present"
          : sawReasoning ? "unknown" : "absent";
        capture.store(entry);
        recorder.record(entry);
        try {
          annotations?.ingest(entry);
        } catch (err) {
          logger.warn?.(`provider: annotation 生成失败（不影响流）：${err?.message ?? err}`);
        }
        logger.debug?.(
          `provider: ${model} turn=${entry.assoc ? entry.assoc.turn : "?"} ` +
          `text=${blockByRole.text.tokens.length}tok reasoning=${blockByRole.reasoning.tokens.length}tok ` +
          `complete=${entry.complete} ${entry.durationMs}ms`,
        );
      }
    }
  }

  return new DeepSeekLogprobsAdapter();
}