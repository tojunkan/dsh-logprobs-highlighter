/**
 * logprobs-highlighter — 内嵌 HTTP 反代（ReverseProxy）
 *
 * 监听 127.0.0.1:<proxyPort>（仅 IPv4 loopback），转发 POST {upstream}/chat/completions：
 * - 仅处理：POST /chat/completions 且 model 命中 modelGlob（默认 deepseek-*）且
 *   非 compact（x-deepseek-harness-compact:1）且不在模型黑名单 → 注入
 *   {logprobs:true, top_logprobs:N}，胖流边收边分流：剥皮流（删 choices[i].logprobs
 *   重序列化）→ 转发 dsh；胖 chunk → 双字段解析（logprobs.content +
 *   logprobs.reasoning_content，M0 实测硬要求）→ capture
 * - 其余一律原样透传：不注入、不捕获、不剥皮、不记录（README §5.1）
 * - 400/422 且错误含 logprobs 关键字 → 去掉注入参数重试一次；成功记模型黑名单；
 *   错误体原样透传（t1 §5.2）
 * - 捕获条目 complete 语义（I1）：[DONE]/finish_reason/usage 到达 = complete；
 *   流中止/上游错误 = aborted（complete:false），由 assoc 跳过不参与关联
 *
 * 角色分类、双字段解析、剥皮逻辑与 scripts/m0-probe.mjs / lib/shared.js 一致。
 *
 * @module logprobs-highlighter/proxy
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createEntry } from "./capture.js";
import { classifySegment, normalizeToken, normalizeUsage, stripLogprobs, isLogprobsRejection, matchesModelGlob } from "./shared.js";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
  "trailer", "transfer-encoding", "upgrade", "host", "expect", "content-length",
  // BLK-1：undici fetch 自动解压响应体但保留 content-encoding 头；若原样转发，
  // dsh 侧收到"明文 body + gzip 头"→ 整流 Z_DATA_ERROR 崩溃。转发时一律剔除，
  // 下游永远拿到已解压的明文流（injected / passthrough / forwardUpstreamResponse 三路）。
  "content-encoding",
]);

/** 复制上游响应头（去掉 hop-by-hop 与 content-length——转发时重新分块）。 */
function pickHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/** 写 chunk 并处理背压。 */
function writeChunk(res, chunk) {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => res.once("drain", resolve));
}

function isSseResponse(resp) {
  const ct = resp.headers.get("content-type") ?? "";
  return ct.includes("text/event-stream");
}

function clientError(res, status, body) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ ok: false, error: body }));
}

/** 转发一个已取得的上游响应（SSE 逐块 / 其他整读），不捕获。 */
async function forwardUpstreamResponse(res, upstreamResp) {
  const outHeaders = pickHeaders(upstreamResp.headers);
  if (isSseResponse(upstreamResp)) {
    delete outHeaders["content-length"];
    res.writeHead(upstreamResp.status, outHeaders);
    for await (const chunk of upstreamResp.body) await writeChunk(res, chunk);
    res.end();
  } else {
    const text = await upstreamResp.text();
    res.writeHead(upstreamResp.status, { ...outHeaders, "content-length": Buffer.byteLength(text) });
    res.end(text);
  }
}

export function createProxy(options) {
  const {
    port = 8787,
    modelGlob = "deepseek-*",
    topLogprobs = 2,
    getUpstream, // () => string（当前反代上游）
    capture, // capture store（createCaptureStore 实例）
    logger = console,
  } = options;

  let server = null;

  /** 原样透传（不注入/不捕获/不剥皮）：先读全文再转发，SSE 逐块转发。 */
  async function passthrough(req, res, method, bodyText, url) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    const upstreamResp = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : bodyText,
    });
    const outHeaders = pickHeaders(upstreamResp.headers);
    if (isSseResponse(upstreamResp)) {
      res.writeHead(upstreamResp.status, outHeaders);
      for await (const chunk of upstreamResp.body) await writeChunk(res, chunk);
      res.end();
    } else {
      const text = await upstreamResp.text();
      res.writeHead(upstreamResp.status, { ...outHeaders, "content-length": Buffer.byteLength(text) });
      res.end(text);
    }
  }

  /**
   * 注入 + 捕获 + 剥皮转发（仅命中 DeepSeek 目录且非 compact 且非黑名单的请求）。
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @param {object} parsed 原始请求体（dsh 的，无 logprobs）
   * @param {string} rawBody 原始请求体文本（用于去掉注入后的重试）
   * @param {string} url 上游地址
   * @param {string} sessionId
   */
  async function injected(req, res, parsed, rawBody, url, sessionId) {
    const entry = createEntry({
      id: `req-${randomUUID()}`,
      sessionId,
      compact: false,
      model: parsed.model,
    });
    const blockByRole = {
      text: entry.blocks[0],
      reasoning: entry.blocks[1],
      "tool-call": entry.blocks[2],
    };
    const idxByRole = { text: 0, reasoning: 0, "tool-call": 0 };
    let sawDone = false;
    let sawFinish = false;
    let sawUsage = false;

    const injectedBody = { ...parsed, logprobs: true, top_logprobs: topLogprobs };
    let upstreamResp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: req.headers.authorization ?? "",
        ...passthroughHeaders(req),
      },
      body: JSON.stringify(injectedBody),
    });

    // —— 400/422 降级：去掉注入参数重试一次（t1 §5.2 / README §5.1） ——
    if (!upstreamResp.ok && (upstreamResp.status === 400 || upstreamResp.status === 422)) {
      const errText = await upstreamResp.text();
      if (isLogprobsRejection(upstreamResp.status, errText)) {
        logger.warn(`proxy: ${parsed.model} 拒绝 logprobs（HTTP ${upstreamResp.status}），去掉注入重试一次`);
        upstreamResp = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: req.headers.authorization ?? "",
            ...passthroughHeaders(req),
          },
          body: rawBody, // 原始请求体（无注入）
        });
        if (upstreamResp.ok) {
          capture.markUnsupported(parsed.model); // 模型级记忆：后续直接透传不注入
          logger.warn(`proxy: ${parsed.model} 重试成功 → 记入模型黑名单（不支持 logprobs）`);
          await forwardUpstreamResponse(res, upstreamResp); // lean 原样转发，不捕获
          return;
        } else {
          // 重试仍失败：原样透传重试的错误体
          await forwardUpstreamResponse(res, upstreamResp);
          return;
        }
      } else {
        // 非 logprobs 拒绝（如参数其他错误）：原样透传（body 已读入 errText，直接回发）
        const outHeaders = pickHeaders(upstreamResp.headers);
        res.writeHead(upstreamResp.status, {
          ...outHeaders,
          "content-type": upstreamResp.headers.get("content-type") ?? "application/json",
          "content-length": Buffer.byteLength(errText),
        });
        res.end(errText);
        return;
      }
    }

    if (!upstreamResp.ok || !upstreamResp.body) {
      // 其他非 2xx（401/429/5xx 等）：原样透传错误体，不产生捕获条目
      await forwardUpstreamResponse(res, upstreamResp);
      return;
    }

    // —— 2xx：SSE 边收边分流（剥皮 → dsh；胖 chunk → capture） ——
    const outHeaders = pickHeaders(upstreamResp.headers);
    delete outHeaders["content-length"];
    res.writeHead(upstreamResp.status, outHeaders);

    let complete = false;
    let streamFailed = false;

    const finalize = () => {
      entry.complete = complete;
      entry.reasoningState =
        entry.blocks[1].tokens.length > 0 ? "present"
          : entry._sawReasoningDelta ? "unknown"
            : "absent";
      capture.store(entry);
    };

    try {
      if (isSseResponse(upstreamResp)) {
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const u8 of upstreamResp.body) {
          buffer += decoder.decode(u8, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const event = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const handled = handleEvent(event, entry, blockByRole, idxByRole);
            if (handled.done) sawDone = true;
            if (handled.finish) sawFinish = true;
            if (handled.usage) sawUsage = true;
            const frame = handled.frame;
            if (frame !== null) await writeChunk(res, frame);
          }
        }
        buffer += decoder.decode();
        buffer = buffer.replace(/\r\n/g, "\n");
        if (buffer.trim()) {
          const event = buffer.slice(0, buffer.length);
          const handled = handleEvent(event, entry, blockByRole, idxByRole);
          if (handled.done) sawDone = true;
          if (handled.finish) sawFinish = true;
          if (handled.usage) sawUsage = true;
          if (handled.frame !== null) await writeChunk(res, handled.frame);
        }
      } else {
        // 非 SSE（如非流式 JSON，IMP-1）：整读 → 剥皮 → 转发；同时解析捕获。
        // 非流式没有 delta（用 choice.message），且单个 choice 可能同时含
        // content 与 reasoning_content 双段 → 双字段各自捕获（与 M0 双字段
        // 硬要求一致；单角色映射会漏掉另一段）。
        const text = await upstreamResp.text();
        let parsedResp = null;
        try {
          parsedResp = JSON.parse(text);
          const choice = parsedResp?.choices?.[0];
          const lp = choice?.logprobs;
          for (const t of Array.isArray(lp?.content) ? lp.content : []) {
            blockByRole.text.tokens.push({ index: idxByRole.text++, ...normalizeToken(t) });
          }
          if (Array.isArray(lp?.reasoning_content)) {
            entry._sawReasoningDelta = true;
            for (const t of lp.reasoning_content) {
              blockByRole.reasoning.tokens.push({ index: idxByRole.reasoning++, ...normalizeToken(t) });
            }
          }
          if (parsedResp.usage) { entry.usage = normalizeUsage(parsedResp.usage); sawUsage = true; }
          if (choice?.finish_reason) sawFinish = true;
          sawDone = sawFinish || sawUsage || sawDone;
        } catch { /* 非 JSON 或解析失败：原样转发 */ }
        const outText = parsedResp ? JSON.stringify(stripLogprobs(parsedResp)) : text;
        res.write(outText);
        res.end(); // SUG-1：本分支显式结束，finally 只兜异常路径
      }
    } catch (err) {
      streamFailed = true;
      logger.warn(`proxy: 转发/捕获流失败（${err.message}），条目标记 aborted`);
      if (!res.headersSent) {
        clientError(res, 502, "upstream-stream-failed");
      } else {
        res.destroy();
      }
    } finally {
      complete = sawDone || sawFinish || sawUsage;
      if (!streamFailed && !complete) {
        // 上游正常结束但未见 [DONE]/finish/usage（异常截断）→ aborted
        logger.warn(`proxy: 流结束但未见 [DONE]/finish/usage（${parsed.model}），条目标记 aborted`);
      }
      finalize();
      if (!streamFailed && !res.writableEnded) res.end();
      if (entry._sawReasoningDelta && entry.blocks[1].tokens.length === 0) {
        // 仅供诊断：思考段出现但无 logprobs 条目（预期不出现，M0 实测均有）
        logger.debug(`proxy: ${parsed.model} 思考段无 logprobs 条目（reasoningState=unknown）`);
      }
    }
  }

  /** 处理单个 SSE data 载荷：捕获 + 剥皮帧。返回 {frame, done, finish, usage}。 */
  function handleEvent(event, entry, blockByRole, idxByRole) {
    const dataLines = event.split("\n").filter((l) => l.startsWith("data:"));
    if (dataLines.length === 0) return { frame: `${event}\n\n`, done: false, finish: false, usage: false };
    const payload = dataLines.map((l) => l.slice(5).trim()).join("\n");
    if (payload === "[DONE]") return { frame: `data: [DONE]\n\n`, done: true, finish: false, usage: false };
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // 无法解析的帧原样转发（不捕获）
      return { frame: `${event}\n\n`, done: false, finish: false, usage: false };
    }
    const choice = parsed?.choices?.[0];
    const delta = choice?.delta ?? {};
    const role = classifySegment(delta);
    if (role === "reasoning") entry._sawReasoningDelta = true;
    const lp = choice?.logprobs;
    const lpArr = role === "text" ? lp?.content : role === "reasoning" ? lp?.reasoning_content : null;
    if (Array.isArray(lpArr)) {
      for (const t of lpArr) {
        blockByRole[role].tokens.push({ index: idxByRole[role]++, ...normalizeToken(t) });
      }
    }
    if (parsed.usage) { entry.usage = normalizeUsage(parsed.usage); }
    const finish = typeof choice?.finish_reason === "string" && choice.finish_reason.length > 0;
    const usage = parsed.usage != null;
    const frame = `data: ${JSON.stringify(stripLogprobs(parsed))}\n\n`;
    return { frame, done: false, finish, usage };
  }

  function passthroughHeaders(req) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || k === "authorization" || k === "content-type") continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    return headers;
  }

  function handler(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const upstream = (getUpstream?.() || "https://api.deepseek.com").replace(/\/+$/, "");
    const target = `${upstream}${url.pathname}${url.search}`;

    const readBody = () =>
      new Promise((resolve) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", () => resolve(""));
      });

    readBody().then(async (bodyText) => {
      try {
        const isChatCompletions = req.method === "POST" && url.pathname === "/chat/completions";
        let model = null;
        let parsed = null;
        if (isChatCompletions && bodyText) {
          try {
            parsed = JSON.parse(bodyText);
            model = typeof parsed?.model === "string" ? parsed.model : null;
          } catch { parsed = null; }
        }
        const isDeepSeek = isChatCompletions && parsed && model && matchesModelGlob(model, modelGlob);
        const compact = req.headers["x-deepseek-harness-compact"] === "1";
        const sessionId = typeof req.headers["x-deepseek-harness-session-id"] === "string" ? req.headers["x-deepseek-harness-session-id"] : null;

        if (!isDeepSeek || compact || !capture.isSupported(model)) {
          // 原样透传：非 DeepSeek / compact / 黑名单模型
          await passthrough(req, res, req.method, bodyText, target);
          return;
        }
        await injected(req, res, parsed, bodyText, target, sessionId);
      } catch (err) {
        logger.warn(`proxy: 请求处理失败（${err.message}）`);
        clientError(res, 500, "internal");
      }
    });
  }

  /** 启动监听（Promise 化；失败 reject）。 */
  function start() {
    return new Promise((resolve, reject) => {
      if (server) { resolve(port); return; }
      server = createServer(handler);
      server.on("error", (err) => reject(err));
      server.listen(port, "127.0.0.1", () => resolve(port));
    });
  }

  /** 关闭监听（dispose 用）。 */
  function close() {
    return new Promise((resolve) => {
      if (!server) { resolve(); return; }
      server.closeAllConnections?.();
      server.close(() => {
        server = null;
        resolve();
      });
    });
  }

  function listening() {
    return server !== null && server.listening;
  }

  return { start, close, listening, port };
}
