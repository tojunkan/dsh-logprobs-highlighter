#!/usr/bin/env node
/**
 * ============================================================================
 * M0 数据验证脚本：DeepSeek 流式 logprobs 探测（m0-probe.mjs）
 * ----------------------------------------------------------------------------
 * 目的：实测 DeepSeek API 在 stream:true + logprobs:true 下的真实行为，
 *       回答 README v3 的开放问题与 docs/research-api-logprobs.md §7 的
 *       未确认项（chunk 分块粒度 / delta 文本与 logprobs 数组的对齐 /
 *       reasoning 段是否带 logprobs / 首 chunk 形态 / 400-422 错误响应体 /
 *       带宽放大倍数 / bytes 编码 等）。
 *
 * 【2026-08-20 实测结论（deepseek-v4-flash，top_logprobs=2，max_tokens=800，真实 key）】
 *   ① 思考模式（默认）—— docs/m0-sample-thinking.json（231 chunks）：
 *      - reasoning 段 logprobs 存在：`logprobs.reasoning_content[]`，205 tokens
 *        （1 token/chunk，delta.reasoning_content↔logprobs.reasoning_content 对齐 100%）。
 *      - **content 段同样带 logprobs**：`logprobs.content[]`，24 tokens（1 token/chunk，
 *        对齐 24/24）；content chunk 的 delta 形如 {"content":"202","reasoning_content":null}
 *        —— reasoning_content 键存在但为 null，分类必须以"非空 content"优先。
 *      - 带宽放大 x1.797（原始 121830 B / 剥皮 67798 B）。
 *   ② 关闭思考（--no-thinking）—— docs/m0-sample-nothinking.json（63 chunks）：
 *      - 61 个 content token 全部带 logprobs（1 token/chunk，对齐 61/61，bytes 校验 0 不一致）。
 *      - 带宽放大 x1.884（原始 32207 B / 剥皮 17091 B）。
 *   ③ 两模式共同点：首 chunk 均 role-only（logprobs: null）；usage 在末尾 chunk；无解析错误；
 *      思考模式消耗绝大部分 max_tokens 额度（200 时 content 段出不来，故默认 800）。
 *   => 本脚本对 `logprobs.content` 与 `logprobs.reasoning_content` 双字段各自独立统计
 *      （存在性 / 条目数 / 对齐 / bytes 校验 / 带宽）。
 *
 * 实测采样档案（docs/，真实 API 数据，含每 chunk 原始 raw 串）：
 *   - m0-sample.json            最近一次运行输出（自动覆盖）
 *   - m0-sample-thinking.json   思考模式实测（默认）
 *   - m0-sample-nothinking.json 关闭思考实测（--no-thinking）
 *   用途：M2 标记引擎开发与带宽/对齐决策的基准数据。
 *
 * 环境要求：Node.js >= 20（内置 fetch，零第三方依赖）。
 *
 * 用法示例：
 *   # 基础用法：默认 top_logprobs=2（问卷决策档）
 *   export DEEPSEEK_API_KEY=sk-你的密钥
 *   node scripts/m0-probe.mjs
 *
 *   # 低带宽档 + 打印前 10 个原始 chunk
 *   node scripts/m0-probe.mjs --top 2 --raw
 *
 *   # 测试思考模式（deepseek-v4-pro）
 *   DSH_M0_MODEL=deepseek-v4-pro node scripts/m0-probe.mjs --top 2
 *
 *   # 关闭思考模式（直测 content 段 logprobs；思考模式会先耗 max_tokens 额度）
 *   node scripts/m0-probe.mjs --no-thinking --top 2
 *
 *   # 指向本地反代（M1 联调）或自定义上游
 *   DSH_M0_BASE_URL=http://127.0.0.1:8787 node scripts/m0-probe.mjs
 *
 *   # 自定义提示词 / 输出上限
 *   node scripts/m0-probe.mjs --prompt "北京的邮政编码是多少？" --max-tokens 800
 *
 *   # 回放模式：不请求 API、不需要 DEEPSEEK_API_KEY；读取 sample 内 chunks[].raw，
 *   # 用与真实运行完全相同的 classifySegment/统计/带宽逻辑重算内嵌 summary 并写回
 *   # 原文件（raw 保持原样；用于修正旧分类器生成的过期 summary）。
 *   node scripts/m0-probe.mjs --replay docs/m0-sample-thinking.json
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY  必填（仅实时模式；--replay 模式不需要）
 *   DSH_M0_BASE_URL   上游 base URL，默认 https://api.deepseek.com（自动去尾部 /）
 *   DSH_M0_MODEL      模型 ID，默认 deepseek-v4-flash（可换 deepseek-v4-pro）
 *
 * 输出：
 *   - 终端：中文汇总表（双字段 logprobs / 分块粒度 / 对齐 / reasoning 占比 /
 *     带宽放大 / usage）
 *   - docs/m0-sample.json：完整原始采样（每 chunk 的原始 data 字符串 raw +
 *     解析后关键字段，含 tokensContent / tokensReasoning），供 M2 标记引擎
 *     开发复用。
 * ============================================================================
 */

import { writeFile, mkdir, readFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.resolve(SCRIPT_DIR, "..", "docs", "m0-sample.json");

const DEFAULT_PROMPT =
  "请回答：OpenAI GPT-4 于 2023 年 3 月发布，DeepSeek-V3 于 2024 年 12 月发布。" +
  "请问 2024 年中国新能源汽车销量约为多少万辆？请给出具体数字。";

/* ------------------------------------------------------------------ *
 * 1. 命令行参数与环境变量
 * ------------------------------------------------------------------ */

function printUsage() {
  console.log(`
用法: node scripts/m0-probe.mjs [选项]

选项:
  --top N           top_logprobs 取值（0/2/5/20，默认 2；问卷决策用 2，带宽压力测试用 5）
  --prompt "..."    自定义查询（默认: 含数字+API 名的中文事实查询）
  --max-tokens N    输出 token 上限（默认 800；思考模式会先耗额度，200 时 content 段出不来）
  --no-thinking     请求体追加 {"thinking":{"type":"disabled"}}，关闭思考模式，直测 content 段
  --raw             打印前 10 个原始 chunk（每个截断 300 字符）
  --replay <file>   回放模式: 读 sample 内 chunks[].raw，用当前逻辑重算内嵌 summary 并写回
                    （不请求 API、不需要 DEEPSEEK_API_KEY；raw 字段保持原样）
  -h, --help        显示本帮助

环境变量:
  DEEPSEEK_API_KEY  必填（实时模式）
  DSH_M0_BASE_URL   上游 base URL（默认 https://api.deepseek.com）
  DSH_M0_MODEL      模型（默认 deepseek-v4-flash；可换 deepseek-v4-pro 测思考模式）

示例:
  export DEEPSEEK_API_KEY=sk-xxxx
  node scripts/m0-probe.mjs --top 2
  node scripts/m0-probe.mjs --no-thinking --top 2 --raw --prompt "上海的邮编是多少？"
  node scripts/m0-probe.mjs --replay docs/m0-sample-thinking.json
  DSH_M0_MODEL=deepseek-v4-pro node scripts/m0-probe.mjs --top 2
`);
}

function parseArgs(argv) {
  const opts = { top: 2, prompt: null, maxTokens: 800, noThinking: false, raw: false, replay: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--top": {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v < 0 || v > 20) {
          console.error("错误: --top 必须是 0..20 的整数（问卷决策档 2，带宽压力档 5）");
          process.exit(2);
        }
        if (![0, 2, 5, 20].includes(v)) {
          console.warn(`警告: --top ${v} 不在标准档位 {0,2,5,20} 内，按原值发送（用于探索性测试）`);
        }
        opts.top = v;
        break;
      }
      case "--prompt": {
        const v = argv[++i];
        if (v === undefined) { console.error("错误: --prompt 缺少参数值"); process.exit(2); }
        opts.prompt = v;
        break;
      }
      case "--max-tokens": {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v <= 0) { console.error("错误: --max-tokens 必须是正整数"); process.exit(2); }
        opts.maxTokens = v;
        break;
      }
      case "--no-thinking":
        opts.noThinking = true;
        break;
      case "--raw":
        opts.raw = true;
        break;
      case "--replay": {
        const v = argv[++i];
        if (v === undefined) { console.error("错误: --replay 缺少参数值（应为 sample 文件路径）"); process.exit(2); }
        opts.replay = v;
        break;
      }
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
      default:
        console.error(`未知参数: ${a}`);
        printUsage();
        process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// —— 环境变量（实时模式必填 key；--replay 模式不需要） ——
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!opts.replay && (!apiKey || !apiKey.trim())) {
  console.error("错误：缺少环境变量 DEEPSEEK_API_KEY。");
  console.error("请先设置密钥再运行，例如：");
  console.error("  export DEEPSEEK_API_KEY=sk-你的密钥");
  console.error("  node scripts/m0-probe.mjs --top 2");
  console.error("（--replay 回放模式不需要密钥）");
  process.exit(1);
}
const baseUrl = (process.env.DSH_M0_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const model = process.env.DSH_M0_MODEL || "deepseek-v4-flash";
const prompt = opts.prompt || DEFAULT_PROMPT;
const top = opts.top;
const maxTokens = opts.maxTokens;

/* ------------------------------------------------------------------ *
 * 2. 统计上下文（createStats）与累加器 —— 实时/回放共用同一套逻辑
 * ------------------------------------------------------------------ */

const newSeg = () => ({
  chunks: 0,
  deltaChars: 0,
  // 本段 logprobs 字段状态（content 段 → logprobs.content，reasoning 段 → logprobs.reasoning_content）
  lpFieldChunks: 0,    // 字段存在（对象或 null）
  lpNullChunks: 0,     // 字段为 null
  lpMissingChunks: 0,  // 字段缺失（key 不存在）
  lpEmptyArrays: 0,    // 字段存在且为空数组
  lpChunks: 0,         // 字段为数组且条目 > 0
  lpTokens: 0,         // logprobs 条目总数
  otherFieldPresent: 0, // 另一字段在本段 chunk 中出现次数（如 reasoning 段里出现 logprobs.content）
  // 对齐: 本段 delta 文本 ↔ 本段 logprobs 数组
  alignExact: 0, alignDiff: 0,
  singleExact: 0, singleDiff: 0,
  multiChunks: 0,
  // bytes ↔ token 校验
  bytesChecked: 0, bytesMismatch: 0,
});

function createStats() {
  return {
    segs: { content: newSeg(), reasoning: newSeg(), "tool-call": newSeg(), other: newSeg() },
    distContent: new Map(),   // logprobs.content 条目数 -> chunk 数（content 段）
    distReasoning: new Map(), // logprobs.reasoning_content 条目数 -> chunk 数（reasoning 段）
    factorBuckets: { "<1.5": 0, "1.5-2": 0, "2-3": 0, "3-5": 0, ">=5": 0 },
    factors: [],
    totalRawBytes: 0,
    totalLeanBytes: 0,
    doneArrived: false,
    usage: null,
    usageChunks: 0,
    parseErrors: 0,
    firstChunk: null,
    chunks: [],
  };
}

/* ------------------------------------------------------------------ *
 * 3. 单个 SSE data 载荷的处理（实时与回放共用）
 * ------------------------------------------------------------------ */

function bucketFactor(f) {
  if (f < 1.5) return "<1.5";
  if (f < 2) return "1.5-2";
  if (f < 3) return "2-3";
  if (f < 5) return "3-5";
  return ">=5";
}

function fieldStatus(v) {
  // v: undefined(键缺失) | null | 数组
  return { present: v !== undefined, isNull: v === null, count: Array.isArray(v) ? v.length : 0 };
}

const mapTok = (t) => ({ token: t.token, logprob: t.logprob, bytes: t.bytes, top_logprobs: t.top_logprobs || [] });

/**
 * 段分类（tool_calls > 非空 content > 非空 reasoning > 键存在性兜底）。
 * 关键：思考模式下 content chunk 的 delta 形如 {"content":"202","reasoning_content":null}——
 * reasoning_content 键存在但值为 null，不能据此判为 reasoning（第二个 bug 的根因，
 * 曾把 24 个 content chunk 吞进 reasoning 段）。故以"非空字符串"为判定核心。
 */
function classifySegment(delta) {
  const hasContentStr = typeof delta.content === "string" && delta.content.length > 0;
  const hasReasoningStr = typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0;
  if (Array.isArray(delta.tool_calls)) return "tool-call";
  if (hasContentStr) return "text"; // 非空 content 优先（content 与 reasoning 同 chunk 时按 content 算）
  if (hasReasoningStr) return "reasoning";
  // 空内容角色宣告/过渡块：按键存在性归类（thinking 首 chunk 宣告 reasoning，no-thinking 宣告 content）
  if (delta.reasoning_content !== undefined) return "reasoning";
  if (delta.content !== undefined) return "text";
  return "other";
}

function processPayload(payload, st) {
  const seq = st.chunks.length;
  const rec = { seq, raw: payload };
  const rawBytesActual = Buffer.byteLength(payload, "utf8");
  rec.bytesRaw = rawBytesActual;

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    st.parseErrors++;
    rec.parseError = err.message;
    st.chunks.push(rec);
    return;
  }

  const choice = parsed.choices && parsed.choices[0];
  const delta = (choice && choice.delta) || {};

  // —— 段分类（非空 content 优先，见 classifySegment 注释） ——
  const roleClass = classifySegment(delta);
  rec.role = roleClass;
  const seg = roleClass === "text" ? "content" : roleClass;

  let deltaChars = 0;
  if (roleClass === "text") deltaChars = (delta.content ?? "").length;
  else if (roleClass === "reasoning") deltaChars = (delta.reasoning_content ?? "").length;
  else if (roleClass === "tool-call")
    deltaChars = (delta.tool_calls ?? []).reduce((s, tc) => s + ((tc.function && tc.function.arguments) || "").length, 0);
  rec.deltaChars = deltaChars;

  // —— logprobs 双字段（content / reasoning_content 各自独立） ——
  const lp = choice ? choice.logprobs : undefined;
  const lpIsNull = lp === null;
  const lpContent = Array.isArray(lp && lp.content) ? lp.content : null;
  const lpReasoning = Array.isArray(lp && lp.reasoning_content) ? lp.reasoning_content : null;
  rec.logprobs = {
    present: lp !== undefined,
    isNull: lpIsNull,
    content: fieldStatus(lpIsNull ? null : lp ? lp.content : undefined),
    reasoning_content: fieldStatus(lpIsNull ? null : lp ? lp.reasoning_content : undefined),
  };
  rec.tokensContent = lpContent ? lpContent.map(mapTok) : [];
  rec.tokensReasoning = lpReasoning ? lpReasoning.map(mapTok) : [];

  // —— 剥皮重序列化（与 M1 反代一致: parse → 删整个 choice.logprobs → stringify，
  //    两个字段一并剥掉；dsh 侧始终看到 lean 流） ——
  let leanBytes = rawBytesActual;
  let serializedBytes = rawBytesActual;
  try {
    const lean = JSON.parse(payload);
    if (lean.choices && lean.choices[0]) delete lean.choices[0].logprobs;
    leanBytes = Buffer.byteLength(JSON.stringify(lean), "utf8");
    serializedBytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
  } catch { /* 剥皮失败则保守取原字节数，不重试 */ }
  const factor = leanBytes > 0 ? rawBytesActual / leanBytes : 1;
  rec.bytes = { raw: rawBytesActual, lean: leanBytes, reserialized: serializedBytes, factor: Number(factor.toFixed(3)) };

  rec.finish_reason = (choice && choice.finish_reason) || null;
  rec.usage = parsed.usage || null;
  if (rec.usage) { st.usage = rec.usage; st.usageChunks++; }

  // —— 本段 logprobs 字段状态 ——
  const s = st.segs[seg];
  s.chunks++;
  s.deltaChars += deltaChars;

  const ownRaw = lpIsNull ? null : lp ? (seg === "content" ? lp.content : seg === "reasoning" ? lp.reasoning_content : undefined) : undefined;
  if (ownRaw !== undefined) {
    s.lpFieldChunks++;
    if (ownRaw === null) s.lpNullChunks++;
    else if (Array.isArray(ownRaw) && ownRaw.length === 0) s.lpEmptyArrays++;
  } else {
    s.lpMissingChunks++;
  }

  const lpArr = seg === "content" ? lpContent : seg === "reasoning" ? lpReasoning : null;
  const lpCount = lpArr ? lpArr.length : 0;
  if (lpCount > 0) { s.lpChunks++; s.lpTokens += lpCount; }

  const otherRaw = lpIsNull ? null : lp ? (seg === "content" ? lp.reasoning_content : seg === "reasoning" ? lp.content : undefined) : undefined;
  if (otherRaw !== undefined) s.otherFieldPresent++;

  // —— 分块粒度分布（本段） ——
  if (seg === "content" && lpContent) st.distContent.set(lpContent.length, (st.distContent.get(lpContent.length) || 0) + 1);
  if (seg === "reasoning" && lpReasoning) st.distReasoning.set(lpReasoning.length, (st.distReasoning.get(lpReasoning.length) || 0) + 1);

  // —— 对齐: 本段 delta 文本 ↔ 本段 logprobs 数组（token 字符串拼接对照） ——
  const deltaText = seg === "content" ? delta.content : seg === "reasoning" ? delta.reasoning_content : null;
  if ((seg === "content" || seg === "reasoning") && deltaText && lpArr && lpCount > 0) {
    const joined = lpArr.map((t) => t.token).join("");
    if (joined === deltaText) s.alignExact++;
    else s.alignDiff++;
    if (lpCount === 1) {
      if (deltaText === lpArr[0].token) s.singleExact++;
      else s.singleDiff++;
    } else {
      s.multiChunks++;
    }
  }

  // —— bytes ↔ token 校验（本段字段；t1 未确认项 8/9） ——
  const ownTokens = seg === "content" ? rec.tokensContent : seg === "reasoning" ? rec.tokensReasoning : [];
  for (const t of ownTokens) {
    if (Array.isArray(t.bytes)) {
      s.bytesChecked++;
      if (Buffer.from(t.bytes).toString("utf8") !== t.token) s.bytesMismatch++;
    }
  }

  // —— 带宽放大 ——
  st.totalRawBytes += rawBytesActual;
  st.totalLeanBytes += leanBytes;
  st.factors.push(factor);
  st.factorBuckets[bucketFactor(factor)]++;

  // —— 首 chunk 形态 ——
  if (!st.firstChunk) {
    st.firstChunk = {
      role: delta.role ?? null,
      roleClass,
      delta: {
        content: delta.content ?? null,
        reasoning_content: delta.reasoning_content ?? null,
        hasToolCalls: Array.isArray(delta.tool_calls),
      },
      logprobs: rec.logprobs,
      finish_reason: rec.finish_reason,
    };
  }

  st.chunks.push(rec);
}

/* ------------------------------------------------------------------ *
 * 4. SSE 流解析（边界缓冲，容忍任意截断/CRLF；仅实时模式）
 * ------------------------------------------------------------------ */

function handleEvent(event, st) {
  const dataLines = event.split("\n").filter((l) => l.startsWith("data:"));
  if (!dataLines.length) return; // 忽略 event:/id:/retry:/注释等行
  const payload = dataLines.map((l) => l.slice(5).trim()).join("\n");
  if (payload === "[DONE]") { st.doneArrived = true; return; }
  processPayload(payload, st);
}

async function consumeStream(body, st) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const u8 of body) {
    buffer += decoder.decode(u8, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n"); // 统一 CRLF
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      handleEvent(event, st);
    }
  }
  buffer += decoder.decode(); // 冲刷多字节 UTF-8 尾巴
  buffer = buffer.replace(/\r\n/g, "\n");
  if (buffer.trim()) handleEvent(buffer, st); // 无结尾空行的最后一帧
}

/* ------------------------------------------------------------------ *
 * 5. 汇总与输出（实时/回放共用 buildComputed）
 * ------------------------------------------------------------------ */

function segConclusion(name, st) {
  const s = st.segs[name];
  if (s.chunks === 0) return "未出现该段（本次流无此角色 chunk）";
  if (s.lpChunks > 0) return "有（logprobs 条目存在）";
  if (s.lpFieldChunks > 0) return "无（logprobs 字段存在但恒为 null/空数组）";
  return "无（logprobs 字段缺失）";
}

function pct(n, d) {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—";
}

function printDistribution(obj) {
  const entries = Object.entries(obj);
  if (!entries.length) return "  无（流中没有任何 logprobs 条目）";
  const total = entries.reduce((a, [, v]) => a + v, 0);
  return entries
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, v]) => `  ${k} token/chunk: ${v} 个 (${pct(v, total)})`)
    .join("\n");
}

const mapToObj = (m) => Object.fromEntries([...m.entries()].sort((a, b) => a[0] - b[0]));

/** 由统计上下文计算 summary 的可推导部分（实时与回放共用）。 */
function buildComputed(st) {
  const segs = st.segs;
  const streamFactor = st.totalLeanBytes > 0 ? st.totalRawBytes / st.totalLeanBytes : null;
  const reasoningChars = segs.reasoning.deltaChars;
  const totalChars = segs.content.deltaChars + reasoningChars + segs["tool-call"].deltaChars + segs.other.deltaChars;
  const usageRT = st.usage
    ? (st.usage.completion_tokens_details && typeof st.usage.completion_tokens_details.reasoning_tokens === "number"
        ? st.usage.completion_tokens_details.reasoning_tokens
        : st.usage.reasoning_tokens) ?? null
    : null;
  const usageCT = st.usage ? st.usage.completion_tokens : null;
  const bCheck = {
    content: { checked: segs.content.bytesChecked, mismatch: segs.content.bytesMismatch },
    reasoning: { checked: segs.reasoning.bytesChecked, mismatch: segs.reasoning.bytesMismatch },
    total: {
      checked: segs.content.bytesChecked + segs.reasoning.bytesChecked,
      mismatch: segs.content.bytesMismatch + segs.reasoning.bytesMismatch,
    },
  };
  return {
    stream: {
      chunkTotal: st.chunks.length,
      doneArrived: st.doneArrived,
      usageChunks: st.usageChunks,
      usage: st.usage,
      firstChunk: st.firstChunk,
      parseErrors: st.parseErrors,
    },
    tokenPerChunk: { content: mapToObj(st.distContent), reasoning: mapToObj(st.distReasoning) },
    segments: {
      content: { ...segs.content },
      reasoning: { ...segs.reasoning },
      "tool-call": { ...segs["tool-call"] },
      other: { ...segs.other },
    },
    conclusions: { content: segConclusion("content", st), reasoning: segConclusion("reasoning", st) },
    reasoningShare: {
      deltaChars: { reasoning: reasoningChars, total: totalChars, ratio: totalChars ? Number((reasoningChars / totalChars).toFixed(4)) : null },
      usage: usageCT
        ? {
            completion_tokens: usageCT,
            reasoning_tokens: usageRT,
            ratio: usageRT !== null ? Number((usageRT / usageCT).toFixed(4)) : null,
          }
        : null,
    },
    amplification: {
      stream: { rawBytes: st.totalRawBytes, leanBytes: st.totalLeanBytes, factor: streamFactor !== null ? Number(streamFactor.toFixed(3)) : null },
      chunkMean: st.factors.length ? Number((st.factors.reduce((a, b) => a + b, 0) / st.factors.length).toFixed(3)) : null,
      chunkMin: st.factors.length ? Number(Math.min(...st.factors).toFixed(3)) : null,
      chunkMax: st.factors.length ? Number(Math.max(...st.factors).toFixed(3)) : null,
      chunkCount: st.factors.length,
      buckets: st.factorBuckets,
    },
    bytesCheck: bCheck,
  };
}

/** 实时模式：在 buildComputed 之上附加 meta / request。 */
function buildLiveSummary(st) {
  return {
    meta: {
      script: "scripts/m0-probe.mjs",
      ts: new Date().toISOString(),
      node: process.version,
      baseUrl, model, topLogprobs: top, maxTokens, prompt,
      thinking: opts.noThinking ? "disabled" : "default(未指定)",
    },
    request: {
      model, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true },
      logprobs: true, top_logprobs: top,
      thinking: opts.noThinking ? { type: "disabled" } : undefined,
    },
    ...buildComputed(st),
  };
}

function fmtFieldState(s) {
  return `条目>0: ${s.lpChunks} | 空数组: ${s.lpEmptyArrays} | null: ${s.lpNullChunks} | 缺失: ${s.lpMissingChunks} | 另一字段出现: ${s.otherFieldPresent}`;
}

function printSummary(s, { title = "M0 logprobs 探测汇总", savePath = SAMPLE_PATH } = {}) {
  const line = "─".repeat(62);
  const seg = s.segments;
  console.log(`\n${line}`);
  console.log(title);
  console.log(line);
  console.log(`模型        : ${s.meta.model}`);
  console.log(`上游        : ${s.meta.baseUrl}`);
  console.log(`top_logprobs: ${s.meta.topLogprobs}   max_tokens: ${s.meta.maxTokens}   thinking: ${s.meta.thinking}   include_usage: true`);
  console.log(`提示词      : ${s.meta.prompt}`);
  console.log(line);

  console.log("【流基础】");
  console.log(`  chunk 总数   : ${s.stream.chunkTotal}   [DONE] 到达: ${s.stream.doneArrived ? "是" : "否(流被截断!)"}`);
  console.log(`  usage 附着   : ${s.stream.usageChunks > 0 ? `${s.stream.usageChunks} 个 chunk 携带` : "无"}`);
  console.log(`  JSON 解析失败: ${s.stream.parseErrors}`);
  const fc = s.stream.firstChunk;
  if (fc) {
    const d = fc.delta;
    console.log(`  首 chunk 形态: role=${fc.role} class=${fc.roleClass} ` +
      `delta={content:${JSON.stringify(d.content)}, reasoning_content:${JSON.stringify(d.reasoning_content)}, tool_calls:${d.hasToolCalls}}`);
    const lp = fc.logprobs;
    console.log(`                 logprobs=${lp.present ? (lp.isNull ? "null" : `object(content:${JSON.stringify(lp.content)}, reasoning_content:${JSON.stringify(lp.reasoning_content)})`) : "缺失"}`);
  }
  console.log(line);

  console.log("【分块粒度（t1 未确认项 1，双字段分别统计）】");
  console.log("  content 段   (logprobs.content 条目数/chunk):");
  console.log(printDistribution(s.tokenPerChunk.content));
  console.log("  reasoning 段 (logprobs.reasoning_content 条目数/chunk):");
  console.log(printDistribution(s.tokenPerChunk.reasoning));
  console.log(line);

  console.log("【对齐（delta 文本 ↔ 本段 logprobs 数组）】");
  console.log(`  content 段    delta.content ↔ logprobs.content          : ${seg.content.alignExact} 一致 / ${seg.content.alignDiff} 不一致 (单token ${seg.content.singleExact}/${seg.content.singleDiff}, 多token chunk ${seg.content.multiChunks})`);
  console.log(`  reasoning 段  delta.reasoning_content ↔ lp.reasoning_content: ${seg.reasoning.alignExact} 一致 / ${seg.reasoning.alignDiff} 不一致 (单token ${seg.reasoning.singleExact}/${seg.reasoning.singleDiff}, 多token chunk ${seg.reasoning.multiChunks})`);
  console.log(line);

  console.log("【logprobs 双字段存在性（独立统计）】");
  console.log(`  content 段   (chunk=${seg.content.chunks}): ${fmtFieldState(seg.content)}`);
  console.log(`  reasoning 段 (chunk=${seg.reasoning.chunks}): ${fmtFieldState(seg.reasoning)}`);
  console.log("  结论:");
  console.log(`    content 段 logprobs  : ${s.conclusions.content}`);
  console.log(`    reasoning 段 logprobs: ${s.conclusions.reasoning}`);
  console.log(line);

  console.log("【token 汇总（按段）】");
  for (const [name, label] of [["content", "content(答案)"], ["reasoning", "reasoning(思考)"], ["tool-call", "tool-call(工具)"], ["other", "other(其他)"]]) {
    const x = seg[name];
    console.log(`  ${label.padEnd(16)} chunk=${String(x.chunks).padStart(4)}  delta字符=${String(x.deltaChars).padStart(5)}  logprobs条目=${String(x.lpTokens).padStart(4)}  (带条目chunk ${x.lpChunks}/${x.chunks} = ${pct(x.lpChunks, x.chunks)})`);
  }
  console.log(`  usage: ${JSON.stringify(s.stream.usage)}`);
  console.log(line);

  console.log("【reasoning 占比】");
  const dc = s.reasoningShare.deltaChars;
  console.log(`  delta 字符: reasoning ${dc.reasoning} / 全部 ${dc.total} = ${pct(dc.reasoning, dc.total)}`);
  if (s.reasoningShare.usage) {
    const u = s.reasoningShare.usage;
    console.log(`  usage     : reasoning_tokens ${u.reasoning_tokens} / completion_tokens ${u.completion_tokens} = ${pct(u.reasoning_tokens, u.completion_tokens)}`);
  } else {
    console.log("  usage     : 无（usage 未返回）");
  }
  console.log(line);

  console.log("【带宽放大（README 5.4 修正依据）】");
  const a = s.amplification;
  console.log(`  流级: 原始 ${a.stream.rawBytes} B → 剥皮后 ${a.stream.leanBytes} B = x${a.stream.factor} 倍`);
  console.log(`  chunk 级: 均值 x${a.chunkMean}  最小 x${a.chunkMin}  最大 x${a.chunkMax}  (n=${a.chunkCount})`);
  console.log(`  分布: ` + Object.entries(a.buckets).map(([k, v]) => `${k}: ${v}`).join("  "));
  console.log(line);

  console.log("【bytes ↔ token 校验（t1 未确认项 8/9）】");
  console.log(`  content 段  : 校验 ${s.bytesCheck.content.checked} 条目，不一致 ${s.bytesCheck.content.mismatch}`);
  console.log(`  reasoning 段: 校验 ${s.bytesCheck.reasoning.checked} 条目，不一致 ${s.bytesCheck.reasoning.mismatch}`);
  console.log(`  合计        : 校验 ${s.bytesCheck.total.checked} 条目，不一致 ${s.bytesCheck.total.mismatch}`);
  console.log(line);
  console.log(`完整采样已保存: ${savePath}`);
  console.log(line);
}

/* ------------------------------------------------------------------ *
 * 6. 回放模式（--replay）：读 sample 内 chunks[].raw 重算 summary 并写回
 * ------------------------------------------------------------------ */

async function runReplay(file) {
  let rawText;
  try {
    rawText = await readFile(file, "utf8");
  } catch (err) {
    console.error(`错误：无法读取样本文件 ${file}（${err.message}）`);
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    console.error(`错误：样本文件不是合法 JSON（${err.message}）`);
    process.exit(1);
  }
  if (!Array.isArray(data.chunks) || !data.chunks.every((c) => typeof c.raw === "string")) {
    console.error("错误：样本文件缺少 chunks[].raw（无法回放）");
    process.exit(1);
  }

  // 与真实运行完全相同的解析/分类/统计逻辑（跳过 SSE 边界缓冲，直接逐条 JSON.parse raw）
  const st = createStats();
  for (const c of data.chunks) processPayload(c.raw, st);

  const computed = buildComputed(st);

  // —— 写回：summary 可推导部分更新；raw/meta/request 等原始字段保留 ——
  const out = { ...data };
  out.meta = { ...(data.meta || {}), replayedAt: new Date().toISOString() };
  out.stream = { ...computed.stream, doneArrived: data.stream?.doneArrived === true }; // [DONE] 只能来自真实流，保留原值
  out.tokenPerChunk = computed.tokenPerChunk;
  out.segments = computed.segments;
  out.conclusions = computed.conclusions;
  out.reasoningShare = computed.reasoningShare;
  out.amplification = computed.amplification;
  out.bytesCheck = computed.bytesCheck;
  out.chunks = st.chunks; // 逐 chunk 重算（raw 原样保留，role/tokens/bytes 等按当前逻辑刷新）

  // 原子写回：先写临时文件再 rename
  const tmp = `${file}.replay-tmp`;
  try {
    await writeFile(tmp, JSON.stringify(out, null, 2), "utf8");
    await rename(tmp, file);
  } catch (err) {
    console.error(`错误：写回样本文件失败（${err.message}）；原文件未改动。`);
    process.exit(1);
  }

  // 打印核验汇总（title 指明回放，路径指向被刷新文件）
  printSummary({ meta: out.meta, ...computed }, { title: `M0 回放核验（${file}）`, savePath: file });
  console.log(`回放完成: ${st.chunks.length} chunks 重算，raw 未改动，文件已刷新（meta.replayedAt=${out.meta.replayedAt}）。`);
}

/* ------------------------------------------------------------------ *
 * 7. 主流程
 * ------------------------------------------------------------------ */

async function main() {
  // —— 回放模式分支 ——
  if (opts.replay) {
    console.log(`回放模式: ${opts.replay}（不请求 API，不需要 DEEPSEEK_API_KEY）\n`);
    await runReplay(opts.replay);
    return;
  }

  console.log(`M0 探测: model=${model} baseUrl=${baseUrl} top_logprobs=${top} max_tokens=${maxTokens} thinking=${opts.noThinking ? "disabled" : "default"}`);
  console.log(`提示词: ${prompt}\n`);

  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    stream_options: { include_usage: true },
    logprobs: true,
    top_logprobs: top,
    max_tokens: maxTokens,
  };
  if (opts.noThinking) {
    // 关闭思考模式：dsh 自身请求体即用 thinking.type 控制思考（README §3.1 示例
    // "thinking": {"type":"enabled"}），故 disabled 为同构写法；DeepSeek 官方
    // 思考模式指南未给 chat/completions 单独的关闭参数，以 dsh 现有用法为准。
    body.thinking = { type: "disabled" };
  }

  const st = createStats();

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`错误：无法连接上游 ${baseUrl}`);
    console.error(`  ${err.cause?.message || err.message}`);
    process.exit(1);
  }

  if (!res.ok) {
    // —— 非 2xx：打印完整错误体（t1 未确认项 5：400/422 的 logprobs 拒绝形态） ——
    const bodyText = await res.text();
    console.error("=".repeat(62));
    console.error(`上游返回非 2xx 状态：HTTP ${res.status} ${res.statusText}`);
    console.error("=".repeat(62));
    console.error("完整响应体：");
    console.error(bodyText || "(空)");
    try {
      const j = JSON.parse(bodyText);
      console.error("\n结构化 error 字段：");
      console.error(JSON.stringify(j.error ?? j, null, 2));
    } catch { /* 非 JSON 错误体，原样已打印 */ }
    console.error("=".repeat(62));
    console.error("提示：400/422 且消息含 logprobs/top_logprobs/unsupported 等关键字 →");
    console.error("  该模型/模式可能不支持 logprobs（M1 反代将触发去注入降级重试）。");
    console.error("  401 → 密钥无效；402 → 余额不足；429 → 限速。脚本不做自动重试。");
    process.exit(1);
  }

  if (!res.body) {
    console.error("错误：响应没有 body（可能是非流式响应）。");
    process.exit(1);
  }

  const requestId = res.headers.get("x-request-id") || res.headers.get("x-ds-request-id") || null;
  if (requestId) console.log(`上游 request-id: ${requestId}`);

  await consumeStream(res.body, st);

  // —— 汇总 ——
  const summary = buildLiveSummary(st);
  printSummary(summary);

  // —— --raw: 打印前 10 个原始 chunk ——
  if (opts.raw) {
    console.log("\n── 前 10 个原始 chunk（截断 300 字符） ──");
    for (const c of st.chunks.slice(0, 10)) {
      const t = c.raw.length > 300 ? c.raw.slice(0, 300) + "…" : c.raw;
      console.log(`[#${c.seq} ${c.role}] ${t}\n`);
    }
  }

  // —— 保存完整采样（raw 原样保留，供 M2 标记引擎复用） ——
  try {
    await mkdir(path.dirname(SAMPLE_PATH), { recursive: true });
    const sample = { ...summary, chunks: st.chunks };
    await writeFile(SAMPLE_PATH, JSON.stringify(sample, null, 2), "utf8");
  } catch (err) {
    console.warn(`警告：无法保存采样文件 ${SAMPLE_PATH}（${err.message}），探测结果仍有效。`);
  }
}

main().catch((err) => {
  console.error("未预期错误：", err);
  process.exit(1);
});
