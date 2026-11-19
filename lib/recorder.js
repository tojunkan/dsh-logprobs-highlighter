/**
 * logprobs-highlighter — 捕获数据落盘器（JSONL，异步追加，失败不阻塞主流程）
 *
 * 目的：把"送给 HTTP 接口的同一份捕获数据"再写一份到磁盘，供离线分析
 * （token 粒度分布、置信度直方图、突变点统计等）。
 *
 * 文件（默认目录 `$DSH_HOME/logprobs-highlighter`）：
 * - `captures.jsonl`：每条流一行，**全量**（blocks + 每 token + top_logprobs）
 * - `summary.jsonl`：每条流一行，轻量统计（分析脚本优先扫这个）
 *
 * 体积控制：单文件超过 `maxFileBytes`（默认 50 MB）时轮转，
 * `captures.jsonl` → `captures.1.jsonl` … 最多保留 `keepFiles` 份。
 *
 * @module logprobs-highlighter/recorder
 */

import { appendFile, mkdir, stat, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** `$DSH_HOME` 默认值（与 dsh-home-paths 一致）。 */
function defaultHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), ".dsh");
}

/**
 * 轻量摘要：只留分析必需的数字，不重复正文。
 * @param {object} entry 捕获条目
 */
export function summarize(entry) {
  const text = entry.blocks.find((b) => b.role === "text");
  const reasoning = entry.blocks.find((b) => b.role === "reasoning");
  const tool = entry.blocks.find((b) => b.role === "tool-call");

  const textTokens = text ? text.tokens : [];
  const lpValues = [];
  let min = null;
  let low10 = 0;
  let low1 = 0;
  let sentinel = 0;
  for (const t of textTokens) {
    if (typeof t.logprob !== "number") continue;
    if (t.logprob <= -9998) {
      sentinel += 1;
      continue;
    }
    lpValues.push(t.logprob);
    if (min === null || t.logprob < min) min = t.logprob;
    const p = Math.exp(t.logprob);
    if (p < 0.1) low10 += 1;
    if (p < 0.01) low1 += 1;
  }

  return {
    at: entry.createdAt,
    id: entry.id,
    sessionId: entry.sessionId,
    turn: entry.assoc ? entry.assoc.turn : null,
    step: entry.assoc ? entry.assoc.step : null,
    model: entry.model,
    provider: entry.provider,
    purpose: entry.purpose ?? null,
    complete: entry.complete,
    durationMs: entry.durationMs ?? null,
    chunks: entry.chunks ?? null,
    reasoningState: entry.reasoningState,
    usage: entry.usage,
    counts: {
      textTokens: textTokens.length,
      reasoningTokens: reasoning ? reasoning.tokens.length : 0,
      toolCalls: tool ? tool.tokens.length : 0,
      lowConfidence10: low10,
      lowConfidence1: low1,
      sentinel,
    },
    minLogprob: min,
    textChars: text ? (text.text ?? "").length : 0,
    reasoningChars: reasoning ? (reasoning.text ?? "").length : 0,
  };
}

/**
 * 创建落盘器。
 *
 * @param {object} config { outputDir?, maxFileBytes?, keepFiles?, recordFull? }
 * @param {object} logger
 */
export function createRecorder(config = {}, logger = console) {
  const outputDir = config.outputDir && config.outputDir.length > 0
    ? config.outputDir
    : join(defaultHome(), "logprobs-highlighter");
  const maxFileBytes = typeof config.maxFileBytes === "number" && config.maxFileBytes > 0
    ? config.maxFileBytes
    : 50 * 1024 * 1024;
  const keepFiles = typeof config.keepFiles === "number" && config.keepFiles > 0 ? config.keepFiles : 5;
  const recordFull = config.recordFull !== false;

  const fullPath = join(outputDir, "captures.jsonl");
  const summaryPath = join(outputDir, "summary.jsonl");

  let ready = null;
  let fullBytes = 0;
  let summaryBytes = 0;
  let written = 0;
  let failed = 0;
  let warned = false;
  let writing = false;
  const queue = [];

  /** 目录 + 现有文件大小（只做一次）。 */
  function ensureReady() {
    if (ready) return ready;
    ready = (async () => {
      await mkdir(outputDir, { recursive: true });
      try { fullBytes = (await stat(fullPath)).size; } catch { fullBytes = 0; }
      try { summaryBytes = (await stat(summaryPath)).size; } catch { summaryBytes = 0; }
    })().catch((err) => {
      if (!warned) {
        warned = true;
        logger.warn?.(`recorder: 初始化落盘目录失败（${err.message}），本次运行不落盘`);
      }
      ready = Promise.resolve();
    });
    return ready;
  }

  /** 轮转：current → current.1 → … → 删除最旧。 */
  async function rotate(currentPath) {
    for (let i = keepFiles - 1; i >= 1; i--) {
      const from = i === 1 ? currentPath : `${currentPath.replace(/\.jsonl$/, "")}.${i - 1}.jsonl`;
      const to = `${currentPath.replace(/\.jsonl$/, "")}.${i}.jsonl`;
      try { await rename(from, to); } catch { /* 源文件不存在，跳过 */ }
    }
    try { await unlink(`${currentPath.replace(/\.jsonl$/, "")}.${keepFiles}.jsonl`); } catch { /* 不存在 */ }
  }

  /** 串行写队列（避免并发 append 交错）。 */
  async function flush() {
    if (writing) return;
    writing = true;
    try {
      while (queue.length > 0) {
        const item = queue.shift();
        try {
          if (item.full !== null && recordFull) {
            if (fullBytes + item.full.length > maxFileBytes) {
              await rotate(fullPath);
              fullBytes = 0;
            }
            await appendFile(fullPath, item.full, "utf8");
            fullBytes += Buffer.byteLength(item.full);
          }
          if (summaryBytes + item.summary.length > maxFileBytes) {
            await rotate(summaryPath);
            summaryBytes = 0;
          }
          await appendFile(summaryPath, item.summary, "utf8");
          summaryBytes += Buffer.byteLength(item.summary);
          written += 1;
        } catch (err) {
          failed += 1;
          if (!warned) {
            warned = true;
            logger.warn?.(`recorder: 写入失败（${err.message}），后续记录将跳过落盘`);
          }
        }
      }
    } finally {
      writing = false;
    }
  }

  /**
   * 记录一条捕获（同步入队，磁盘写入异步）。
   * @param {object} entry capture store 的条目
   */
  function record(entry) {
    if (!entry) return;
    if (!ready) ensureReady();
    let summary;
    try {
      summary = JSON.stringify(summarize(entry)) + "\n";
    } catch {
      return;
    }
    let full = null;
    if (recordFull) {
      try {
        full = JSON.stringify(entry) + "\n";
      } catch {
        full = null;
      }
    }
    queue.push({ full, summary });
    // 落盘永不阻塞调用方（provider 的 stream 收尾）。
    setImmediate(() => { void flush(); });
  }

  function stats() {
    return {
      outputDir,
      recordFull,
      written,
      failed,
      queued: queue.length,
      fullBytes,
      summaryBytes,
      files: { captures: fullPath, summary: summaryPath },
    };
  }

  /** 等待队列写完（测试/dispose 用）。 */
  async function close() {
    await ensureReady();
    await flush();
  }

  return { record, stats, close };
}