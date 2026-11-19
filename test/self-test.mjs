/**
 * logprobs-highlighter — 后端自测（provider 模式）
 *
 * 覆盖：wire 映射 / 请求体构造 / capture 存储 / recorder 摘要 / adapter 流映射。
 * 不依赖 dsh 运行时（dsh 的 LlmAdapter 等以 stub 注入），不需要 API key。
 *
 * 运行：npm test
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  toOpenAIMessages,
  buildRequestBody,
  toTokenUsage,
  toFinishReason,
} from "../lib/wire.js";
import { createCaptureStore, createEntry } from "../lib/capture.js";
import { createRecorder, summarize } from "../lib/recorder.js";
import { createAdapter, PROVIDER } from "../lib/provider.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Part A — wire：消息映射 / 请求体 / usage / finish
 * ------------------------------------------------------------------ */

console.log("\nPart A — wire 映射");

test("A1: system/user/assistant/tool 四类消息映射", () => {
  const out = toOpenAIMessages([
    { role: "system", content: [{ type: "text", text: "SYS" }] },
    { role: "user", content: [{ type: "text", text: "你好" }] },
    { role: "assistant", content: [{ type: "text", text: "答" }] },
    { role: "tool", toolCallId: "call_1", content: [{ type: "text", text: "结果" }] },
  ]);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { role: "system", content: "SYS" });
  assert.deepEqual(out[1], { role: "user", content: "你好" });
  assert.deepEqual(out[2], { role: "assistant", content: "答" });
  assert.deepEqual(out[3], { role: "tool", tool_call_id: "call_1", content: "结果" });
});

test("A2: developer（tool 变更）消息跳过", () => {
  const out = toOpenAIMessages([
    { role: "developer", content: [{ type: "tool-addition", toolName: "read_file" }] },
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "user");
});

test("A3: reasoning 块 → reasoning_content（多轮思考必需）", () => {
  const out = toOpenAIMessages([{
    role: "assistant",
    content: [
      { type: "reasoning", text: "先想一下" },
      { type: "text", text: "答案是 42" },
    ],
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].reasoning_content, "先想一下");
  assert.equal(out[0].content, "答案是 42");
});

test("A4: tool-call 块 → tool_calls[]（arguments 原样）", () => {
  const out = toOpenAIMessages([{
    role: "assistant",
    content: [{ type: "tool-call", id: "call_9", name: "read_file", arguments: '{"path":"a.txt"}' }],
  }]);
  assert.equal(out[0].tool_calls.length, 1);
  assert.equal(out[0].tool_calls[0].id, "call_9");
  assert.equal(out[0].tool_calls[0].function.name, "read_file");
  assert.equal(out[0].tool_calls[0].function.arguments, '{"path":"a.txt"}');
});

test("A5: 图片/文件块降级为文本占位", () => {
  const out = toOpenAIMessages([{
    role: "user",
    content: [
      { type: "text", text: "看图" },
      { type: "image", attachment: { id: "img1" } },
    ],
  }]);
  assert.equal(out.length, 1);
  assert.match(out[0].content, /看图/);
  assert.match(out[0].content, /附件/);
});

test("A6: 空 assistant 消息被跳过", () => {
  const out = toOpenAIMessages([{ role: "assistant", content: [] }]);
  assert.equal(out.length, 0);
});

test("A7: buildRequestBody 注入 logprobs / tools / thinking / stop", () => {
  const body = buildRequestBody({
    options: {
      provider: PROVIDER,
      model: "deepseek-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: "SYS",
      tools: [{ name: "read_file", description: "read", parameters: { type: "object", properties: {} } }],
      temperature: 0.3,
      maxTokens: 512,
      stop: ["END"],
      reasoningEffort: "high",
    },
    topLogprobs: 2,
    thinking: true,
  });
  assert.equal(body.model, "deepseek-flash");
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.logprobs, true);
  assert.equal(body.top_logprobs, 2);
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "high");
  assert.deepEqual(body.stop, ["END"]);
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.tools[0].function.name, "read_file");
  // system 前插
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[0].content, "SYS");
});

test("A8: 降级重试时不注入 logprobs", () => {
  const body = buildRequestBody({
    options: { provider: PROVIDER, model: "m", messages: [] },
    injectLogprobs: false,
  });
  assert.equal(body.logprobs, undefined);
  assert.equal(body.top_logprobs, undefined);
});

test("A9: toTokenUsage 扣除缓存命中（inputTokens 为非缓存输入）", () => {
  const usage = toTokenUsage({
    prompt_tokens: 1000,
    completion_tokens: 200,
    prompt_cache_hit_tokens: 600,
    prompt_cache_miss_tokens: 400,
    completion_tokens_details: { reasoning_tokens: 120 },
  });
  assert.equal(usage.inputTokens, 400);
  assert.equal(usage.outputTokens, 200);
  assert.equal(usage.cacheReadTokens, 600);
  assert.equal(usage.reasoningTokens, 120);
  assert.equal(usage.totalTokens, 1200);
});

test("A10: finish_reason 映射", () => {
  assert.deepEqual(toFinishReason("stop"), { kind: "stop" });
  assert.deepEqual(toFinishReason("tool_calls"), { kind: "tool-calls" });
  assert.deepEqual(toFinishReason("length"), { kind: "max-tokens" });
  assert.deepEqual(toFinishReason(null), { kind: "stop" });
});

/* ------------------------------------------------------------------ *
 * Part B — capture：环形缓冲 / FIFO / 关联
 * ------------------------------------------------------------------ */

console.log("\nPart B — capture 存储");

const quietLogger = { debug() {}, info() {}, warn() {} };

test("B1: store 后可按 (sessionId, turn, step) 查询", () => {
  const capture = createCaptureStore({ ringSize: 10, ringTtlMs: 60_000 }, quietLogger);
  const entry = createEntry({ id: "e1", sessionId: "s1", model: "m" });
  entry.complete = true;
  capture.store(entry);
  assert.equal(capture.pendingCount("s1"), 1);
  const attached = capture.attach("s1", { turn: 1, step: 0, messageId: "msg1", usage: null });
  assert.ok(attached);
  assert.equal(capture.query("s1", 1, 0).id, "e1");
  assert.equal(attached.assoc.messageId, "msg1");
});

test("B2: attach 跳过 aborted 条目", () => {
  const capture = createCaptureStore({ ringSize: 10, ringTtlMs: 60_000 }, quietLogger);
  const bad = createEntry({ id: "bad", sessionId: "s2", model: "m" });
  bad.complete = false;
  const good = createEntry({ id: "good", sessionId: "s2", model: "m" });
  good.complete = true;
  capture.store(bad);
  capture.store(good);
  const attached = capture.attach("s2", { turn: 2, step: 0, messageId: null, usage: null });
  assert.equal(attached.id, "good");
});

test("B3: 辅助请求（purpose）不入 FIFO，但保留在环形缓冲", () => {
  const capture = createCaptureStore({ ringSize: 10, ringTtlMs: 60_000 }, quietLogger);
  const aux = createEntry({ id: "aux", sessionId: "s3", model: "m", purpose: "compaction" });
  aux.complete = true;
  capture.store(aux);
  assert.equal(capture.pendingCount("s3"), 0);
  assert.equal(capture.stats().entries, 1);
  assert.equal(capture.list(5).length, 1);
});

test("B4: list 返回新→旧", () => {
  const capture = createCaptureStore({ ringSize: 10, ringTtlMs: 60_000 }, quietLogger);
  for (const id of ["a", "b", "c"]) {
    const e = createEntry({ id, sessionId: "s4", model: "m" });
    capture.store(e);
  }
  const ids = capture.list(3).map((e) => e.id);
  assert.deepEqual(ids, ["c", "b", "a"]);
});

test("B5: 超过 ringSize 先到先淘汰，并同步清 FIFO", () => {
  const capture = createCaptureStore({ ringSize: 2, ringTtlMs: 60_000 }, quietLogger);
  for (const id of ["a", "b", "c"]) {
    const e = createEntry({ id, sessionId: "s5", model: "m" });
    e.complete = true;
    capture.store(e);
  }
  assert.equal(capture.stats().entries, 2);
  const attached = capture.attach("s5", { turn: 1, step: 0, messageId: null, usage: null });
  assert.equal(attached.id, "b"); // a 已被淘汰并从 FIFO 移除
});

test("B6: 模型黑名单", () => {
  const capture = createCaptureStore({}, quietLogger);
  assert.equal(capture.isSupported("m1"), true);
  capture.markUnsupported("m1");
  assert.equal(capture.isSupported("m1"), false);
});

/* ------------------------------------------------------------------ *
 * Part C — recorder：摘要统计
 * ------------------------------------------------------------------ */

console.log("\nPart C — recorder 摘要");

function makeEntryWithTokens(tokens) {
  const entry = createEntry({ id: "r1", sessionId: "s", model: "m" });
  entry.blocks[0].text = "abc";
  entry.blocks[0].tokens = tokens;
  entry.usage = { inputTokens: 10, outputTokens: 3 };
  return entry;
}

test("C1: 低置信计数（<10% / <1%）", () => {
  const entry = makeEntryWithTokens([
    { text: "a", logprob: Math.log(0.99), top: [] },
    { text: "b", logprob: Math.log(0.05), top: [] },
    { text: "c", logprob: Math.log(0.005), top: [] },
  ]);
  const s = summarize(entry);
  assert.equal(s.counts.textTokens, 3);
  assert.equal(s.counts.lowConfidence10, 2);
  assert.equal(s.counts.lowConfidence1, 1);
  assert.equal(s.textChars, 3);
});

test("C2: -9999 哨兵单独计数，不参与最低值", () => {
  const entry = makeEntryWithTokens([
    { text: "a", logprob: -0.01, top: [] },
    { text: "b", logprob: -9999, top: [] },
  ]);
  const s = summarize(entry);
  assert.equal(s.counts.sentinel, 1);
  assert.equal(s.minLogprob, -0.01);
  assert.equal(s.counts.lowConfidence10, 0);
});

test("C3: 落盘 JSONL（全量 + 摘要）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lph-test-"));
  try {
    const recorder = createRecorder({ outputDir: dir, recordFull: true, maxFileBytes: 1024 * 1024, keepFiles: 2 }, quietLogger);
    const entry = makeEntryWithTokens([{ text: "a", logprob: -0.1, top: [] }]);
    entry.complete = true;
    recorder.record(entry);
    await recorder.close();
    const full = await readFile(join(dir, "captures.jsonl"), "utf8");
    const summary = await readFile(join(dir, "summary.jsonl"), "utf8");
    assert.equal(full.trim().split("\n").length, 1);
    assert.equal(summary.trim().split("\n").length, 1);
    const parsed = JSON.parse(full.trim());
    assert.equal(parsed.id, "r1");
    assert.equal(parsed.blocks[0].tokens.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Part D — adapter：SSE → StreamChunk + 采集
 * ------------------------------------------------------------------ */

console.log("\nPart D — adapter 流映射");

/** 用固定 SSE 文本构造 ReadableStream。 */
function sseBody(events) {
  const text = `${events.map((e) => `data: ${JSON.stringify(e)}

`).join("")}data: [DONE]

`;
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** 测试用 platform（stub 掉 dsh 依赖）。 */
class FakeLlmError extends Error {
  constructor(message, code, options) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.failure = { message, code, ...(options ?? {}) };
  }
}

const platform = {
  LlmAdapter: class {},
  LlmError: FakeLlmError,
  attributionHeaders: () => ({ "user-agent": "lph-test" }),
  credentialRef: (value) => value,
};

const fakeCtx = {
  get: (name) => (name === "credentials"
    ? { resolve: async () => ({ value: "sk-test-key" }) }
    : undefined),
};

function baseConfig(overrides = {}) {
  return {
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: [{ id: "deepseek-flash", name: "Flash", description: "" }],
    topLogprobs: 2,
    thinking: true,
    reasoningEffort: "high",
    maxTokens: 512,
    defaultContextWindow: 1000,
    ringSize: 10,
    ringTtlMs: 60_000,
    recordFull: false,
    ...overrides,
  };
}

function makeOptions(overrides = {}) {
  return {
    provider: PROVIDER,
    model: "deepseek-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    sessionId: "sess-test",
    ...overrides,
  };
}

async function collect(iterable) {
  const chunks = [];
  for await (const c of iterable) chunks.push(c);
  return chunks;
}

await testAsync("D1: reasoning + text 双段 → 两个块 + 采集双字段 logprobs", async () => {
  const capture = createCaptureStore({ ringSize: 10, ringTtlMs: 60_000 }, quietLogger);
  const recorded = [];
  const recorder = { record: (e) => recorded.push(e) };
  const adapter = createAdapter({
    ctx: fakeCtx,
    config: baseConfig(),
    capture,
    recorder,
    logger: quietLogger,
    platform,
  });

  const sse = sseBody([
    { choices: [{ delta: { reasoning_content: "我想" }, logprobs: { reasoning_content: [{ token: "我", logprob: -0.1, top_logprobs: [] }, { token: "想", logprob: -0.2, top_logprobs: [] }] } }] },
    { choices: [{ delta: { content: "你好" }, logprobs: { content: [{ token: "你", logprob: -0.01, top_logprobs: [{ token: "你", logprob: -0.01 }] }, { token: "好", logprob: -0.02, top_logprobs: [] }] } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 12, completion_tokens_details: { reasoning_tokens: 2 } } },
  ]);

  const originalFetch = globalThis.fetch;
  let sentBody = null;
  let sentHeaders = null;
  globalThis.fetch = async (url, init) => {
    sentBody = JSON.parse(init.body);
    sentHeaders = init.headers;
    return { ok: true, status: 200, body: sse, headers: new Headers({ "content-type": "text/event-stream" }) };
  };

  try {
    const chunks = await collect(adapter.stream(makeOptions()));
    const types = chunks.map((c) => c.type);

    // 块顺序：reasoning → text → block-end ×2 → usage → finish
    assert.equal(types.filter((t) => t === "block-start").length, 2);
    assert.equal(types.filter((t) => t === "block-end").length, 2);
    assert.equal(types[types.length - 2], "usage");
    assert.equal(types[types.length - 1], "finish");
    assert.deepEqual(chunks[chunks.length - 1].reason, { kind: "stop" });

    // 请求注入了 logprobs，且带凭证头
    assert.equal(sentBody.logprobs, true);
    assert.equal(sentBody.top_logprobs, 2);
    assert.equal(sentHeaders["x-api-key"], "sk-test-key");
    assert.equal(sentHeaders["user-agent"], "lph-test");

    // 采集：双字段都进了对应 blocks
    assert.equal(recorded.length, 1);
    const entry = recorded[0];
    assert.equal(entry.blocks[0].tokens.length, 2); // text
    assert.equal(entry.blocks[1].tokens.length, 2); // reasoning
    assert.equal(entry.blocks[0].text, "你好");
    assert.equal(entry.blocks[1].text, "我想");
    assert.equal(entry.reasoningState, "present");
    assert.equal(entry.complete, true);
    assert.equal(entry.usage.inputTokens, 12);
    assert.equal(entry.usage.reasoningTokens, 2);
    // 捕获进 store（可被 assoc 关联）
    assert.equal(capture.pendingCount("sess-test"), 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await testAsync("D2: tool_calls → tool-call 块 + argumentsDelta 累积", async () => {
  const capture = createCaptureStore({}, quietLogger);
  const recorded = [];
  const adapter = createAdapter({
    ctx: fakeCtx,
    config: baseConfig(),
    capture,
    recorder: { record: (e) => recorded.push(e) },
    logger: quietLogger,
    platform,
  });

  const sse = sseBody([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, body: sse, headers: new Headers() });
  try {
    const chunks = await collect(adapter.stream(makeOptions()));
    const deltas = chunks.filter((c) => c.type === "tool-call-delta");
    assert.equal(deltas.length, 2);
    assert.equal(deltas[0].id, "call_1");
    assert.equal(deltas[0].name, "read_file");
    assert.equal(deltas[0].argumentsDelta, '{"pa');
    const end = chunks.find((c) => c.type === "block-end");
    assert.equal(end.block.type, "tool-call");
    assert.equal(end.block.name, "read_file");
    assert.equal(end.block.arguments, '{"path":"a"}');
    assert.deepEqual(chunks[chunks.length - 1].reason, { kind: "tool-calls" });
    assert.equal(recorded[0].blocks[2].tokens.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await testAsync("D3: 400 + logprobs 关键字 → 去掉注入重试一次并记黑名单", async () => {
  const capture = createCaptureStore({}, quietLogger);
  const recorded = [];
  const adapter = createAdapter({
    ctx: fakeCtx,
    config: baseConfig(),
    capture,
    recorder: { record: (e) => recorded.push(e) },
    logger: quietLogger,
    platform,
  });

  const bodies = [];
  const sse = sseBody([
    { choices: [{ delta: { content: "ok" }, logprobs: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);

  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    call += 1;
    if (call === 1) {
      return {
        ok: false,
        status: 400,
        clone() { return this; },
        text: async () => '{"error":{"message":"logprobs is not supported for this model"}}',
        headers: new Headers(),
      };
    }
    return { ok: true, status: 200, body: sse, headers: new Headers() };
  };

  try {
    const chunks = await collect(adapter.stream(makeOptions()));
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].logprobs, true);
    assert.equal(bodies[1].logprobs, undefined);
    assert.equal(capture.isSupported("deepseek-flash"), false);
    assert.equal(chunks[chunks.length - 1].type, "finish");
    // 降级后仍产生捕获（只是没有 logprobs）
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].blocks[0].tokens.length, 0);
    assert.equal(recorded[0].blocks[0].text, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await testAsync("D4: 非 logprobs 的 500 → 抛 LlmError 且条目 complete=false", async () => {
  const capture = createCaptureStore({}, quietLogger);
  const recorded = [];
  const adapter = createAdapter({
    ctx: fakeCtx,
    config: baseConfig(),
    capture,
    recorder: { record: (e) => recorded.push(e) },
    logger: quietLogger,
    platform,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => "upstream boom",
    headers: new Headers(),
  });
  try {
    let caught = null;
    try {
      await collect(adapter.stream(makeOptions()));
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "应当抛错");
    assert.equal(caught.code, "SERVER");
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].complete, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await testAsync("D5: 缺凭证 → MISSING_CREDENTIAL", async () => {
  const adapter = createAdapter({
    ctx: { get: () => undefined },
    config: baseConfig({ apiKeyEnv: "NOT_SET_LPH_TEST" }),
    capture: createCaptureStore({}, quietLogger),
    recorder: { record() {} },
    logger: quietLogger,
    platform,
  });
  delete process.env.NOT_SET_LPH_TEST;
  let caught = null;
  try {
    await collect(adapter.stream(makeOptions()));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "应当抛错");
  assert.equal(caught.code, "MISSING_CREDENTIAL");
});

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.err.stack}`);
  process.exitCode = 1;
}