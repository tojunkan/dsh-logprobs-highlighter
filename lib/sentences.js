/**
 * logprobs-highlighter — 句子级派生层
 *
 * 把捕获条目里的 token 序列变成"字符区间 + 等级"，供前端直接消费：
 *   { sentences: [{ start, end, level, score, reason, tokens }], codeRanges }
 *
 * 设计原则：
 * - 只输出"红色"（一期），黄色数据先不产生；
 * - 判定用最保守的规则：句内**实词**最低置信度 < 阈值；
 * - 标点/空白/代码块内的 token 不参与评分（否则短句和代码会满屏误报）；
 * - 区间一律是"整条正文的字符偏移"，前端不需要 token→DOM 映射。
 *
 * @module logprobs-highlighter/sentences
 */

import { StringDecoder } from "node:string_decoder";

/** 句子标记算法版本：切句/判定/归一化规则变化时 bump。 */
export const SENTENCES_ALGO_VERSION = "red-v2.1";

/** 句末标点。 */
const SENTENCE_END = new Set(["。", "！", "？", "；", "!", "?", ";", "\n"]);

const ESCAPED_BYTE_RE = /\\x([0-9a-fA-F]{2})/g;

/**
 * 取 token 的真实 UTF-8 字节。
 *
 * DeepSeek 在遇到半个 UTF-8 字符时，`token` 字段可能是 `\xe5\x95` 这样的
 * 转义串；`bytes` 才是权威值。旧 capture 没有存 bytes，则从转义串还原。
 */
function tokenBytes(token) {
  if (Array.isArray(token?.bytes)) return Buffer.from(token.bytes);
  const text = typeof token?.text === "string" ? token.text : "";
  ESCAPED_BYTE_RE.lastIndex = 0;
  if (!ESCAPED_BYTE_RE.test(text)) return Buffer.from(text, "utf8");
  ESCAPED_BYTE_RE.lastIndex = 0;
  const parts = [];
  let last = 0;
  let m;
  while ((m = ESCAPED_BYTE_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(Buffer.from(text.slice(last, m.index), "utf8"));
    parts.push(Buffer.from([parseInt(m[1], 16)]));
    last = ESCAPED_BYTE_RE.lastIndex;
  }
  if (last < text.length) parts.push(Buffer.from(text.slice(last), "utf8"));
  return Buffer.concat(parts);
}

function moreUncertain(a, b) {
  if (!a) return b;
  if (!b) return a;
  const la = typeof a.logprob === "number" ? a.logprob : 0;
  const lb = typeof b.logprob === "number" ? b.logprob : 0;
  return lb < la ? b : a;
}

/**
 * 用 token.bytes 逐步解码，把半个 UTF-8 字符跨 token 拼回来。
 * 返回 null 表示解码文本与正文不一致（例如有 chunk 缺 logprobs），交给调用方回退。
 */
function byteAlignedSpans(tokens, text) {
  const decoder = new StringDecoder("utf8");
  const spans = [];
  let offset = 0;
  let carry = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const decoded = decoder.write(tokenBytes(token));
    if (!decoded) {
      carry = moreUncertain(carry, token);
      continue;
    }
    const start = offset;
    offset += decoded.length;
    const source = carry ? moreUncertain(carry, token) : token;
    spans.push({
      i,
      start,
      end: offset,
      text: decoded,
      logprob: typeof source?.logprob === "number" ? source.logprob : null,
      top: Array.isArray(source?.top) ? source.top : [],
    });
    carry = null;
  }
  const tail = decoder.end();
  if (tail.length > 0) return null;
  return spans.map((s) => s.text).join("") === text ? spans : null;
}

/** 代码块 / 行内代码区间（不参与切句与评分）。 */
export function findCodeRanges(text) {
  const ranges = [];
  if (!text) return ranges;
  const patterns = [/```[\s\S]*?```/g, /`[^`\n]+`/g];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

function inRanges(pos, ranges) {
  return ranges.some(([a, b]) => pos >= a && pos < b);
}

/**
 * token 序列 → 字符偏移表。
 * 传入 text 时优先按 token.bytes 解码并校验；解码文本与正文不一致才退回
 * 旧的长度累加（旧 capture 没有 bytes 且无法还原时）。
 */
export function tokenSpans(tokens, text = null) {
  const list = Array.isArray(tokens) ? tokens : [];
  if (typeof text === "string" && text.length > 0) {
    const aligned = byteAlignedSpans(list, text);
    if (aligned) return aligned;
  }
  let offset = 0;
  return list.map((t, i) => {
    const tokenText = typeof t?.text === "string" ? t.text : "";
    const span = {
      i,
      start: offset,
      end: offset + tokenText.length,
      text: tokenText,
      logprob: typeof t?.logprob === "number" ? t.logprob : null,
      top: Array.isArray(t?.top) ? t.top : [],
    };
    offset += tokenText.length;
    return span;
  });
}

/** 粗分类：数字 / 标识符 / 汉字 / 标点 / 空白 / 其他。 */
export function classifyToken(text) {
  if (!text) return "empty";
  if (/^\s+$/.test(text)) return "space";
  if (/^[\p{P}\p{S}]+$/u.test(text)) return "punct";
  if (/^[+-]?\d[\d,._]*%?$/.test(text)) return "digit";
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) return "ident";
  if (/[\p{Script=Han}]/u.test(text)) return "han";
  return "other";
}

/** 实词：非空白、非标点、非纯符号。 */
export function isContentToken(text) {
  const c = classifyToken(text);
  if (c === "space" || c === "punct" || c === "empty") return false;
  return true;
}

/**
 * 句子的“可匹配纯文本”：去掉 markdown 符号与所有空白。
 *
 * 前端 DOM 是渲染后的文本（`**`、`` ` ``、`#`、`\|` 不占字符），所以不能用
 * 源码偏移直接建 Range；两边都归一化成“无空白纯文本”后，用 indexOf 定位。
 */
export function toPlainSentence(text) {
  if (!text) return "";
  let s = text;
  s = s.replace(/```[\s\S]*?```/g, " ");       // 代码块整体丢弃
  s = s.replace(/`[^`]*`/g, " ");               // 行内代码整体丢弃（DOM 侧同样排除）
  s = s.replace(/\$\$[\s\S]*?\$\$/g, " ");      // 块级数学整体丢弃
  s = s.replace(/\$[^$\n]*\$/g, " ");           // 行内数学整体丢弃（DOM 侧是 KaTeX）
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, " "); // 图片无文本节点 → 整体丢弃
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");  // 链接 → 文字
  s = s.replace(/[*_~#>]/g, "");                 // 强调/标题/引用
  s = s.replace(/^\s*[-+]\s+/gm, "");            // 列表符号
  s = s.replace(/\|/g, " ");                     // 表格分隔
  s = s.replace(/\s+/g, "");                     // 空白一律去掉
  return s;
}

/**
 * 切句：句末标点 / 换行，跳过代码区间；过短碎片丢弃，过长强制切。
 * @returns {{start:number,end:number,text:string}[]}
 */
export function splitSentences(text, codeRanges = [], { minLength = 6, maxLength = 200 } = {}) {
  const out = [];
  if (!text) return out;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isEnd = SENTENCE_END.has(ch);
    const forced = i - start >= maxLength;
    if (!isEnd && !forced) continue;
    if (inRanges(i, codeRanges)) continue;
    const end = i + 1;
    const seg = text.slice(start, end);
    if (seg.trim().length >= minLength) out.push({ start, end, text: seg });
    start = end;
  }
  if (start < text.length) {
    const seg = text.slice(start);
    if (seg.trim().length >= minLength) out.push({ start, end: text.length, text: seg });
  }
  return out;
}

/**
 * 主入口：正文块 → 句子级标记。
 *
 * 判定规则（保守版）：
 * - 句子至少 12 字，句内至少 3 个实词 token；
 * - 跳过句首 4 字的“热身区”（天然低概率不参与，除非 <0.5%）；
 * - 取剩余实词中最低置信度，低于 redThreshold（默认 1%）→ level=red；
 * - 代码区间、表格行不参与。
 *
 * @param {{text?:string, tokens?:object[]}} textBlock
 * @param {{redThreshold?:number, minContentTokens?:number}} options
 */
export function buildSentences(textBlock, options = {}) {
  const text = typeof textBlock?.text === "string" ? textBlock.text : "";
  const redThreshold = options.redThreshold ?? 0.01;
  const triggerThreshold = options.triggerThreshold ?? 0.05;
  const minContentTokens = options.minContentTokens ?? 3;
  const warmupChars = options.warmupChars ?? 4;
  const codeRanges = findCodeRanges(text);
  const spans = tokenSpans(textBlock?.tokens, text);

  const sentences = [];
  for (const sent of splitSentences(text, codeRanges, { minLength: 12, maxLength: 200 })) {
    // 表格行是个结构化内容，不参与标红（低置信是正常的）。
    if (/^\s*\|/.test(sent.text) || (sent.text.match(/\|/g) || []).length >= 2) continue;
    // 跳过 markdown 前导符号（# / - / * / 数字列表），避免把符号当句首实词。
    const lead = /^[#>*\-\s\d.）)]*/.exec(sent.text)?.[0].length ?? 0;
    const contentStart = sent.start + lead;
    const warmupEnd = contentStart + warmupChars;

    const inside = spans.filter((p) =>
      p.start >= contentStart
      && p.start < sent.end
      && isContentToken(p.text)
      && typeof p.logprob === "number"
      && p.logprob > -9998
      && !inRanges(p.start, codeRanges));
    if (inside.length < minContentTokens) continue;

    // 热身区（句首几个字）天然低概率：除非极低（<0.5%），否则不参与最低分。
    let worst = null;
    for (const p of inside) {
      const conf = Math.exp(p.logprob);
      if (p.start < warmupEnd && conf > 0.005) continue;
      if (!worst || p.logprob < worst.logprob) worst = p;
    }
    if (!worst) continue;

    const confidence = Math.exp(worst.logprob);
    if (confidence >= redThreshold) continue;

    sentences.push({
      start: sent.start,
      end: sent.end,
      level: "red",
      score: Number(confidence.toFixed(4)),
      // 前端用于在 DOM 纯文本中定位的归一化文本（去 markdown 符号与空白）。
      plain: toPlainSentence(sent.text),
      // 整句原文 + 句内所有可疑词（hover 展示用）。
      text: sent.text.trim(),
      triggers: inside
        .filter((p) => Math.exp(p.logprob) < triggerThreshold)
        .sort((a, b) => a.logprob - b.logprob)
        .slice(0, 3)
        .map((p) => ({
          token: p.text,
          confidence: Number(Math.exp(p.logprob).toFixed(4)),
          category: classifyToken(p.text),
          // 原文中的精确位置（block 内绝对偏移）；前端用于在句子里标出对应 token。
          start: p.start,
          end: p.end,
          tokenIndex: p.i,
          // 候选：模型更想写的词（含实际输出时前端可自己跳过）。
          top: Array.isArray(p.top) ? p.top.slice(0, 3) : [],
        })),
      reason: {
        type: "low-confidence",
        token: worst.text,
        confidence: Number(confidence.toFixed(4)),
        category: classifyToken(worst.text),
        offset: worst.start,
        // Top-1 / Top-2 候选（hover 显示“一选（二选）”）。
        top: Array.isArray(worst.top) ? worst.top.slice(0, 3) : [],
      },
      // 仅带可疑 token 供 hover（避免整句 token 全量返回）
      tokens: inside
        .filter((p) => Math.exp(p.logprob) < 0.2)
        .sort((a, b) => a.logprob - b.logprob)
        .slice(0, 5)
        .map((p) => ({ index: p.i, text: p.text, logprob: p.logprob, top: p.top })),
    });
  }

  return { sentences, codeRanges };
}