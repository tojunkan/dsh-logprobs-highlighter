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
 * - POST /plugins/logprobs-highlighter/feedback  人工 verdict（append-only）
 * - GET /plugins/logprobs-highlighter/debug      采集统计 + 最近条目摘要
 * - GET /plugins/logprobs-highlighter/captures   最近条目原始数据（截断保护）
 *
 * @module logprobs-highlighter/routes
 */

import { PLUGIN_VERSION } from "./shared.js";
import { summarize } from "./recorder.js";
import { buildSentences, SENTENCES_ALGO_VERSION } from "./sentences.js";

const WEB_SERVER_KEYS = ["webServer", "httpServer"];
const BASE = "/plugins/logprobs-highlighter";
const MAX_FEEDBACK_BODY = 64 * 1024;

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function readJson(req, limit = MAX_FEEDBACK_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        reject(new Error("body-too-large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.trim() ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function markToSentence(mark) {
  const sentenceStart = mark.sentence?.start ?? 0;
  const sentenceEnd = mark.sentence?.end ?? 0;
  const tokens = Array.isArray(mark.tokens) ? mark.tokens : [];
  const rawText = tokens
    .filter((t) => t.start >= sentenceStart && t.end <= sentenceEnd)
    .map((t) => t.text)
    .join("");
  const sourceText = rawText || mark.sentence?.text || mark.sentence?.plain || "";
  const leading = sourceText.match(/^\s*/)?.[0].length ?? 0;
  const displayText = sourceText.slice(leading).replace(/\s+$/, "");
  const displayStart = sentenceStart + leading;
  const displayEnd = displayStart + displayText.length;

  const triggers = (Array.isArray(mark.triggers) ? mark.triggers : [])
    .map((trigger) => {
      let absStart = Number.isInteger(trigger.start) ? trigger.start : null;
      let absEnd = Number.isInteger(trigger.end) ? trigger.end : null;
      if (absStart === null || absEnd === null) {
        let best = null;
        for (const token of tokens) {
          if (token.text !== trigger.token) continue;
          const conf = typeof token.logprob === "number" ? Math.exp(token.logprob) : null;
          const distance = conf === null ? Infinity : Math.abs(conf - (Number(trigger.confidence) || 0));
          if (!best || distance < best.distance) best = { token, distance };
        }
        if (best) {
          absStart = best.token.start;
          absEnd = best.token.end;
        }
      }
      if (absStart === null || absEnd === null) return null;
      const start = absStart - displayStart;
      const end = absEnd - displayStart;
      if (start < 0 || end > displayText.length || end <= start) return null;
      return { ...trigger, start, end };
    })
    .filter(Boolean);

  return {
    markId: mark.markId,
    sentenceKey: mark.sentenceKey,
    blockIndex: mark.blockIndex,
    occurrence: mark.occurrence,
    start: mark.sentence?.start ?? null,
    end: mark.sentence?.end ?? null,
    level: mark.level ?? "red",
    score: mark.score ?? null,
    plain: mark.sentence?.plain ?? "",
    text: displayText,
    triggers,
    reason: mark.worst ?? null,
    verdict: mark.verdict ?? "unsure",
    error_type: mark.error_type ?? null,
    ambiguity_kind: mark.ambiguity_kind ?? null,
    misjudge_reason: mark.misjudge_reason ?? null,
    focus: mark.focus ?? null,
    triggerIndex: Number.isInteger(mark.triggerIndex) ? mark.triggerIndex : null,
  };
}

/** 捕获条目 → /tokens 响应（形状与前端约定一致）。 */
function entryToResponse(entry, key, config = {}, annotations = null) {
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

  // 优先使用流结束后生成的 annotation；老 capture/annotation 关闭时退回现算。
  const marks = annotations?.forCapture?.(entry.id) ?? null;
  let derived;
  if (marks && marks.length > 0) {
    derived = { sentences: marks.map(markToSentence), codeRanges: [] };
  } else {
    const textBlock = entry.blocks.find((b) => b.role === "text");
    derived = textBlock && textBlock.tokens.length > 0
      ? buildSentences(textBlock, { redThreshold: config.redThreshold })
      : { sentences: [], codeRanges: [] };
    derived = {
      ...derived,
      sentences: derived.sentences.map((s) => ({
        ...s,
        markId: null,
        sentenceKey: null,
        blockIndex: null,
        occurrence: null,
        verdict: null,
        error_type: null,
        ambiguity_kind: null,
        misjudge_reason: null,
        focus: null,
        triggerIndex: null,
      })),
    };
  }

  return {
    ok: true,
    key,
    captureId: entry.id,
    captured: true,
    notCapturedReason: null,
    annotation: {
      enabled: config.annotationEnabled !== false,
      algoVersion: SENTENCES_ALGO_VERSION,
    },
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
  const { capture, recorder, config, provider, annotations } = deps;
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
            annotation: annotations?.stats?.() ?? null,
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
          if (entry) return sendJson(res, 200, entryToResponse(entry, key, config, annotations));

          // 重启后内存 capture 为空：从已持久化的 annotation 直接恢复红句。
          const marks = annotations?.forSessionTurn?.(session, turn) ?? null;
          if (marks && marks.length > 0) {
            const first = marks[0];
            return sendJson(res, 200, {
              ok: true,
              key: { ...key, step: Number.isInteger(first.step) ? first.step : key.step },
              captureId: first.captureId,
              captured: true,
              notCapturedReason: null,
              annotation: {
                enabled: config.annotationEnabled !== false,
                algoVersion: SENTENCES_ALGO_VERSION,
              },
              message: {
                id: first.messageId ?? null,
                model: first.model ?? null,
                provider: first.provider ?? null,
              },
              reasoningState: null,
              usage: null,
              stats: { durationMs: null, chunks: null, complete: true },
              blocks: [],
              sentences: marks.map(markToSentence),
              codeRanges: [],
              marks: [],
            });
          }

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

    // —— /feedback ——
    ctx.effect(() => webServer.register({
      kind: "exact",
      path: `${BASE}/feedback`,
      handler: async (req, res) => {
        if (req.method !== "POST") {
          return sendJson(res, 405, { ok: false, error: "method-not-allowed" });
        }
        if (config.annotationEnabled === false) {
          return sendJson(res, 403, { ok: false, error: "annotation-disabled" });
        }
        if (!annotations) {
          return sendJson(res, 503, { ok: false, error: "annotation-unavailable" });
        }
        try {
          const body = await readJson(req);
          const result = annotations.applyFeedback(body);
          if (!result.ok) {
            const status = result.error === "mark-not-found"
              ? 404
              : result.error === "write-failed" ? 503 : 400;
            return sendJson(res, status, { ok: false, ...result });
          }
          return sendJson(res, 200, { ok: true, feedback: result.record });
        } catch (err) {
          const status = err?.message === "body-too-large" ? 413 : 400;
          return sendJson(res, status, { ok: false, error: err?.message ?? "invalid-body" });
        }
      },
    }), "logprobs-highlighter: feedback route");

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
            annotation: annotations?.stats?.() ?? null,
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