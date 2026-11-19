/**
 * logprobs-highlighter — webServer 路由（数据接口 + 调试）
 *
 * 注册方式照抄 dsh 官方第三方插件先例：
 *   webServer = ctx.get("webServer") ?? ctx.get("httpServer")
 *   ctx.effect(() => webServer.register({ kind: "exact", path, handler }))
 *   晚绑定：ctx.on("internal/service", …)（headless profile 无 webServer 仍可运行）
 *
 * 端点：
 * - GET /plugins/logprobs-highlighter/status     健康与配置
 * - GET /plugins/logprobs-highlighter/tokens     按 (sessionId, turn, step) 取捕获
 * - GET /plugins/logprobs-highlighter/debug      采集统计 + 最近条目摘要
 * - GET /plugins/logprobs-highlighter/captures   最近条目原始数据（截断保护）
 *
 * @module logprobs-highlighter/routes
 */

import { PLUGIN_VERSION } from "./shared.js";
import { summarize } from "./recorder.js";
import { buildSentences } from "./sentences.js";

const WEB_SERVER_KEYS = ["webServer", "httpServer"];
const BASE = "/plugins/logprobs-highlighter";

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

/** 捕获条目 → /tokens 响应（形状与未来前端约定一致）。 */
function entryToResponse(entry, key, config = {}) {
  const blocks = entry.blocks.map((b) => ({
    role: b.role,
    text: b.text ?? "",
    tokens: b.tokens.map((t, i) => ({
      index: typeof t.index === "number" ? t.index : i,
      text: t.text,
      logprob: t.logprob,
      confidence: typeof t.logprob === "number" ? Number(Math.exp(Math.min(0, t.logprob)).toFixed(6)) : null,
      top: t.top,
      flags: { mutation: false, lowConfidence: false, category: "none" }, // 标记引擎留给前端阶段
    })),
  }));

  // 句子级派生：前端只消费区间与等级，不需要 token→DOM 映射。
  const textBlock = entry.blocks.find((b) => b.role === "text");
  const derived = textBlock && textBlock.tokens.length > 0
    ? buildSentences(textBlock, { redThreshold: config.redThreshold })
    : { sentences: [], codeRanges: [] };

  return {
    ok: true,
    key,
    captured: true,
    notCapturedReason: null,
    message: {
      id: entry.assoc?.messageId ?? null,
      model: entry.model,
      provider: entry.provider,
    },
    reasoningState: entry.reasoningState,
    usage: entry.usage,
    stats: { durationMs: entry.durationMs, chunks: entry.chunks, complete: entry.complete },
    blocks,
    sentences: derived.sentences,
    codeRanges: derived.codeRanges,
    marks: [],
  };
}

export function registerRoutes(ctx, deps, logger = console) {
  const { capture, recorder, config, provider } = deps;
  let registered = false;

  const register = () => {
    if (registered) return;
    const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
    if (webServer === undefined) return;
    registered = true;

    // —— /status ——
    ctx.effect(() => webServer.register({
      kind: "exact",
      path: `${BASE}/status`,
      handler: (req, res) => {
        try {
          return sendJson(res, 200, {
            ok: true,
            version: PLUGIN_VERSION,
            provider,
            baseUrl: config.baseUrl,
            models: config.models.map((m) => ({ id: m.id, name: m.name })),
            topLogprobs: config.topLogprobs,
            thinking: config.thinking,
            reasoningEffort: config.reasoningEffort,
            capture: capture.stats(),
            recorder: recorder.stats(),
            // 诊断：关联链路是否可用（sessions 服务可见性 + 最近一条的 assoc）
            diagnostics: {
              sessionsService: typeof ctx.get("sessions"),
              webServer: typeof ctx.get("webServer"),
              lastAssoc: (() => {
                const last = capture.list(1)[0];
                return last ? last.assoc ?? null : null;
              })(),
            },
          });
        } catch (err) {
          logger.warn?.(`routes: /status 异常（${err.message}）`);
          return sendJson(res, 500, { ok: false, error: "internal" });
        }
      },
    }), "logprobs-highlighter: status route");

    // —— /tokens ——
    ctx.effect(() => webServer.register({
      kind: "exact",
      path: `${BASE}/tokens`,
      handler: (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://x");
          const session = url.searchParams.get("session") ?? "";
          const turnRaw = url.searchParams.get("turn");
          const stepRaw = url.searchParams.get("step");
          const turn = turnRaw === null ? null : Number(turnRaw);
          const step = stepRaw === null ? null : Number(stepRaw);
          if (!session) return sendJson(res, 400, { ok: false, error: "missing-param", param: "session" });
          if (turn === null || !Number.isInteger(turn)) return sendJson(res, 400, { ok: false, error: "missing-param", param: "turn" });
          if (step !== null && !Number.isInteger(step)) return sendJson(res, 400, { ok: false, error: "missing-param", param: "step" });

          // step 可选：前端只知道 turn，缺省取该 turn 最后一个有正文的 step。
          const entry = step === null
            ? capture.latestByTurn(session, turn)
            : capture.query(session, turn, step);
          const key = { sessionId: session, turn, step: entry?.assoc?.step ?? step };
          if (entry) return sendJson(res, 200, entryToResponse(entry, key, config));

          const pending = capture.pendingCount(session);
          return sendJson(res, 200, {
            ok: true,
            key,
            captured: false,
            notCapturedReason: pending > 0 ? "assoc-pending" : "not-found",
            message: null,
            reasoningState: null,
            usage: null,
            stats: null,
            blocks: [],
            sentences: [],
            codeRanges: [],
            marks: [],
          });
        } catch (err) {
          logger.warn?.(`routes: /tokens 异常（${err.message}）`);
          return sendJson(res, 500, { ok: false, error: "internal" });
        }
      },
    }), "logprobs-highlighter: tokens route");

    // —— /debug ——
    ctx.effect(() => webServer.register({
      kind: "exact",
      path: `${BASE}/debug`,
      handler: (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://x");
          const limit = Number(url.searchParams.get("limit") ?? 10);
          const recent = capture.list(Number.isFinite(limit) ? limit : 10).map((e) => {
            try { return summarize(e); } catch { return { id: e.id, error: "summarize-failed" }; }
          });
          return sendJson(res, 200, {
            ok: true,
            version: PLUGIN_VERSION,
            provider,
            capture: capture.stats(),
            recorder: recorder.stats(),
            recent,
          });
        } catch (err) {
          logger.warn?.(`routes: /debug 异常（${err.message}）`);
          return sendJson(res, 500, { ok: false, error: "internal" });
        }
      },
    }), "logprobs-highlighter: debug route");

    // —— /captures ——
    ctx.effect(() => webServer.register({
      kind: "exact",
      path: `${BASE}/captures`,
      handler: (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://x");
          const limit = Number(url.searchParams.get("limit") ?? 5);
          const entries = capture.list(Number.isFinite(limit) ? limit : 5);
          const text = JSON.stringify({ ok: true, entries });
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "content-length": Buffer.byteLength(text),
          });
          res.end(text);
        } catch (err) {
          logger.warn?.(`routes: /captures 异常（${err.message}）`);
          return sendJson(res, 500, { ok: false, error: "internal" });
        }
      },
    }), "logprobs-highlighter: captures route");

    logger.info?.(`routes: ${BASE}/status|tokens|debug|captures 已注册`);
  };

  register();
  ctx.on("internal/service", (serviceName) => {
    if (WEB_SERVER_KEYS.includes(serviceName)) register();
  });
}