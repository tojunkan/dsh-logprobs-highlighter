/**
 * logprobs-highlighter — webServer 路由（tokens 查询 + status）
 *
 * 注册方式照抄 agent-teams 先例（t2 §2a）：ctx.get("webServer") ?? ctx.get("httpServer")
 * + ctx.effect(() => webServer.register({kind:"exact", path, handler})) +
 * ctx.on("internal/service") 晚绑定（headless profile 无 webServer 时插件仍可启动）。
 *
 * - GET /plugins/logprobs-highlighter/tokens?session=&turn=&step=
 *   （architecture-v4 §3.1：captured:false 不是错误，客户端按灰色渲染）
 * - GET /plugins/logprobs-highlighter/status（architecture-v4 §3.2）
 *
 * @module logprobs-highlighter/routes
 */

import { PLUGIN_VERSION } from "./shared.js";

const WEB_SERVER_KEYS = ["webServer", "httpServer"];
const BASE = "/plugins/logprobs-highlighter";

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

/** 捕获条目 → tokens 路由响应（M1：标记引擎未接入，flags/marks 为占位默认值）。 */
function entryToResponse(entry, key) {
  const blocks = entry.blocks.map((b) => ({
    role: b.role,
    tokens: b.tokens.map((t) => ({
      index: t.index,
      text: t.text,
      logprob: t.logprob,
      confidence: typeof t.logprob === "number" ? Number(Math.exp(Math.min(0, t.logprob)).toFixed(4)) : null,
      top: t.top,
      flags: { mutation: false, lowConfidence: false, category: "none" }, // M2 标记引擎接入后填充
    })),
  }));
  return {
    ok: true,
    key,
    captured: true,
    notCapturedReason: null,
    message: { id: entry.assoc?.messageId ?? null, model: entry.model },
    reasoningState: entry.reasoningState,
    usage: entry.usage,
    blocks,
    marks: [], // M2 标记引擎接入后填充
  };
}

export function registerRoutes(ctx, deps, logger = console) {
  const { capture, baseurl, proxy, config } = deps;
  let registered = false;

  const register = () => {
    if (registered) return;
    const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
    if (webServer === undefined) return;
    registered = true;

    // —— tokens：客户端按 (sessionId, turn, step) 查询捕获/标记数据 ——
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
          if (step === null || !Number.isInteger(step)) return sendJson(res, 400, { ok: false, error: "missing-param", param: "step" });

          const entry = capture.query(session, turn, step);
          const key = { sessionId: session, turn, step };
          if (entry) return sendJson(res, 200, entryToResponse(entry, key));

          // 索引未命中：区分"关联未完成"与"无捕获"
          const pending = capture.pendingCount(session);
          return sendJson(res, 200, {
            ok: true,
            key,
            captured: false,
            notCapturedReason: pending > 0 ? "assoc-pending" : "not-found",
            message: null,
            reasoningState: null,
            usage: null,
            blocks: [],
            marks: [],
          });
        } catch (err) {
          logger.warn(`routes: /tokens 处理异常（${err.message}）`);
          return sendJson(res, 500, { ok: false, error: "internal" });
        }
      },
    }), "logprobs-highlighter: tokens route");

    // —— status：调试/健康 ——
    ctx.effect(() => webServer.register({
      kind: "exact",
      path: `${BASE}/status`,
      handler: (req, res) => {
        try {
          const b = baseurl.getState();
          const s = capture.stats();
          const cfg = config || {};
          return sendJson(res, 200, {
            ok: true,
            version: PLUGIN_VERSION,
            proxy: { port: proxy.port, listening: proxy.listening(), upstream: b.managed ? b.original : cfg.upstreamBaseUrl },
            baseUrl: { managed: b.managed, original: b.original, current: b.current, selfHealed: b.selfHealed },
            capture: {
              ringSize: s.ringSize,
              entries: s.entries,
              pendingAssoc: s.pendingAssoc,
              blockedModels: s.blockedModels,
              indexEntries: s.indexEntries,
            },
            config: {
              topLogprobs: cfg.topLogprobs,
              modelGlob: cfg.modelGlob,
              ringSize: cfg.ringSize,
              ringTtlMs: cfg.ringTtlMs,
              upstreamBaseUrl: cfg.upstreamBaseUrl,
            },
          });
        } catch (err) {
          logger.warn(`routes: /status 处理异常（${err.message}）`);
          return sendJson(res, 500, { ok: false, error: "internal" });
        }
      },
    }), "logprobs-highlighter: status route");

    logger.info(`routes: ${BASE}/tokens 与 ${BASE}/status 已注册`);
  };

  register();
  ctx.on("internal/service", (name) => {
    if (WEB_SERVER_KEYS.includes(name)) register();
  });
}
