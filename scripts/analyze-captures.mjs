/**
 * logprobs-highlighter — 捕获数据分析（JSONL → 前端设计输入）
 *
 * 读取 $DSH_HOME/logprobs-highlighter/captures.jsonl（全量），输出：
 *   1. 概览：记录/会话/轮次/辅助请求/关联率/耗时
 *   2. token 形态：字符长度分布、半字/空白/标点比例、reasoning 占比
 *   3. 置信度：直方图、低置信比例
 *   4. 突变点：±20 滑窗 median+MAD，z<-2.5 命中统计
 *   5. 句子级：句长分布、句内低分位、红/黄/无 三档试算
 *   6. 代码块：代码块内 token 的置信度特征
 *
 * 用法：node scripts/analyze-captures.mjs [captures.jsonl 路径]
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.env.LPH_DIR ?? join(homedir(), ".dsh", "logprobs-highlighter");
const file = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? join(dir, "captures.jsonl");

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return quantile(s, 0.5);
}

function mad(arr, med) {
  if (arr.length === 0) return null;
  const dev = arr.map((x) => Math.abs(x - med));
  return median(dev);
}

function pct(n, total) {
  return total === 0 ? "0%" : `${((n / total) * 100).toFixed(1)}%`;
}

function bar(count, max, width = 28) {
  const n = max === 0 ? 0 : Math.round((count / max) * width);
  return "█".repeat(n) + "·".repeat(width - n);
}

/** 判断 token 文本是否"不完整"（UTF-8 拆分/空/替换字符）。 */
function isBrokenToken(text) {
  if (typeof text !== "string" || text.length === 0) return true;
  if (text.includes("\uFFFD")) return true;
  // lone surrogate（合法代理对在 Array.from 里只算一个码点）
  return Array.from(text).some((ch) => {
    const cp = ch.codePointAt(0);
    return cp >= 0xd800 && cp <= 0xdfff;
  });
}

/** 粗略分类 token 的文本形态。 */
function tokenShape(text) {
  if (typeof text !== "string" || text.length === 0) return "empty";
  if (/^\s+$/.test(text)) return "whitespace";
  if (/^[\p{P}\p{S}]+$/u.test(text)) return "punct";
  if (/^[0-9０-９.,%]+$/.test(text)) return "digit";
  if (/^[\p{Script=Han}]$/u.test(text)) return "han1";
  if (/^[\p{Script=Han}]{2,}$/u.test(text)) return "hanN";
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) return "ident";
  if (/^[A-Za-z]+$/.test(text)) return "latin";
  return "mixed";
}

/** 按中文/英文句末标点切句，返回 [{start, end, text}]。 */
function splitSentences(text) {
  const out = [];
  if (!text) return out;
  let start = 0;
  const isEnd = (ch) => "。！？；!?;\n".includes(ch);
  for (let i = 0; i < text.length; i++) {
    if (isEnd(text[i])) {
      const end = i + 1;
      const seg = text.slice(start, end);
      if (seg.trim().length > 0) out.push({ start, end, text: seg });
      start = end;
    }
  }
  if (start < text.length) {
    const seg = text.slice(start);
    if (seg.trim().length > 0) out.push({ start, end: text.length, text: seg });
  }
  return out;
}

/** 突变点：±window 滑窗 median+MAD。 */
function findMutations(tokens, { window = 20, zThreshold = -2.5 } = {}) {
  const vals = tokens.map((t) => (typeof t.logprob === "number" && t.logprob > -9998 ? t.logprob : null));
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] === null) continue;
    const lo = Math.max(0, i - window);
    const hi = Math.min(vals.length, i + window + 1);
    const neigh = [];
    for (let j = lo; j < hi; j++) {
      if (j === i || vals[j] === null) continue;
      neigh.push(vals[j]);
    }
    if (neigh.length < 5) continue;
    const med = median(neigh);
    const scale = mad(neigh, med);
    if (scale === null || scale === 0) continue;
    const z = (vals[i] - med) / (scale * 1.4826);
    if (z < zThreshold) out.push({ i, z, logprob: vals[i], med, text: tokens[i].text });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 读数据
 * ------------------------------------------------------------------ */

console.log(`读取 ${file}\n`);
const raw = await readFile(file, "utf8");
let entries = raw
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  })
  .filter(Boolean);

// --last=N：只看最近 N 条（区分多轮实验）
const lastArg = process.argv.find((a) => a.startsWith("--last="));
const lastN = lastArg ? Number(lastArg.slice(7)) : null;
if (lastN && Number.isFinite(lastN) && lastN > 0 && lastN < entries.length) {
  console.log(`（只分析最近 ${lastN} 条，共 ${entries.length} 条）\n`);
  entries = entries.slice(-lastN);
}

if (entries.length === 0) {
  console.log("没有记录。");
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 1. 概览
 * ------------------------------------------------------------------ */

const byPurpose = new Map();
const byModel = new Map();
const bySession = new Map();
const turns = new Set();
let complete = 0;
let withAssoc = 0;
let durationSum = 0;
let durationN = 0;

for (const e of entries) {
  const p = e.purpose ?? "conversation";
  byPurpose.set(p, (byPurpose.get(p) ?? 0) + 1);
  byModel.set(e.model, (byModel.get(e.model) ?? 0) + 1);
  if (e.sessionId) {
    const rec = bySession.get(e.sessionId) ?? { entries: 0, turns: new Set() };
    rec.entries += 1;
    if (e.assoc) rec.turns.add(e.assoc.turn);
    bySession.set(e.sessionId, rec);
  }
  if (e.assoc) {
    withAssoc += 1;
    turns.add(`${e.sessionId}:${e.assoc.turn}`);
  }
  if (e.complete) complete += 1;
  if (typeof e.durationMs === "number") {
    durationSum += e.durationMs;
    durationN += 1;
  }
}

const conversationEntries = entries.filter((e) => !e.purpose);

console.log("=".repeat(70));
console.log("1. 概览");
console.log("=".repeat(70));
console.log(`记录数          ${entries.length}（对话 ${conversationEntries.length} / 辅助 ${entries.length - conversationEntries.length}）`);
console.log(`会话数          ${bySession.size}`);
console.log(`轮次(turn)数    ${turns.size}`);
console.log(`complete        ${complete} / ${entries.length}（${pct(complete, entries.length)}）`);
console.log(`关联成功        ${withAssoc} / ${entries.length}（${pct(withAssoc, entries.length)}）`);
console.log(`平均耗时        ${durationN ? (durationSum / durationN / 1000).toFixed(2) : "?"} s`);
console.log(`purpose 分布    ${[...byPurpose.entries()].map(([k, v]) => `${k}:${v}`).join("  ")}`);
console.log(`模型分布        ${[...byModel.entries()].map(([k, v]) => `${k}:${v}`).join("  ")}`);

/* ------------------------------------------------------------------ *
 * 2. token 形态
 * ------------------------------------------------------------------ */

const shapes = new Map();
let textTokenTotal = 0;
let reasoningTokenTotal = 0;
let broken = 0;
let sentinel = 0;
const charLens = [];

for (const e of entries) {
  for (const block of e.blocks ?? []) {
    if (block.role === "text") textTokenTotal += block.tokens?.length ?? 0;
    if (block.role === "reasoning") reasoningTokenTotal += block.tokens?.length ?? 0;
    if (block.role !== "text") continue;
    for (const t of block.tokens ?? []) {
      const key = tokenShape(t.text);
      shapes.set(key, (shapes.get(key) ?? 0) + 1);
      if (isBrokenToken(t.text)) broken += 1;
      if (typeof t.logprob === "number" && t.logprob <= -9998) sentinel += 1;
      charLens.push((t.text ?? "").length);
    }
  }
}

const sortedLens = [...charLens].sort((a, b) => a - b);

console.log("\n" + "=".repeat(70));
console.log("2. token 形态（text 块）");
console.log("=".repeat(70));
console.log(`text token      ${textTokenTotal}`);
console.log(`reasoning token ${reasoningTokenTotal}（占 ${pct(reasoningTokenTotal, textTokenTotal + reasoningTokenTotal)}）`);
console.log(`不完整 token    ${broken}（${pct(broken, textTokenTotal)}）← 半字/空/替换字符`);
console.log(`-9999 哨兵      ${sentinel}（${pct(sentinel, textTokenTotal)}）`);
console.log(`字符长度        min=${sortedLens[0]} p25=${quantile(sortedLens, 0.25)} median=${quantile(sortedLens, 0.5)} p75=${quantile(sortedLens, 0.75)} max=${sortedLens[sortedLens.length - 1]}`);
const shapeOrder = ["han1", "hanN", "latin", "ident", "digit", "whitespace", "punct", "mixed", "empty"];
console.log("形态分布：");
for (const key of shapeOrder) {
  const n = shapes.get(key) ?? 0;
  if (n === 0) continue;
  console.log(`  ${key.padEnd(11)} ${String(n).padStart(6)}  ${pct(n, textTokenTotal).padStart(6)}  ${bar(n, textTokenTotal)}`);
}

/* ------------------------------------------------------------------ *
 * 3. 置信度直方图
 * ------------------------------------------------------------------ */

const buckets = new Array(10).fill(0);
let confN = 0;
let low10 = 0;
let low1 = 0;
const allConf = [];

for (const e of conversationEntries) {
  for (const block of e.blocks ?? []) {
    if (block.role !== "text") continue;
    for (const t of block.tokens ?? []) {
      if (typeof t.logprob !== "number" || t.logprob <= -9998) continue;
      const c = Math.exp(t.logprob);
      confN += 1;
      allConf.push(c);
      const b = Math.min(9, Math.floor(c * 10));
      buckets[b] += 1;
      if (c < 0.1) low10 += 1;
      if (c < 0.01) low1 += 1;
    }
  }
}

console.log("\n" + "=".repeat(70));
console.log("3. 置信度分布（对话请求的 text token）");
console.log("=".repeat(70));
console.log(`样本 ${confN} 个（已排除 -9999 哨兵）`);
for (let i = 9; i >= 0; i--) {
  const label = `${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}`;
  console.log(`  ${label.padEnd(7)} ${String(buckets[i]).padStart(6)}  ${pct(buckets[i], confN).padStart(6)}  ${bar(buckets[i], confN)}`);
}
console.log(`<10%   ${low10}（${pct(low10, confN)}）`);
console.log(`<1%    ${low1}（${pct(low1, confN)}）`);

/* ------------------------------------------------------------------ *
 * 4. 突变点
 * ------------------------------------------------------------------ */

let mutationTotal = 0;
const perEntryMutations = [];
const mutationSamples = [];
for (const e of conversationEntries) {
  const text = (e.blocks ?? []).find((b) => b.role === "text");
  if (!text || !text.tokens || text.tokens.length === 0) continue;
  const muts = findMutations(text.tokens);
  mutationTotal += muts.length;
  perEntryMutations.push(muts.length);
  for (const m of muts.slice(0, 3)) {
    mutationSamples.push({ model: e.model, text: m.text, z: m.z, logprob: m.logprob });
  }
}

console.log("\n" + "=".repeat(70));
console.log("4. 突变点（z < -2.5，±20 滑窗 median+MAD）");
console.log("=".repeat(70));
console.log(`命中总数        ${mutationTotal}`);
console.log(`每条均值        ${perEntryMutations.length ? (mutationTotal / perEntryMutations.length).toFixed(1) : 0}`);
console.log(`每条中位数      ${median(perEntryMutations) ?? 0}`);
console.log(`有突变的条目    ${perEntryMutations.filter((n) => n > 0).length} / ${perEntryMutations.length}`);
if (mutationSamples.length) {
  console.log("样例：");
  for (const s of mutationSamples.slice(0, 12)) {
    console.log(`  z=${s.z.toFixed(2).padStart(6)}  logprob=${s.logprob.toFixed(2).padStart(7)}  token=${JSON.stringify(s.text)}`);
  }
}

/* ------------------------------------------------------------------ *
 * 5. 句子级试算
 * ------------------------------------------------------------------ */

const sentenceLens = [];
const sentenceScores = [];
let sentenceTotal = 0;
let red = 0;
let yellow = 0;

for (const e of conversationEntries) {
  const textBlock = (e.blocks ?? []).find((b) => b.role === "text");
  if (!textBlock || !textBlock.tokens || textBlock.tokens.length === 0) continue;
  const toks = textBlock.tokens;
  // 逐 token 累积字符偏移
  let offset = 0;
  const spans = toks.map((t) => {
    const len = (t.text ?? "").length;
    const span = { start: offset, end: offset + len, logprob: t.logprob };
    offset += len;
    return span;
  });
  for (const sent of splitSentences(textBlock.text ?? "")) {
    const inside = spans.filter((s) => s.start >= sent.start && s.end <= sent.end && typeof s.logprob === "number" && s.logprob > -9998);
    if (inside.length === 0) continue;
    const confs = inside.map((s) => Math.exp(s.logprob)).sort((a, b) => a - b);
    const p5 = quantile(confs, 0.05);
    sentenceTotal += 1;
    sentenceLens.push(sent.text.length);
    sentenceScores.push(p5);
    if (p5 < 0.05) red += 1;
    else if (p5 < 0.20) yellow += 1;
  }
}

const sortedSentLens = [...sentenceLens].sort((a, b) => a - b);
const sortedScores = [...sentenceScores].sort((a, b) => a - b);

console.log("\n" + "=".repeat(70));
console.log("5. 句子级试算（句内 5th percentile 作为句子得分）");
console.log("=".repeat(70));
console.log(`句子总数        ${sentenceTotal}`);
console.log(`句长            median=${quantile(sortedSentLens, 0.5)} p90=${quantile(sortedSentLens, 0.9)} max=${sortedSentLens[sortedSentLens.length - 1] ?? 0}`);
console.log(`句子得分        p10=${quantile(sortedScores, 0.1)?.toFixed(3)} p50=${quantile(sortedScores, 0.5)?.toFixed(3)} p90=${quantile(sortedScores, 0.9)?.toFixed(3)}`);
console.log(`红 (<5%)        ${red}（${pct(red, sentenceTotal)}）`);
console.log(`黄 (5%-20%)     ${yellow}（${pct(yellow, sentenceTotal)}）`);
console.log(`无              ${sentenceTotal - red - yellow}（${pct(sentenceTotal - red - yellow, sentenceTotal)}）`);

/* ------------------------------------------------------------------ *
 * 6. 代码块特征（粗粒度：按 ``` 分段估算）
 * ------------------------------------------------------------------ */

let codeTokens = 0;
let codeConfSum = 0;
let codeConfN = 0;
let proseTokens = 0;
let proseConfSum = 0;
let proseConfN = 0;

for (const e of conversationEntries) {
  const block = (e.blocks ?? []).find((b) => b.role === "text");
  if (!block || !block.tokens?.length) continue;
  const text = block.text ?? "";
  // 标记代码块区间
  const ranges = [];
  const re = /```[\s\S]*?```/g;
  let m;
  while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  let offset = 0;
  for (const t of block.tokens) {
    const start = offset;
    const end = offset + (t.text ?? "").length;
    offset = end;
    const inCode = ranges.some(([a, b]) => start >= a && start < b);
    const lp = typeof t.logprob === "number" && t.logprob > -9998 ? t.logprob : null;
    if (inCode) {
      codeTokens += 1;
      if (lp !== null) { codeConfSum += Math.exp(lp); codeConfN += 1; }
    } else {
      proseTokens += 1;
      if (lp !== null) { proseConfSum += Math.exp(lp); proseConfN += 1; }
    }
  }
}

console.log("\n" + "=".repeat(70));
console.log("6. 代码块 vs 正文");
console.log("=".repeat(70));
console.log(`代码块 token    ${codeTokens}（平均置信 ${codeConfN ? (codeConfSum / codeConfN).toFixed(3) : "?"}）`);
console.log(`正文 token      ${proseTokens}（平均置信 ${proseConfN ? (proseConfSum / proseConfN).toFixed(3) : "?"}）`);

console.log("\n" + "=".repeat(70));
console.log("完成。");
console.log("=".repeat(70));