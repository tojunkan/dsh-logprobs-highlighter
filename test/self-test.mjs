/**
 * logprobs-highlighter — M1 离线自测（node test/self-test.mjs）
 *
 * 【重要声明】本测试不发起真实 API 请求：
 * - Part A：用 docs/m0-sample-*.json 的【真实 M0 样本 raw】回放分类器/捕获累积逻辑
 *   （真实数据复算，非新请求）；断言 thinking content 24 / reasoning 205、no-thinking 61
 * - Part B：用【本地 mock 上游】验证反代行为（注入 / 剥皮 / 捕获 / 400/422 降级 /
 *   gzip(BLK-1) / 非流式(IMP-1) / aborted(IMP-4) / FIFO 淘汰(IMP-2) / 透传 / compact）；
 *   mock 数据为合成流，结果只代表逻辑正确性，不得冒充真实数据
 * - Part C：mock ctx 直测 baseurl 接管/还原/自愈（IMP-5）、routes /tokens /status（IMP-5）、
 *   assoc 事件形状兼容与 FIFO 顺序（IMP-3）
 * - Part D：client-utils 纯函数单测（M3：色阶映射 / 置信度格式化 / 最小标记判定 /
 *   Top-N 条形图数据 / turnTail key 推导）
 *
 * 用法：node test/self-test.mjs（node:assert 内置，零依赖）；退出码 0=全过。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { classifySegment, normalizeToken, normalizeUsage, stripLogprobs, isLogprobsRejection, matchesModelGlob } from "../lib/shared.js";
import { createCaptureStore, createEntry } from "../lib/capture.js";
import { createProxy } from "../lib/proxy.js";
import { createSettingsTakeover } from "../lib/baseurl.js";
import { registerRoutes } from "../lib/routes.js";
import { createAssociator } from "../lib/assoc.js";
import {
  clamp, logprobToHue, tokenHue, formatConfidence, formatLogprob,
  isSuspiciousToken, topBarData, capturedReasonText, reasoningStateText,
  findClosingAssistantStep, createTokenMatcher, isCodeIdentifier, isCodeNumber,
  isCodeToken, mergeImageGroups,
} from "../lib/client-utils.js";
import { parseMarkdown, mdastToReact } from "../src/client/markdown.js";
import { fetchTokenData, resetTokenCache } from "../src/client/tokens-core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "/plugins/logprobs-highlighter";
const quiet = { debug() {}, warn() {}, info() {}, error() {} };

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/* ================================================================== *
 * Part A — 真实样本回放（分类器 + 捕获累积 + 对齐）
 * ================================================================== */

function replaySample(file) {
  const s = JSON.parse(readFileSync(file, "utf8"));
  const st = { text: { chunks: 0, tokens: 0, alignExact: 0, alignDiff: 0, multiChunk: 0 }, reasoning: { chunks: 0, tokens: 0, alignExact: 0, alignDiff: 0, multiChunk: 0 } };
  let nonEmptyContentClassifiedText = 0;
  let nonEmptyContentTotal = 0;
  for (const c of s.chunks) {
    const j = JSON.parse(c.raw);
    const delta = j.choices?.[0]?.delta ?? {};
    const lp = j.choices?.[0]?.logprobs ?? null;
    const role = classifySegment(delta);
    if (typeof delta.content === "string" && delta.content.length > 0) {
      nonEmptyContentTotal++;
      if (role === "text") nonEmptyContentClassifiedText++;
    }
    if (role === "text") {
      st.text.chunks++;
      const arr = Array.isArray(lp?.content) ? lp.content : null;
      if (arr) {
        st.text.tokens += arr.length;
        const joined = arr.map((t) => t.token).join("");
        if (joined === delta.content) st.text.alignExact++; else st.text.alignDiff++;
        if (arr.length > 1) st.text.multiChunk++;
      }
    } else if (role === "reasoning") {
      st.reasoning.chunks++;
      const arr = Array.isArray(lp?.reasoning_content) ? lp.reasoning_content : null;
      if (arr) {
        st.reasoning.tokens += arr.length;
        const joined = arr.map((t) => t.token).join("");
        if (joined === delta.reasoning_content) st.reasoning.alignExact++; else st.reasoning.alignDiff++;
        if (arr.length > 1) st.reasoning.multiChunk++;
      }
    }
  }
  return { st, nonEmptyContentClassifiedText, nonEmptyContentTotal, chunks: s.chunks.length };
}

console.log("Part A — 真实样本回放（本地自测：真实 M0 数据复算，非新请求）");
{
  const t = replaySample(path.join(ROOT, "docs/m0-sample-thinking.json"));
  check("thinking: 非空 delta.content 的 chunk 全部归类 text（24/24 不被吞入 reasoning）", t.nonEmptyContentTotal === 24 && t.nonEmptyContentClassifiedText === 24);
  check("thinking: content 段 24 tokens（1/chunk）", t.st.text.tokens === 24 && t.st.text.alignExact === 24 && t.st.text.alignDiff === 0 && t.st.text.multiChunk === 0);
  check("thinking: reasoning 段 205 tokens（对齐 205/205）", t.st.reasoning.tokens === 205 && t.st.reasoning.alignExact === 205 && t.st.reasoning.alignDiff === 0);
  check("thinking: chunk 总数 231", t.chunks === 231);

  const n = replaySample(path.join(ROOT, "docs/m0-sample-nothinking.json"));
  check("nothinking: content 段 61 tokens（对齐 61/61）", n.st.text.tokens === 61 && n.st.text.alignExact === 61 && n.st.text.alignDiff === 0);
  check("nothinking: reasoning 段 0 tokens", n.st.reasoning.tokens === 0);
  check("nothinking: chunk 总数 63", n.chunks === 63);
}

// shared 工具微测
console.log("shared 工具（本地自测）");
{
  check("matchesModelGlob: deepseek-v4-flash 命中 deepseek-*", matchesModelGlob("deepseek-v4-flash", "deepseek-*") === true);
  check("matchesModelGlob: deepseek-chat 旧别名命中", matchesModelGlob("deepseek-chat", "deepseek-*") === true);
  check("matchesModelGlob: gpt-4o 不命中", matchesModelGlob("gpt-4o", "deepseek-*") === false);
  check("isLogprobsRejection: 400+logprobs 关键字", isLogprobsRejection(400, '{"error":{"message":"logprobs not supported"}}') === true);
  check("isLogprobsRejection: 400+unsupported", isLogprobsRejection(400, "top_logprobs unsupported") === true);
  check("isLogprobsRejection: 401 不算", isLogprobsRejection(401, "logprobs") === false);
  check("isLogprobsRejection: 400 无关键字不算", isLogprobsRejection(400, '{"error":{"message":"bad request"}}') === false);
  check("stripLogprobs: 双字段一并剥掉", JSON.stringify(stripLogprobs({ choices: [{ logprobs: { content: [], reasoning_content: [] } }] })) === '{"choices":[{}]}');
  check("normalizeToken: 最小字段", JSON.stringify(normalizeToken({ token: "深", logprob: -0.03, top_logprobs: [{ token: "圳", logprob: -1.9 }] })) === JSON.stringify({ text: "深", logprob: -0.03, top: [{ token: "圳", logprob: -1.9 }] }));
}

/* ================================================================== *
 * Part B — mock 上游反代行为（本地自测：合成数据，非真实）
 * ================================================================== */

/** 合成 SSE 胖流（content chunk 用真实形态 {"content":X,"reasoning_content":null}）。 */
function sseFat(model) {
  const chunks = [
    { id: "mock", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null, logprobs: null }], usage: null },
    { choices: [{ index: 0, delta: { content: null, reasoning_content: "We" }, finish_reason: null, logprobs: { reasoning_content: [{ token: "We", logprob: -0.0005, bytes: [87, 101], top_logprobs: [] }] } }] },
    { choices: [{ index: 0, delta: { content: "深", reasoning_content: null }, finish_reason: null, logprobs: { content: [{ token: "深", logprob: -0.03, bytes: [230, 183, 177], top_logprobs: [{ token: "深", logprob: -0.03 }, { token: "圳", logprob: -1.89 }] }] } }] },
    { choices: [{ index: 0, delta: { content: "圳", reasoning_content: null }, finish_reason: null, logprobs: { content: [{ token: "圳", logprob: -1.89, bytes: [229, 156, 179], top_logprobs: [] }] } }] },
    { choices: [{ index: 0, delta: { content: "", role: null }, finish_reason: "stop", logprobs: null }], usage: { prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 1 } } },
  ];
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

function sseLean(model) {
  const chunks = [
    { id: "mock", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }], usage: null },
    { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "", role: null }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } },
  ];
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

async function startMockUpstream(behavior) {
  const seen = []; // 记录每个请求 {url, method, body(parsed|null), headers}
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      let parsed = null;
      try { parsed = bodyText ? JSON.parse(bodyText) : null; } catch { parsed = null; }
      const record = { url: req.url, method: req.method, body: parsed, hasLogprobs: !!(parsed && parsed.logprobs === true), headers: req.headers };
      seen.push(record);
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("mock-health-ok");
        return;
      }
      if (req.url !== "/chat/completions") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("mock-404");
        return;
      }
      const model = parsed?.model ?? "";
      if (behavior === "reject400" && model === "deepseek-v4-pro") {
        if (parsed?.logprobs === true) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "logprobs is not supported for this model", type: "invalid_request_error", param: "logprobs", code: "unsupported_parameter" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseLean(model));
        return;
      }
      if (behavior === "reject422") {
        if (parsed?.logprobs === true) {
          res.writeHead(422, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "top_logprobs not supported", type: "invalid_request_error", code: "unsupported_parameter" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseLean(model));
        return;
      }
      if (behavior === "reject-forever") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "forever-error: still rejecting", code: "unsupported_parameter" } }));
        return;
      }
      if (behavior === "plain400") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "plain400-error: bad request body", type: "invalid_request_error" } }));
        return;
      }
      if (behavior === "gzip") {
        const body = sseFat(model);
        const gz = gzipSync(Buffer.from(body, "utf8"));
        res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": gz.length });
        res.end(gz);
        return;
      }
      if (behavior === "nonstream") {
        const resp = {
          id: "mock-ns", object: "chat.completion", model, created: 1,
          choices: [{
            index: 0,
            message: { role: "assistant", content: "深圳", reasoning_content: "想" },
            finish_reason: "stop",
            logprobs: {
              content: [
                { token: "深", logprob: -0.03, bytes: [230, 183, 177], top_logprobs: [{ token: "深", logprob: -0.03 }, { token: "圳", logprob: -1.89 }] },
                { token: "圳", logprob: -1.89, bytes: [229, 156, 179], top_logprobs: [] },
              ],
              reasoning_content: [{ token: "想", logprob: -0.5, bytes: [230, 131, 179], top_logprobs: [] }],
            },
          }],
          usage: { prompt_tokens: 3, completion_tokens: 3 },
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(resp));
        return;
      }
      if (behavior === "abort") {
        const frames = sseFat(model).split("\n\n");
        // 只发前 2 帧（role-only + reasoning chunk），不发 [DONE]/finish/usage
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frames[0] + "\n\n");
        res.write(frames[1] + "\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "mock-req-1" });
      res.end(sseFat(model));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

async function postSse(port, bodyObj, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(bodyObj),
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

console.log("\nPart B — mock 上游反代行为（本地自测：合成数据，非真实请求）");
{
  const mock = await startMockUpstream("normal");
  const capture = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
  const proxy = createProxy({ port: 18788 + Math.floor(Math.random() * 500), modelGlob: "deepseek-*", topLogprobs: 2, getUpstream: () => mock.url, capture, logger: quiet });
  const port = await proxy.start();

  // B1: DeepSeek 请求 → 注入 + 剥皮 + 捕获（content 24/24 式分类：本 mock 2 个 content token）
  {
    const r = await postSse(port, { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }, { "x-deepseek-harness-session-id": "sess-b1", authorization: "Bearer sk-test" });
    const last = mock.seen[mock.seen.length - 1];
    check("B1: 上游收到注入 logprobs:true + top_logprobs:2", last.hasLogprobs && last.body.top_logprobs === 2);
    check("B1: Authorization 原样到达上游（SUG-2）", last.headers.authorization === "Bearer sk-test");
    check("B1: 客户端收到剥皮流（无 logprobs 字段）", r.status === 200 && !r.text.includes('"logprobs"') && r.text.includes("data: [DONE]"));
    const entries = capture.stats().entries;
    check("B1: 捕获 1 条且 complete", entries === 1, `entries=${entries}`);
    // 通过 attach 出队取条目断言（模拟 assoc 模块在 assistant/message 事件时的行为）
    const attached = capture.attach("sess-b1", { turn: 1, step: 2, messageId: "msg-1", usage: null });
    check("B1: attach 出队成功且写索引", attached !== null && attached.sessionId === "sess-b1" && attached.complete === true);
    check("B1: reasoningState=present（reasoning logprobs 存在）", attached.reasoningState === "present");
    check("B1: blocks 双字段（reasoning 1 token + text 2 tokens）", attached.blocks[1].tokens.length === 1 && attached.blocks[0].tokens.length === 2);
    check("B1: text token 内容与 top 归一化", attached.blocks[0].tokens[0].text === "深" && attached.blocks[0].tokens[0].top.length === 2 && attached.blocks[0].tokens[1].text === "圳");
    check("B1: usage 归一化", attached.usage.inputTokens === 10 && attached.usage.outputTokens === 4 && attached.usage.reasoningTokens === 1);
    check("B1: 索引 (1,2) 可查询", capture.query("sess-b1", 1, 2) !== null && capture.query("sess-b1", 0, 0) === null);
    check("B1: 关联后 pendingAssoc 归零", capture.pendingCount("sess-b1") === 0);
    check("B1: assoc 字段写入", attached.assoc.turn === 1 && attached.assoc.step === 2 && attached.assoc.messageId === "msg-1");
  }

  // B2: 非 DeepSeek 模型 → 原样透传（mock 胖流原样到达，不剥皮不捕获）
  {
    const before = capture.stats().entries;
    const r = await postSse(port, { model: "gpt-4o", messages: [] });
    const last = mock.seen[mock.seen.length - 1];
    check("B2: 非 DeepSeek 未注入", last.hasLogprobs === false);
    check("B2: 胖流原样透传（含 logprobs 字段）", r.status === 200 && r.text.includes('"logprobs"') && r.text.includes("data: [DONE]"));
    check("B2: 不产生捕获", capture.stats().entries === before);
  }

  // B3: compact 请求 → 透传不捕获（不注入）
  {
    const before = capture.stats().entries;
    const r = await postSse(port, { model: "deepseek-v4-flash", messages: [] }, { "x-deepseek-harness-compact": "1" });
    const last = mock.seen[mock.seen.length - 1];
    check("B3: compact 未注入", last.hasLogprobs === false);
    check("B3: compact 透传成功", r.status === 200 && r.text.includes("data: [DONE]"));
    check("B3: compact 不产生捕获", capture.stats().entries === before);
  }

  // B4: 其他路径（GET /health）→ 原样透传
  {
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    check("B4: GET /health 透传", r.status === 200 && (await r.text()) === "mock-health-ok");
  }

  await proxy.close();
  await mock.close();
}

// B5: 400/422 降级 + 模型黑名单（独立 mock/实例，避免与前面共享状态）
console.log("\nPart B5 — 400 降级重试 + 模型黑名单（本地自测：mock）");
{
  const mock = await startMockUpstream("reject400");
  const capture = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
  const proxy = createProxy({ port: 19300 + Math.floor(Math.random() * 500), modelGlob: "deepseek-*", topLogprobs: 2, getUpstream: () => mock.url, capture, logger: quiet });
  const port = await proxy.start();

  // 第一次：注入 → 400 → 去注入重试 → 200 lean
  const r1 = await postSse(port, { model: "deepseek-v4-pro", messages: [] });
  const reqs = mock.seen.filter((s) => s.url === "/chat/completions");
  check("B5: 首次请求带注入", reqs[0].hasLogprobs === true);
  check("B5: 重试请求去掉注入", reqs[1].hasLogprobs === false);
  check("B5: 客户端收到 200（重试成功）", r1.status === 200 && r1.text.includes("data: [DONE]"));
  check("B5: 模型记入黑名单", capture.isSupported("deepseek-v4-pro") === false);
  check("B5: 降级成功不产生捕获条目（lean 不捕获）", capture.stats().entries === 0);

  // 第二次：黑名单 → 直接透传（不注入）
  const before = capture.stats().entries;
  const r2 = await postSse(port, { model: "deepseek-v4-pro", messages: [] });
  const last = mock.seen[mock.seen.length - 1];
  check("B5: 黑名单后第二次请求不注入", last.hasLogprobs === false);
  check("B5: 黑名单后仍正常转发", r2.status === 200 && r2.text.includes("data: [DONE]"));
  check("B5: 黑名单后不产生捕获", capture.stats().entries === before);

  // 其他模型不受黑名单影响
  check("B5: 其他模型仍支持", capture.isSupported("deepseek-v4-flash") === true);

  await proxy.close();
  await mock.close();
}

// B6: 非 logprobs 400（如参数错误）→ 原样透传错误体，不重试（mock 行为：400 且无关键字）
console.log("\nPart B6 — 非 logprobs 400 原样透传（本地自测：mock）");
{
  const mock = await startMockUpstream("plain400");
  const capture = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
  const proxy = createProxy({ port: 19800 + Math.floor(Math.random() * 300), modelGlob: "deepseek-*", topLogprobs: 2, getUpstream: () => mock.url, capture, logger: quiet });
  const port = await proxy.start();
  mock.seen.length = 0;
  const r = await postSse(port, { model: "deepseek-v4-flash", messages: [] });
  // 让 mock 对 plain400 直接回 400 无关键字
  const last = mock.seen[mock.seen.length - 1];
  check("B6: 收到 400 且未重试（只 1 个请求）", r.status === 400 && mock.seen.length === 1);
  check("B6: 错误体原样（含 400 标记）", r.text.includes("plain400-error"));
  check("B6: 模型未被拉黑（非 logprobs 拒绝）", capture.isSupported("deepseek-v4-flash") === true);
  await proxy.close();
  await mock.close();
}

// B7: BLK-1 回归——上游 gzip 压缩 SSE：反代必须剔除 content-encoding，dsh 侧收到明文流
console.log("\nPart B7 — gzip 上游（BLK-1 回归，本地自测：mock）");
{
  const mock = await startMockUpstream("gzip");
  const capture = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
  const proxy = createProxy({ port: 20100 + Math.floor(Math.random() * 400), modelGlob: "deepseek-*", topLogprobs: 2, getUpstream: () => mock.url, capture, logger: quiet });
  const port = await proxy.start();
  const r = await postSse(port, { model: "deepseek-v4-flash", messages: [] }, { "x-deepseek-harness-session-id": "sess-gzip" });
  check("B7: 客户端响应无 content-encoding 头", r.headers.get("content-encoding") === null);
  check("B7: 响应体为明文 data: 帧（可解析）", r.text.startsWith("data: ") && r.text.includes("data: [DONE]") && !r.text.includes("\uFFFD"));
  check("B7: gzip 下捕获正常（complete + text tokens）", capture.stats().entries === 1);
  const attached = capture.attach("sess-gzip", { turn: 1, step: 0, messageId: "m", usage: null });
  check("B7: gzip 下捕获双字段", attached !== null && attached.complete === true && attached.blocks[0].tokens.length === 2 && attached.blocks[1].tokens.length === 1);
  await proxy.close();
  await mock.close();
}

// B8: IMP-1——非流式（application/json）响应也捕获 logprobs（delta 无 → message 兜底）
console.log("\nPart B8 — 非流式响应捕获（IMP-1，本地自测：mock）");
{
  const mock = await startMockUpstream("nonstream");
  const capture = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
  const proxy = createProxy({ port: 20500 + Math.floor(Math.random() * 400), modelGlob: "deepseek-*", topLogprobs: 2, getUpstream: () => mock.url, capture, logger: quiet });
  const port = await proxy.start();
  const r = await postSse(port, { model: "deepseek-v4-flash", messages: [] }, { "x-deepseek-harness-session-id": "sess-ns" });
  const attached = capture.attach("sess-ns", { turn: 1, step: 0, messageId: "m", usage: null });
  check("B8: 非流式响应捕获 text tokens（1:1 对齐，无 index）", attached !== null && attached.blocks[0].tokens.length === 2 && attached.blocks[0].tokens[0].text === "深" && attached.blocks[0].tokens[1].text === "圳");
  check("B8: 非流式响应捕获 reasoning tokens", attached.blocks[1].tokens.length === 1 && attached.blocks[1].tokens[0].text === "想");
  check("B8: 非流式剥皮转发（响应体无 logprobs）", r.status === 200 && !r.text.includes('"logprobs"'));
  await proxy.close();
  await mock.close();
}

// B9: IMP-4——aborted 语义：上游流中断（无 [DONE]/finish/usage）→ complete:false → attach 跳过并 GC
console.log("\nPart B9 — aborted 语义（IMP-4，本地自测：mock）");
{
  const mock = await startMockUpstream("abort");
  const capture = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
  const proxy = createProxy({ port: 20900 + Math.floor(Math.random() * 400), modelGlob: "deepseek-*", topLogprobs: 2, getUpstream: () => mock.url, capture, logger: quiet });
  const port = await proxy.start();

  // ① 流中断 → 捕获条目标记 aborted
  await postSse(port, { model: "deepseek-v4-flash", messages: [] }, { "x-deepseek-harness-session-id": "sess-abort" });
  const attached = capture.attach("sess-abort", { turn: 1, step: 0, messageId: "m", usage: null });
  check("B9: 流中断条目标记 aborted（complete:false）", attached === null, "attach 应跳过 aborted");
  check("B9: pendingCount 只数 complete（aborted 不计）", capture.pendingCount("sess-abort") === 0);
  check("B9: aborted 条目不入索引", capture.query("sess-abort", 1, 0) === null);

  // ② FIFO 混排 [aborted, complete] → attach 跳过 aborted 并 GC、命中 complete
  {
    const c2 = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
    const e1 = createEntry({ id: "req-aborted", sessionId: "sess-mix", model: "deepseek-v4-flash" }); // complete:false
    const e2 = createEntry({ id: "req-complete", sessionId: "sess-mix", model: "deepseek-v4-flash" });
    e2.complete = true;
    c2.store(e1);
    c2.store(e2);
    const hit = c2.attach("sess-mix", { turn: 5, step: 0, messageId: "m", usage: null });
    check("B9: [aborted,complete] 混排 → attach 返回 complete", hit !== null && hit.id === "req-complete" && hit.assoc.turn === 5);
    check("B9: 混排后 FIFO 已 GC（pendingCount=0）", c2.pendingCount("sess-mix") === 0);
  }
  await proxy.close();
  await mock.close();
}

// B10: IMP-2 回归——环形淘汰同步清理 FIFO（ringSize=2 存 3 条）
console.log("\nPart B10 — FIFO 随环形淘汰清理（IMP-2 回归，本地自测）");
{
  const capture = createCaptureStore({ ringSize: 2, ringTtlMs: 3600_000 }, quiet);
  for (let i = 1; i <= 3; i++) {
    const e = createEntry({ id: `req-${i}`, sessionId: "sess-r", model: "deepseek-v4-flash" });
    e.complete = true;
    capture.store(e);
  }
  check("B10: ring 只剩 2 条", capture.stats().entries === 2);
  check("B10: FIFO 同步清理（pendingAssoc=2 而非 3）", capture.stats().pendingAssoc === 2);
  const a1 = capture.attach("sess-r", { turn: 1, step: 0, messageId: "m", usage: null });
  const a2 = capture.attach("sess-r", { turn: 1, step: 1, messageId: "m", usage: null });
  check("B10: attach 只出队存活条目（req-2, req-3）", a1?.id === "req-2" && a2?.id === "req-3");
  check("B10: 已淘汰条目不可查询（无悬挂索引）", capture.query("sess-r", 1, 0)?.id === "req-2" && capture.query("sess-r", 9, 9) === null);
}

// B11: SUG-6——422 降级重试成功 + 重试仍失败原样透传错误体
console.log("\nPart B11 — 422 降级 + 重试仍失败（SUG-6，本地自测：mock）");
{
  const mock422 = await startMockUpstream("reject422");
  const c422 = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
  const p422 = createProxy({ port: 21300 + Math.floor(Math.random() * 300), modelGlob: "deepseek-*", topLogprobs: 2, getUpstream: () => mock422.url, capture: c422, logger: quiet });
  const port422 = await p422.start();
  const r422 = await postSse(port422, { model: "deepseek-v4-flash", messages: [] });
  const reqs422 = mock422.seen.filter((s) => s.url === "/chat/completions");
  check("B11: 422 注入 → 重试去注入 → 200", reqs422[0].hasLogprobs === true && reqs422[1].hasLogprobs === false && r422.status === 200);
  check("B11: 422 降级记黑名单", c422.isSupported("deepseek-v4-flash") === false);
  await p422.close();
  await mock422.close();

  const mockFail = await startMockUpstream("reject-forever");
  const cFail = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
  const pFail = createProxy({ port: 21700 + Math.floor(Math.random() * 200), modelGlob: "deepseek-*", topLogprobs: 2, getUpstream: () => mockFail.url, capture: cFail, logger: quiet });
  const portFail = await pFail.start();
  mockFail.seen.length = 0;
  const rFail = await postSse(portFail, { model: "deepseek-v4-flash", messages: [] });
  check("B11: 重试仍失败 → 原样透传错误体（400 + forever-error）", rFail.status === 400 && rFail.text.includes("forever-error"));
  check("B11: 重试仍失败 → 共 2 个请求（重试一次）", mockFail.seen.length === 2);
  check("B11: 重试仍失败 → 不记黑名单", cFail.isSupported("deepseek-v4-flash") === true);
  await pFail.close();
  await mockFail.close();
}

/* ================================================================== *
 * Part C — baseurl / routes / assoc 单元测试（mock ctx，IMP-5）
 * ================================================================== */

/** 最小 mock ctx：settings 内存实现 + on/emit 事件桩 + get/effect 桩。 */
function makeMockCtx(initial) {
  const store = new Map(Object.entries(initial || {}));
  const updateLog = [];
  const handlers = new Map();
  const ctx = {
    logger: quiet,
    settings: {
      get: (ns) => {
        if (!store.has(ns)) throw new Error(`namespace ${ns} not ready`);
        return store.get(ns);
      },
      update: async (ns, patch) => {
        updateLog.push({ ns, patch });
        store.set(ns, { ...(store.get(ns) || {}), ...patch });
      },
    },
    on: (name, fn) => {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
    emit: (name, ...args) => {
      for (const fn of handlers.get(name) || []) fn(...args);
    },
    get: () => undefined,
    effect: () => () => {},
  };
  return { ctx, store, updateLog };
}

console.log("\nPart C1 — baseurl 接管/还原/自愈（IMP-5，本地自测：mock ctx）");
{


  // C1a: 正常接管 → 还原
  {
    const { ctx, store, updateLog } = makeMockCtx({ "llm-deepseek": { baseURL: "https://api.deepseek.com" } });
    const bu = createSettingsTakeover(ctx, { manageBaseUrl: true, proxyPort: 8787, upstreamBaseUrl: "https://api.deepseek.com" }, quiet);
    const proxyStub = { start: async () => {}, close: async () => {}, listening: () => true, port: 8787 };
    const st = await bu.takeover(proxyStub);
    check("C1a: 接管写入 127.0.0.1:8787", st.managed === true && store.get("llm-deepseek").baseURL === "http://127.0.0.1:8787");
    check("C1a: original 记录旧值", bu.getState().original === "https://api.deepseek.com");
    await bu.restore();
    check("C1a: restore 还原旧值", store.get("llm-deepseek").baseURL === "https://api.deepseek.com");
  }

  // C1b: 用户改过当前值 → restore 不覆盖
  {
    const { ctx, store, updateLog } = makeMockCtx({ "llm-deepseek": { baseURL: "https://api.deepseek.com" } });
    const bu = createSettingsTakeover(ctx, { manageBaseUrl: true, proxyPort: 8787, upstreamBaseUrl: "https://api.deepseek.com" }, quiet);
    const proxyStub = { start: async () => {}, close: async () => {}, listening: () => true, port: 8787 };
    await bu.takeover(proxyStub);
    const logLen = updateLog.length;
    store.set("llm-deepseek", { baseURL: "https://user-changed.example" }); // 用户后来改了
    await bu.restore();
    check("C1b: 当前值已非我们写入 → 跳过还原", updateLog.length === logLen && store.get("llm-deepseek").baseURL === "https://user-changed.example");
  }

  // C1c: 残留自愈——代理监听失败 → 回滚还原默认直连 + 告警
  {
    const { ctx, store, updateLog } = makeMockCtx({ "llm-deepseek": { baseURL: "http://127.0.0.1:8787" } });
    const bu = createSettingsTakeover(ctx, { manageBaseUrl: true, proxyPort: 8787, upstreamBaseUrl: "https://api.deepseek.com" }, quiet);
    const proxyStub = { start: async () => { throw new Error("EADDRINUSE"); }, close: async () => {}, listening: () => false, port: 8787 };
    const st = await bu.takeover(proxyStub);
    check("C1c: 自愈失败 → 不托管", st.managed === false);
    check("C1c: 残留 baseURL 回滚为默认直连", store.get("llm-deepseek").baseURL === "https://api.deepseek.com");
    check("C1c: 自愈标记", bu.getState().selfHealed === true);
  }

  // C1d: 命名空间未就绪 → internal/service 事件重试后成功
  {
    const { ctx, store } = makeMockCtx({}); // llm-deepseek 未注册
    const bu = createSettingsTakeover(ctx, { manageBaseUrl: true, proxyPort: 8787, upstreamBaseUrl: "https://api.deepseek.com" }, quiet);
    const proxyStub = { start: async () => {}, close: async () => {}, listening: () => true, port: 8787 };
    const st = await bu.takeover(proxyStub);
    check("C1d: 命名空间未就绪 → 暂未接管", st.managed === false);
    store.set("llm-deepseek", { baseURL: "https://api.deepseek.com" }); // 命名空间就绪
    ctx.emit("internal/service", "llm-deepseek"); // 事件触发重试
    await new Promise((r) => setTimeout(r, 20)); // 等异步 tryNow 完成
    check("C1d: 事件重试后接管成功", bu.getState().managed === true && store.get("llm-deepseek").baseURL === "http://127.0.0.1:8787");
    await bu.restore(); // 清理定时器
  }

  // C1e: manageBaseUrl=false → 不接管
  {
    const { ctx, store, updateLog } = makeMockCtx({ "llm-deepseek": { baseURL: "https://api.deepseek.com" } });
    const bu = createSettingsTakeover(ctx, { manageBaseUrl: false, proxyPort: 8787, upstreamBaseUrl: "https://custom.example" }, quiet);
    const proxyStub = { start: async () => {}, close: async () => {}, listening: () => true, port: 8787 };
    const st = await bu.takeover(proxyStub);
    check("C1e: manageBaseUrl=false 不接管", st.managed === false && st.upstream === "https://custom.example" && updateLog.length === 0);
  }
}

console.log("\nPart C2 — routes /tokens 与 /status（IMP-5，本地自测：mock ctx）");
{

  const routes = new Map();
  const webServer = { register: (opts) => routes.set(opts.path, opts.handler) };
  // effect 必须立即调用注册回调（cordis 语义），否则路由永不注册
  const ctx = { get: (k) => (k === "webServer" ? webServer : undefined), on: () => {}, effect: (fn) => { fn(); return () => {}; } };
  const baseurlStub = { getState: () => ({ managed: true, original: "https://api.deepseek.com", current: "http://127.0.0.1:8787", selfHealed: false }) };
  const proxyStub = { port: 8787, listening: () => true };
  const configStub = { topLogprobs: 2, modelGlob: "deepseek-*", ringSize: 20, ringTtlMs: 3600000, upstreamBaseUrl: "https://api.deepseek.com" };

  function callHandler(path, url) {
    const handler = routes.get(path);
    return new Promise((resolve) => {
      let status = 200;
      let bodyText = "";
      const res = {
        writeHead: (s) => { status = s; },
        end: (b) => { bodyText = b; resolve({ status, body: JSON.parse(b) }); },
      };
      handler({ url }, res);
    });
  }

  // 命中（已关联）
  {
    const capture = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
    const e = createEntry({ id: "req-hit", sessionId: "sess", model: "deepseek-v4-flash" });
    e.complete = true;
    e.reasoningState = "present";
    e.blocks[0].tokens.push({ index: 0, text: "深", logprob: -0.03, top: [{ token: "圳", logprob: -1.89 }] });
    e.usage = { inputTokens: 10, outputTokens: 4, reasoningTokens: 1 };
    capture.store(e);
    capture.attach("sess", { turn: 1, step: 2, messageId: "msg-1", usage: null });
    registerRoutes(ctx, { capture, baseurl: baseurlStub, proxy: proxyStub, config: configStub }, quiet);
    const r = await callHandler(`${BASE}/tokens`, `${BASE}/tokens?session=sess&turn=1&step=2`);
    check("C2: /tokens 命中 captured:true", r.status === 200 && r.body.captured === true);
    check("C2: key/reasoningState/usage/blocks 齐全", r.body.key.turn === 1 && r.body.reasoningState === "present" && r.body.usage.outputTokens === 4 && r.body.blocks[0].tokens[0].text === "深");
    check("C2: confidence=exp(logprob)", Math.abs(r.body.blocks[0].tokens[0].confidence - Math.exp(-0.03)) < 1e-4);
    check("C2: message.id 来自 assoc", r.body.message.id === "msg-1");
  }

  // assoc-pending：FIFO 有完整条目但未关联
  {
    const capture = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
    const e = createEntry({ id: "req-pending", sessionId: "sess2", model: "deepseek-v4-flash" });
    e.complete = true;
    capture.store(e); // 未 attach
    registerRoutes(ctx, { capture, baseurl: baseurlStub, proxy: proxyStub, config: configStub }, quiet);
    const r = await callHandler(`${BASE}/tokens`, `${BASE}/tokens?session=sess2&turn=1&step=0`);
    check("C2: assoc-pending 返回 captured:false + notCapturedReason", r.body.captured === false && r.body.notCapturedReason === "assoc-pending");
  }

  // not-found
  {
    const capture = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
    registerRoutes(ctx, { capture, baseurl: baseurlStub, proxy: proxyStub, config: configStub }, quiet);
    const r = await callHandler(`${BASE}/tokens`, `${BASE}/tokens?session=none&turn=1&step=0`);
    check("C2: not-found 返回 captured:false", r.body.captured === false && r.body.notCapturedReason === "not-found");
  }

  // 参数校验
  {
    const capture = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
    registerRoutes(ctx, { capture, baseurl: baseurlStub, proxy: proxyStub, config: configStub }, quiet);
    const r = await callHandler(`${BASE}/tokens`, `${BASE}/tokens?session=sess&turn=1`);
    check("C2: 缺 step → 400 missing-param", r.status === 400 && r.body.error === "missing-param" && r.body.param === "step");
  }

  // /status
  {
    const capture = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
    registerRoutes(ctx, { capture, baseurl: baseurlStub, proxy: proxyStub, config: configStub }, quiet);
    const r = await callHandler(`${BASE}/status`, `${BASE}/status`);
    check("C2: /status ok + proxy.listening + upstream 实际值", r.status === 200 && r.body.ok === true && r.body.proxy.listening === true && r.body.proxy.upstream === "https://api.deepseek.com");
    check("C2: /status baseUrl/capture/config 字段", r.body.baseUrl.managed === true && r.body.capture.ringSize === 20 && r.body.config.topLogprobs === 2);
  }
}

console.log("\nPart C3 — assoc 事件形状兼容 + FIFO 顺序（IMP-3/IMP-5，本地自测：mock ctx）");
{


  // C3a: event.data 形状 + FIFO 顺序
  {
    const capture = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
    for (let i = 1; i <= 2; i++) {
      const e = createEntry({ id: `req-f${i}`, sessionId: "sess", model: "deepseek-v4-flash" });
      e.complete = true;
      capture.store(e);
    }
    const { ctx } = makeMockCtx({});
    createAssociator(ctx, capture, quiet, { debug: false });
    ctx.emit("session/event", { id: "sess" }, { type: "assistant/message", data: { turn: 2, step: 3, message: { id: "m2" }, usage: { prompt_tokens: 5 } } });
    ctx.emit("session/event", { id: "sess" }, { type: "assistant/message", data: { turn: 2, step: 4, message: { id: "m3" } } });
    check("C3a: FIFO 顺序——第一条事件关联 req-f1", capture.query("sess", 2, 3)?.id === "req-f1");
    check("C3a: 第二条事件关联 req-f2", capture.query("sess", 2, 4)?.id === "req-f2");
  }

  // C3b: 事件根字段形状（无 event.data）
  {
    const capture = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
    const e = createEntry({ id: "req-root", sessionId: "sess", model: "deepseek-v4-flash" });
    e.complete = true;
    capture.store(e);
    const { ctx } = makeMockCtx({});
    createAssociator(ctx, capture, quiet, { debug: false });
    ctx.emit("session/event", { id: "sess" }, { type: "assistant/message", turn: 4, step: 1, message: { id: "m4" } });
    check("C3b: 事件根字段形状也能关联", capture.query("sess", 4, 1)?.id === "req-root");
  }

  // C3c: debug 开关——首次事件打印脱敏形状（不含对话正文）
  {
    const capture = createCaptureStore({ ringSize: 20, ringTtlMs: 3600_000 }, quiet);
    const e = createEntry({ id: "req-dbg", sessionId: "sess", model: "deepseek-v4-flash" });
    e.complete = true;
    capture.store(e);
    const infos = [];
    const logger = { ...quiet, info: (m) => infos.push(m) };
    const { ctx } = makeMockCtx({});
    createAssociator(ctx, capture, logger, { debug: true });
    ctx.emit("session/event", { id: "sess" }, {
      type: "assistant/message",
      data: { turn: 6, step: 0, message: { id: "m6", content: [{ kind: "text", text: "机密对话内容不应出现" }] }, usage: {} },
    });
    check("C3c: debug 打印一次事件形状", infos.length === 1 && infos[0].includes("assoc[debug]"));
    check("C3c: 打印内容已脱敏（不含正文）", !infos[0].includes("机密对话内容不应出现") && infos[0].includes("1 blocks"));
    check("C3c: debug 下关联仍正常", capture.query("sess", 6, 0)?.id === "req-dbg");
  }
}

/* ================================================================== *
 * Part D — client-utils 纯函数单测（M3，无 DOM）
 * ================================================================== */

console.log("\nPart D — client-utils（M3 纯函数，本地自测）");
{
  // 色阶（README §7.1：hue = 240° × clamp(1 + logprob/10, 0, 1)）
  check("D: logprobToHue(0)=240（蓝）", logprobToHue(0) === 240);
  check("D: logprobToHue(-10)=0（红）", logprobToHue(-10) === 0);
  check("D: logprobToHue(-5)=120（绿）", logprobToHue(-5) === 120);
  check("D: logprobToHue 下钳制（-50→0）", logprobToHue(-50) === 0);
  check("D: logprobToHue 上钳制（+5→240）", logprobToHue(5) === 240);
  check("D: logprobToHue(null)=null（灰）", logprobToHue(null) === null);
  check("D: tokenHue 无 logprob 灰", tokenHue({ text: "x" }) === null);

  // 格式化
  check("D: formatConfidence(0.969)=96.9%", formatConfidence(0.969) === "96.9%");
  check("D: formatConfidence(1e-8)=≈1.0e-8", formatConfidence(1e-8) === "≈1.0e-8");
  check("D: formatConfidence(null)=—", formatConfidence(null) === "—");
  check("D: formatLogprob(-0.0312)≈-0.031", formatLogprob(-0.0312) === "-0.031");
  check("D: formatLogprob(1.3e-8) 指数记法", formatLogprob(1.3e-8) === "1.30e-8");

  // 最小可疑标记（M2 前占位）
  const lowConf = isSuspiciousToken({ text: "x", logprob: -3, top: [{ token: "x", logprob: -3 }, { token: "y", logprob: -5 }] });
  check("D: confidence<10% → lowConfidence", lowConf.lowConfidence === true && lowConf.hesitation === false);
  const hes = isSuspiciousToken({ text: "x", logprob: -0.2, top: [{ token: "a", logprob: -0.2 }, { token: "b", logprob: -0.25 }] });
  check("D: Top1-Top2 差距<0.1 → hesitation", hes.hesitation === true && hes.lowConfidence === false);
  const okTok = isSuspiciousToken({ text: "x", logprob: -0.03, top: [{ token: "x", logprob: -0.03 }, { token: "y", logprob: -2 }] });
  check("D: 高置信+差距大 → 不标", okTok.lowConfidence === false && okTok.hesitation === false);
  check("D: 无 logprob → 不标", isSuspiciousToken({ text: "x" }).lowConfidence === false);

  // Top-N 条形图
  const bars = topBarData([{ token: "深", logprob: -0.03 }, { token: "圳", logprob: -1.89 }, { token: "x", logprob: -9999 }]);
  check("D: topBarData 长度与顺序", bars.length === 3 && bars[0].token === "深" && bars[2].token === "x");
  check("D: 宽度=相对占比（最高者 100%）", bars[0].widthPct === 100 && bars[1].widthPct < 100 && bars[1].widthPct > 0);
  check("D: -9999 哨兵 → 概率 0 → 宽度 0", bars[2].widthPct === 0);
  check("D: topBarData([])=[]", topBarData([]).length === 0);

  // 原因文案
  check("D: capturedReasonText(assoc-pending) 非空", capturedReasonText("assoc-pending").includes("assoc-pending"));
  check("D: capturedReasonText(null)=null", capturedReasonText(null) === null);
  check("D: reasoningStateText(present) 说明不标记", reasoningStateText("present").includes("不标记"));

  // turnTail key 推导（合成 TurnLocation：steps[].data 为 Map，同 ui-conversation 结构）
  const turn = {
    steps: [
      { step: 0, data: new Map([["assistant-step", { finalNode: { turn: 25, step: 0, messageId: "m-old", seq: 10, blocks: [{ kind: "text", text: "旧" }] } }]]) },
      { step: 1, data: new Map([["assistant-step", { finalNode: { turn: 25, step: 1, messageId: "m-final", seq: 20, blocks: [{ kind: "text", text: "   " }] } }]]) }, // 无实质文本 → 跳过
      { step: 2, data: new Map([["assistant-step", { finalNode: { turn: 25, step: 2, messageId: "m-last", seq: 30, blocks: [{ kind: "text", text: "最终答案" }] } }]]) },
    ],
  };
  const key = findClosingAssistantStep(turn);
  check("D: findClosingAssistantStep 取含文本的最后一步", key.turn === 25 && key.step === 2 && key.messageId === "m-last" && key.seq === 30);
  check("D: findClosingAssistantStep 空输入 → null", findClosingAssistantStep(null) === null && findClosingAssistantStep({ steps: [] }) === null);
}

console.log("\nPart D2 — M3.5 渲染纯函数（token 匹配 / 代码着色 / mdast 渲染器，本地自测）");
{
  // 代码 token 判定（README §6.3：数字/标识符上色，语法符号永不）
  check("D2: 标识符命中", isCodeIdentifier("getUserById") && isCodeIdentifier("_tmp") && isCodeIdentifier("$x") && !isCodeIdentifier("("));
  check("D2: 数字命中", isCodeNumber("2024") && isCodeNumber("3.2.1") && isCodeNumber("-5") && !isCodeNumber("abc"));
  check("D2: 语法符号不命中", isCodeToken("(") === false && isCodeToken("=") === false && isCodeToken("。") === false && isCodeToken(" ") === false);
  check("D2: 关键字按标识符处理", isCodeToken("const") && isCodeToken("return"));

  // 增量 token 匹配器（M0 对齐：token 拼接 === 正文）
  {
    const m = createTokenMatcher([{ text: "深" }, { text: "圳" }, { text: "市" }]);
    const segs = m.match("深圳市");
    check("D2: 全匹配 → 3 个 token 段", segs.length === 3 && segs.every((s) => s.type === "token") && m.remaining === 0);
    check("D2: 拼接还原正文", segs.map((s) => s.value).join("") === "深圳市");

    const m2 = createTokenMatcher([{ text: "深" }, { text: "圳" }]);
    const segs2 = m2.match("a深b圳c");
    check("D2: 交错纯文本", segs2.map((s) => s.type).join(",") === "text,token,text,token,text" && segs2.map((s) => s.value).join("") === "a深b圳c");

    const m3 = createTokenMatcher([{ text: "深" }, { text: "圳" }, { text: "市" }, { text: "中" }, { text: "心" }]).setAllText("深圳市中心");
    const s1 = m3.match("深圳市");
    const s2 = m3.match("中心");
    check("D2: 跨文本段游标推进", s1.length === 3 && s2.length === 2 && m3.remaining === 0);

    const m4 = createTokenMatcher([{ text: "深" }, { text: "圳" }, { text: "市" }]).setAllText("深圳市中心");
    const s3 = m4.match("深圳");
    check("D2: token 属于后续文本 → 停止不吞并", s3.length === 2 && m4.remaining === 1);

    const m5 = createTokenMatcher([{ text: "const" }, { text: " " }, { text: "x" }, { text: "=" }, { text: "1" }]);
    const s4 = m5.match("const x = 1", { codeOnly: true });
    check("D2: 代码块保守着色（只标 const/x/1）", s4.map((s) => s.value).join("") === "const x = 1" && s4.filter((s) => s.type === "token").map((s) => s.value).join(",") === "const,x,1");
  }

  // 图片组合并
  {
    const blocks = [
      { kind: "text", text: "a" },
      { kind: "image", attachment: {} },
      { kind: "image", attachment: {} },
      { kind: "reasoning", text: "r" },
      { kind: "image", attachment: {} },
    ];
    const groups = mergeImageGroups(blocks);
    check("D2: 连续 image 合并为一组", groups.length === 2 && groups[0].length === 2 && groups[1].length === 1);
  }

  // mdast 渲染器（注入测试桩 h，纯函数验证结构）
  {
    const hStub = (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined) });
    const flattenNodes = (x) => (Array.isArray(x) ? x : x ? [x] : []);
    const tags = (x) => {
      const out = [];
      for (const n of flattenNodes(x)) {
        if (n && typeof n === "object" && n.tag) {
          out.push(n.tag);
          out.push(...tags(n.children || []));
        }
      }
      return out;
    };
    const textOf = (x) => {
      let s = "";
      for (const n of flattenNodes(x)) {
        if (typeof n === "string") s += n;
        else if (n && typeof n === "object") s += textOf(n.children || []);
      }
      return s;
    };

    const tree1 = parseMarkdown("# 标题\n\n**粗体** 与 `行内码`");
    const r1 = mdastToReact(tree1, hStub, { matcher: null }, "k");
    check("D2: mdast heading+strong+inlineCode 结构", tags(r1).includes("h1") && tags(r1).includes("strong") && tags(r1).includes("code"));

    const tree2 = parseMarkdown("```js\nconst x = 1;\n```");
    const matcher = createTokenMatcher([{ text: "const" }, { text: " " }, { text: "x" }, { text: " " }, { text: "=" }, { text: " " }, { text: "1" }, { text: ";" }]);
    const r2 = mdastToReact(tree2, hStub, { matcher, renderToken: (seg, key) => ({ tag: "span", props: { key }, children: [seg.value] }) }, "k");
    check("D2: 代码块 pre>code + 保守着色（3 个 span）", tags(r2).includes("pre") && tags(r2).includes("code") && tags(r2).filter((t) => t === "span").length === 3);

    const tree3 = parseMarkdown("| a | b |\n| - | - |\n| 1 | 2 |");
    const r3 = mdastToReact(tree3, hStub, { matcher: null }, "k");
    check("D2: GFM 表格 th/td 结构", tags(r3).includes("table") && tags(r3).includes("th") && tags(r3).includes("td"));

    const tree4 = parseMarkdown("<script>alert(1)</script>\nplain");
    const r4 = mdastToReact(tree4, hStub, { matcher: null }, "k");
    check("D2: 原始 HTML 跳过（不渲染 script）", tags(r4).includes("script") === false);
    check("D2: html 后段落保留", textOf(r4).includes("plain"));
  }
}

console.log("\nPart D3 — t15 重要项回归（真实回放 / 卡死游标 / link 白名单 / 共享缓存，本地自测）");
{
  // IMP-4①: 真实样本 matcher 回放（拼接逐字符一致 + 全消费）
  for (const [file, expectTokens] of [["docs/m0-sample-nothinking.json", 61], ["docs/m0-sample-thinking.json", 24]]) {
    const s = JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
    const toks = [];
    let text = "";
    for (const c of s.chunks) {
      const j = JSON.parse(c.raw);
      const delta = j.choices?.[0]?.delta ?? {};
      const lp = j.choices?.[0]?.logprobs;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        for (const t of lp?.content ?? []) toks.push(t.token);
        text += delta.content;
      }
    }
    const m = createTokenMatcher(toks.map((t) => ({ text: t }))).setAllText(text);
    const segs = m.match(text);
    check(`D3: ${file.split("/").pop()} 真实回放——${expectTokens} tokens 全消费`, toks.length === expectTokens && m.remaining === 0);
    check(`D3: ${file.split("/").pop()} 真实回放——拼接逐字符一致`, segs.map((x) => x.value).join("") === text);
  }

  // IMP-1 回归: 图片 markdown 字符在捕获 token 中但不在任何 text 块 → 不卡死游标
  {
    const tokens = [
      { text: "先" }, { text: "!" }, { text: "[" }, { text: "图" }, { text: "]" }, { text: "(" }, { text: "x" }, { text: ")" },
      { text: "后" }, { text: "续" }, { text: "文" }, { text: "字" },
    ];
    const allText = "先后续文字"; // text 块拼接（图片字符被抽成 image 块，不在其中）
    const m = createTokenMatcher(tokens).setAllText(allText);
    const s1 = m.match("先");
    const s2 = m.match("后续文字");
    check("D3: 图片字符 token 被跳过（不卡死游标）", s1.filter((x) => x.type === "token").map((x) => x.value).join("") === "先");
    check("D3: 图片之后的文本块仍上色", s2.filter((x) => x.type === "token").map((x) => x.value).join("") === "后续文字");
    check("D3: 全部真实 token 消费完（remaining=0）", m.remaining === 0);
  }

  // IMP-2 回归: link scheme 白名单
  {
    const hStub = (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined) });
    const flattenNodes = (x) => (Array.isArray(x) ? x : x ? [x] : []);
    const hrefs = (x) => {
      const out = [];
      for (const n of flattenNodes(x)) {
        if (n && typeof n === "object" && n.tag) {
          if (n.tag === "a" && n.props && typeof n.props.href === "string") out.push(n.props.href);
          out.push(...hrefs(n.children || []));
        }
      }
      return out;
    };
    const tBad = parseMarkdown("[x](javascript:alert(1)) 与 [y](data:text/html,hi)");
    const rBad = mdastToReact(tBad, hStub, { matcher: null }, "k");
    check("D3: javascript:/data: link 不渲染为 <a href>", hrefs(rBad).length === 0);
    const tGood = parseMarkdown("[ok](https://ok.example) 与 [mail](mailto:a@b.c)");
    const rGood = mdastToReact(tGood, hStub, { matcher: null }, "k");
    check("D3: http/mailto link 正常渲染", hrefs(rGood).length === 2 && hrefs(rGood)[0] === "https://ok.example");
  }

  // IMP-3 回归: 共享缓存（同键并发只发一次 / 结果缓存 / 失败与 assoc-pending 不缓存）
  {
    const realFetch = globalThis.fetch;
    let calls = 0;
    try {
      resetTokenCache();
      globalThis.fetch = async () => { calls++; return { status: 200, json: async () => ({ ok: true, captured: true, blocks: [] }) }; };
      const [a, b] = await Promise.all([fetchTokenData("sess-c", 1, 2), fetchTokenData("sess-c", 1, 2)]);
      check("D3: 并发同键只发一次请求", calls === 1 && a.body.captured === true && b.body.captured === true);
      const c = await fetchTokenData("sess-c", 1, 2);
      check("D3: 结果缓存命中（仍 1 次请求）", calls === 1 && c.body.captured === true);

      resetTokenCache();
      calls = 0;
      globalThis.fetch = async () => { calls++; throw new Error("boom"); };
      await fetchTokenData("sess-c", 1, 2).catch(() => {});
      await fetchTokenData("sess-c", 1, 2).catch(() => {});
      check("D3: 失败不缓存（允许重试）", calls === 2);

      resetTokenCache();
      calls = 0;
      globalThis.fetch = async () => { calls++; return { status: 200, json: async () => ({ ok: true, captured: false, notCapturedReason: "assoc-pending" }) }; };
      await fetchTokenData("sess-c", 1, 2);
      await fetchTokenData("sess-c", 1, 2);
      check("D3: assoc-pending 不缓存（每次新请求）", calls === 2);
    } finally {
      globalThis.fetch = realFetch;
      resetTokenCache();
    }
  }
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
