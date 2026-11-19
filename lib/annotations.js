/**
 * logprobs-highlighter — 句子级标注存储（P0）
 *
 * 流结束后对红句生成 annotation（初始 verdict=unsure），并持久化到
 * `$outputDir/annotations.jsonl`；人工反馈以事件形式追加到
 * `$outputDir/feedback.jsonl`，读取时取同一 markId 的最大 revision。
 *
 * 设计约束：
 * - annotation 自包含（句子文本/hash、token、特征、algoVersion、params），
 *   不依赖 capture 还在内存或磁盘；
 * - markId = hash(sentenceKey + algoVersion)；
 * - sentenceKey = hash(captureId + blockIndex + occurrence + plainHash)；
 * - misjudge_reason 只在 verdict=highlighter_misjudge 时存在，其他一律 null。
 *
 * @module logprobs-highlighter/annotations
 */

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSentences, tokenSpans, SENTENCES_ALGO_VERSION } from "./sentences.js";

export const VERDICTS = new Set([
  "highlighter_correct",
  "reasonable_ambiguity",
  "highlighter_misjudge",
  "unsure",
]);

export const ERROR_TYPES = new Set([
  "factual_error",
  "fabrication",
  "self_contradiction",
  "user_contradiction",
  "logic_gap",
  "conflicting_sources",
  "other",
  "cannot_tell",
]);

export const AMBIGUITY_KINDS = new Set([
  "continuation",
  "wording",
  "opening",
  "other",
  "cannot_tell",
]);

export const MISJUDGE_REASONS = new Set([
  "paraphrase",
  "format",
  "function_word",
  "correct_entity",
  "code_or_math",
  "other",
  "cannot_tell",
]);

const SCHEMA_VERSION = 1;

function defaultOutputDir() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? join(process.env.DSH_HOME, "logprobs-highlighter")
    : join(homedir(), ".dsh", "logprobs-highlighter");
}

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function shortDigest(value) {
  return digest(value).slice(0, 24);
}

function candidateFiles(file, keepFiles) {
  const stem = file.replace(/\.jsonl$/, "");
  const files = [file];
  for (let i = 1; i <= keepFiles; i++) files.push(`${stem}.${i}.jsonl`);
  return files;
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 单行损坏不阻塞其余标签；分析脚本也应容忍。
    }
  }
  return out;
}

/**
 * @param {object} options
 * @param {string} [options.outputDir]
 * @param {object} options.config 已解包的插件配置
 * @param {object} [options.logger]
 */
export function createAnnotationStore({ outputDir, config = {}, logger = console } = {}) {
  const dir = outputDir && outputDir.length > 0 ? outputDir : defaultOutputDir();
  const enabled = config.annotationEnabled !== false;
  const storeText = config.annotationStoreText === "none" ? "none" : "sentence";
  const maxSentenceChars = Number.isFinite(config.annotationMaxSentenceChars)
    ? Math.max(1, config.annotationMaxSentenceChars)
    : 500;
  const maxFileBytes = Number.isFinite(config.annotationMaxFileBytes) && config.annotationMaxFileBytes > 0
    ? config.annotationMaxFileBytes
    : 10 * 1024 * 1024;
  const keepFiles = Number.isFinite(config.annotationKeepFiles) && config.annotationKeepFiles > 0
    ? Math.floor(config.annotationKeepFiles)
    : 20;

  const annotationsFile = join(dir, "annotations.jsonl");
  const feedbackFile = join(dir, "feedback.jsonl");

  const marksById = new Map();
  const marksByCapture = new Map();
  const latestFeedback = new Map();
  let feedbackCount = 0;

  function ensureDir() {
    mkdirSync(dir, { recursive: true });
  }

  function rotate(file) {
    const stem = file.replace(/\.jsonl$/, "");
    for (let i = keepFiles - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${stem}.${i - 1}.jsonl`;
      const to = `${stem}.${i}.jsonl`;
      try {
        if (existsSync(to)) unlinkSync(to);
      } catch {
        // 目标不可删时继续尝试 rename。
      }
      try {
        renameSync(from, to);
      } catch {
        // 源文件不存在，跳过。
      }
    }
    try {
      unlinkSync(`${stem}.${keepFiles}.jsonl`);
    } catch {
      // 不存在。
    }
  }

  function appendJsonl(file, record) {
    ensureDir();
    const line = `${JSON.stringify(record)}\n`;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      size = 0;
    }
    if (size + Buffer.byteLength(line) > maxFileBytes) {
      rotate(file);
      size = 0;
    }
    appendFileSync(file, line, "utf8");
    return size + Buffer.byteLength(line);
  }

  function loadFeedback() {
    for (const file of candidateFiles(feedbackFile, keepFiles)) {
      for (const record of readJsonl(file)) {
        if (!record || typeof record.markId !== "string") continue;
        feedbackCount += 1;
        const prev = latestFeedback.get(record.markId);
        if (
          !prev
          || (Number(record.revision) || 0) > (Number(prev.revision) || 0)
          || ((Number(record.revision) || 0) === (Number(prev.revision) || 0)
            && (Number(record.createdAt) || 0) > (Number(prev.createdAt) || 0))
        ) {
          latestFeedback.set(record.markId, record);
        }
      }
    }
  }

  /** 启动时恢复历史 annotation，保证 dsh 重启后仍能按 session/turn 反查。 */
  function loadAnnotations() {
    for (const file of candidateFiles(annotationsFile, keepFiles)) {
      for (const record of readJsonl(file)) {
        if (!record || typeof record.markId !== "string" || marksById.has(record.markId)) continue;
        applyCurrentFeedback(record);
        marksById.set(record.markId, record);
        let list = marksByCapture.get(record.captureId);
        if (!list) {
          list = [];
          marksByCapture.set(record.captureId, list);
        }
        list.push(record);
      }
    }
  }

  function applyCurrentFeedback(mark) {
    const f = latestFeedback.get(mark.markId);
    if (!f) return mark;
    mark.verdict = f.verdict ?? mark.verdict;
    mark.error_type = f.error_type ?? null;
    mark.ambiguity_kind = f.ambiguity_kind ?? null;
    mark.misjudge_reason = f.misjudge_reason ?? null;
    mark.focus = f.focus ?? null;
    mark.triggerIndex = Number.isInteger(f.triggerIndex) ? f.triggerIndex : null;
    mark.revision = Number(f.revision) || mark.revision;
    return mark;
  }

  function buildMark(entry, block, blockIndex, sentence, occurrence) {
    const plain = sentence.plain ?? "";
    const plainHash = shortDigest(plain);
    const sentenceKey = `sk-${shortDigest(`${entry.id}\0${blockIndex}\0${occurrence}\0${plainHash}`)}`;
    const markId = `mk-${shortDigest(`${sentenceKey}\0${SENTENCES_ALGO_VERSION}`)}`;
    const spans = tokenSpans(block.tokens, block.text).filter(
      (t) => t.start >= sentence.start && t.start < sentence.end,
    );
    const redThreshold = typeof config.redThreshold === "number" ? config.redThreshold : 0.05;
    const lowCount = spans.filter((t) => {
      if (typeof t.logprob !== "number" || t.logprob <= -9998) return false;
      return Math.exp(t.logprob) < redThreshold;
    }).length;
    const rawText = sentence.text ?? "";
    const text = storeText === "sentence"
      ? rawText.slice(0, maxSentenceChars)
      : null;

    return {
      schemaVersion: SCHEMA_VERSION,
      markId,
      sentenceKey,
      captureId: entry.id,
      blockIndex,
      occurrence,
      sessionId: entry.sessionId ?? null,
      turn: entry.assoc?.turn ?? null,
      step: entry.assoc?.step ?? null,
      messageId: entry.assoc?.messageId ?? null,
      provider: entry.provider ?? null,
      model: entry.model ?? null,
      purpose: entry.purpose ?? null,
      captureCreatedAt: entry.createdAt ?? null,
      algoVersion: SENTENCES_ALGO_VERSION,
      params: {
        topLogprobs: config.topLogprobs ?? null,
        redThreshold,
        warmupChars: 4,
        minContentTokens: 3,
        minLength: 12,
        maxLength: 200,
      },
      sampling: entry.sampling ?? null,
      sentence: {
        start: sentence.start,
        end: sentence.end,
        plain,
        plainHash,
        text,
        textTruncated: storeText === "sentence" && rawText.length > maxSentenceChars,
      },
      level: sentence.level ?? "red",
      score: sentence.score ?? null,
      worst: sentence.reason ?? null,
      triggers: Array.isArray(sentence.triggers) ? sentence.triggers : [],
      tokens: spans,
      lowCount,
      verdict: "unsure",
      error_type: null,
      ambiguity_kind: null,
      misjudge_reason: null,
      focus: null,
      triggerIndex: null,
      revision: 0,
      createdAt: Date.now(),
    };
  }

  /**
   * 流结束后由 provider 调用。只处理 complete 且有正文的 entry；
   * 只生成红句 annotation。
   */
  function ingest(entry) {
    if (!enabled) return [];
    if (!entry || entry.complete !== true || !Array.isArray(entry.blocks)) return [];
    if (entry.purpose === "compaction" || entry.purpose === "session-title") return [];
    const created = [];
    for (let blockIndex = 0; blockIndex < entry.blocks.length; blockIndex++) {
      const block = entry.blocks[blockIndex];
      if (!block || block.role !== "text" || !block.text || !Array.isArray(block.tokens)) continue;
      let sentences = [];
      try {
        sentences = buildSentences(block, {
          redThreshold: typeof config.redThreshold === "number" ? config.redThreshold : 0.05,
        }).sentences;
      } catch (err) {
        logger.warn?.(`annotations: 句子判定失败（capture=${entry.id} block=${blockIndex}）：${err.message}`);
        continue;
      }
      const occurrences = new Map();
      for (const sentence of sentences) {
        const plain = sentence.plain ?? "";
        if (!plain) continue;
        const plainHash = shortDigest(plain);
        const occurrence = occurrences.get(plainHash) ?? 0;
        occurrences.set(plainHash, occurrence + 1);
        const mark = buildMark(entry, block, blockIndex, sentence, occurrence);
        if (marksById.has(mark.markId)) continue;
        applyCurrentFeedback(mark);
        marksById.set(mark.markId, mark);
        let list = marksByCapture.get(entry.id);
        if (!list) {
          list = [];
          marksByCapture.set(entry.id, list);
        }
        list.push(mark);
        created.push(mark);
        try {
          appendJsonl(annotationsFile, mark);
        } catch (err) {
          logger.warn?.(`annotations: 写入失败（${err.message}）`);
        }
      }
    }
    if (created.length > 0) {
      logger.debug?.(`annotations: capture=${entry.id} 新增 ${created.length} 条红句 annotation`);
    }
    return created;
  }

  /** 某次 capture 的红句 annotation；没有则返回 null。 */
  function forCapture(captureId) {
    const list = marksByCapture.get(captureId);
    return list && list.length > 0 ? list : null;
  }

  /**
   * 重启后没有内存 capture 时，按 (sessionId, turn) 从已持久化的 annotation
   * 反查。同 turn 多 step/多次重试时取 step 最大、createdAt 最新的一组。
   */
  function forSessionTurn(sessionId, turn) {
    let best = null;
    for (const list of marksByCapture.values()) {
      if (!list || list.length === 0) continue;
      const first = list[0];
      if (first.sessionId !== sessionId || first.turn !== turn) continue;
      const step = Number.isInteger(first.step) ? first.step : -1;
      const createdAt = list.reduce((max, m) => Math.max(max, Number(m.createdAt) || 0), 0);
      if (!best || step > best.step || (step === best.step && createdAt > best.createdAt)) {
        best = { step, createdAt, marks: list };
      }
    }
    return best ? best.marks : null;
  }

  function findMark(markId) {
    return marksById.get(markId) ?? null;
  }

  /**
   * 人工 verdict 更新。append-only，返回本次 feedback 事件。
   */
  function applyFeedback(body = {}) {
    if (!enabled) return { ok: false, error: "annotation-disabled" };
    const markId = typeof body.markId === "string" ? body.markId : "";
    const mark = marksById.get(markId);
    if (!mark) return { ok: false, error: "mark-not-found" };
    if (typeof body.captureId === "string" && body.captureId !== mark.captureId) {
      return { ok: false, error: "capture-mismatch" };
    }
    if (typeof body.sentenceKey === "string" && body.sentenceKey !== mark.sentenceKey) {
      return { ok: false, error: "sentence-mismatch" };
    }

    const verdict = body.verdict;
    if (!VERDICTS.has(verdict)) {
      return { ok: false, error: "invalid-verdict" };
    }
    let errorType = null;
    let ambiguityKind = null;
    let misjudgeReason = null;
    if (verdict === "highlighter_correct") {
      const value = body.error_type ?? "cannot_tell";
      if (!ERROR_TYPES.has(value)) return { ok: false, error: "invalid-error-type" };
      errorType = value;
    } else if (verdict === "reasonable_ambiguity") {
      const value = body.ambiguity_kind ?? "cannot_tell";
      if (!AMBIGUITY_KINDS.has(value)) return { ok: false, error: "invalid-ambiguity-kind" };
      ambiguityKind = value;
    } else if (verdict === "highlighter_misjudge") {
      const value = body.misjudge_reason ?? "cannot_tell";
      if (!MISJUDGE_REASONS.has(value)) return { ok: false, error: "invalid-misjudge-reason" };
      misjudgeReason = value;
    }
    const focus = body.focus
      && Number.isInteger(body.focus.start)
      && Number.isInteger(body.focus.end)
      && body.focus.start >= 0
      && body.focus.end >= body.focus.start
      ? {
        start: body.focus.start,
        end: body.focus.end,
        text: typeof body.focus.text === "string" ? body.focus.text.slice(0, 200) : "",
      }
      : null;
    const triggerIndex = Number.isInteger(body.triggerIndex) && body.triggerIndex >= 0
      ? body.triggerIndex
      : null;
    const revision = (Number(mark.revision) || 0) + 1;
    const record = {
      schemaVersion: SCHEMA_VERSION,
      feedbackId: `fb-${randomUUID()}`,
      createdAt: Date.now(),
      annotatorId: typeof body.annotatorId === "string" && body.annotatorId.length > 0
        ? body.annotatorId
        : "local",
      markId: mark.markId,
      sentenceKey: mark.sentenceKey,
      captureId: mark.captureId,
      sessionId: mark.sessionId,
      turn: mark.turn,
      step: mark.step,
      algoVersion: mark.algoVersion,
      verdict,
      error_type: errorType,
      ambiguity_kind: ambiguityKind,
      misjudge_reason: misjudgeReason,
      focus,
      triggerIndex,
      previousVerdict: mark.verdict,
      revision,
      uiMode: typeof body.uiMode === "string" ? body.uiMode : "inline",
    };

    try {
      appendJsonl(feedbackFile, record);
    } catch (err) {
      logger.warn?.(`annotations: feedback 写入失败（${err.message}）`);
      return { ok: false, error: "write-failed" };
    }

    mark.verdict = verdict;
    mark.error_type = errorType;
    mark.ambiguity_kind = ambiguityKind;
    mark.misjudge_reason = misjudgeReason;
    mark.focus = focus;
    mark.triggerIndex = triggerIndex;
    mark.revision = revision;
    latestFeedback.set(mark.markId, record);
    feedbackCount += 1;
    return { ok: true, record };
  }

  function stats() {
    const byVerdict = {
      highlighter_correct: 0,
      reasonable_ambiguity: 0,
      highlighter_misjudge: 0,
      unsure: 0,
    };
    const byErrorType = {};
    const byAmbiguityKind = {};
    const byReason = {};
    for (const mark of marksById.values()) {
      byVerdict[mark.verdict] = (byVerdict[mark.verdict] ?? 0) + 1;
      if (mark.verdict === "highlighter_correct") {
        const v = mark.error_type ?? "unknown";
        byErrorType[v] = (byErrorType[v] ?? 0) + 1;
      } else if (mark.verdict === "reasonable_ambiguity") {
        const v = mark.ambiguity_kind ?? "unknown";
        byAmbiguityKind[v] = (byAmbiguityKind[v] ?? 0) + 1;
      } else if (mark.verdict === "highlighter_misjudge") {
        const v = mark.misjudge_reason ?? "unknown";
        byReason[v] = (byReason[v] ?? 0) + 1;
      }
    }
    return {
      enabled,
      storeText,
      outputDir: dir,
      annotations: marksById.size,
      feedback: feedbackCount,
      byVerdict,
      byErrorType,
      byAmbiguityKind,
      byReason,
      files: { annotations: annotationsFile, feedback: feedbackFile },
    };
  }

  try {
    loadFeedback();
    loadAnnotations();
  } catch (err) {
    logger.warn?.(`annotations: 读取历史数据失败（${err.message}）`);
  }

  return {
    ingest,
    forCapture,
    forSessionTurn,
    findMark,
    applyFeedback,
    stats,
    close() {},
  };
}
