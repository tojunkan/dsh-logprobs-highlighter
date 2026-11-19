#!/usr/bin/env node
/**
 * 重建 annotations / feedback（一次性修复工具）
 *
 * 背景：旧版本按 token.text 累加偏移，DeepSeek 的半个 UTF-8 token
 * (`\xe5\x95` 这类) 会让后续 trigger 全部漂移。本脚本用修正后的
 * tokenSpans(bytes) 重新生成红句 annotation，并按 sentenceKey 迁移
 * 已有人工 feedback。
 *
 * 用法：node scripts/rebuild-annotations.mjs [outputDir]
 * 建议：先停止 dsh，执行后重启。
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createAnnotationStore } from "../lib/annotations.js";

const ROOT = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
  ? join(process.env.DSH_HOME, "logprobs-highlighter")
  : join(homedir(), ".dsh", "logprobs-highlighter");
const OUT = process.argv[2] || ROOT;
const TS = new Date().toISOString().replace(/[:.]/g, "-");

const config = {
  annotationEnabled: true,
  annotationStoreText: "sentence",
  annotationMaxSentenceChars: 500,
  annotationMaxFileBytes: 10 * 1024 * 1024,
  annotationKeepFiles: 20,
  topLogprobs: 5,
  redThreshold: 0.05,
};

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

function parseLines(lines) {
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* skip damaged line */ }
  }
  return out;
}

function captureFiles(dir) {
  const files = [];
  for (const name of readdirSyncSafe(dir)) {
    if (/^captures(\.\d+)?\.jsonl$/.test(name)) files.push(join(dir, name));
  }
  return files.sort();
}

function feedbackFiles(dir) {
  const files = [];
  for (const name of readdirSyncSafe(dir)) {
    if (/^feedback(\.\d+)?\.jsonl$/.test(name)) files.push(join(dir, name));
  }
  return files.sort();
}

function readdirSyncSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function sentenceKeyOf(feedback) {
  if (typeof feedback.sentenceKey === "string" && feedback.sentenceKey) return feedback.sentenceKey;
  return null;
}

function latestBySentenceKey(records) {
  const map = new Map();
  for (const r of records) {
    const key = sentenceKeyOf(r);
    if (!key) continue;
    const prev = map.get(key);
    if (
      !prev
      || (Number(r.revision) || 0) > (Number(prev.revision) || 0)
      || ((Number(r.revision) || 0) === (Number(prev.revision) || 0)
        && (Number(r.createdAt) || 0) > (Number(prev.createdAt) || 0))
    ) {
      map.set(key, r);
    }
  }
  return map;
}

function backupOld(dir, pattern, bucket) {
  const target = join(dir, `bak-${TS}-${bucket}`);
  mkdirSync(target, { recursive: true });
  let moved = 0;
  for (const name of readdirSyncSafe(dir)) {
    if (!pattern.test(name)) continue;
    try {
      renameSync(join(dir, name), join(target, name));
      moved += 1;
    } catch {
      // 忽略单个文件失败，交给调用方提示。
    }
  }
  return { target, moved };
}

const captures = [];
const seen = new Set();
for (const file of captureFiles(OUT)) {
  for (const entry of parseLines(readLines(file))) {
    if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) continue;
    seen.add(entry.id);
    captures.push(entry);
  }
}
captures.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));

const tmp = mkdtempSync(join(tmpdir(), "lph-rebuild-"));
const store = createAnnotationStore({
  outputDir: tmp,
  config,
  logger: { info() {}, warn() {}, debug() {} },
});

for (const entry of captures) {
  try {
    store.ingest(entry);
  } catch {
    // 单条 capture 失败不影响其余数据。
  }
}

const newMarks = parseLines(readLines(join(tmp, "annotations.jsonl")));
const byMarkId = new Map();
const bySentenceKey = new Map();
for (const mark of newMarks) {
  if (!mark?.markId || byMarkId.has(mark.markId)) continue;
  byMarkId.set(mark.markId, mark);
  if (mark.sentenceKey) bySentenceKey.set(mark.sentenceKey, mark);
}

const oldFeedback = [];
for (const file of feedbackFiles(OUT)) oldFeedback.push(...parseLines(readLines(file)));
const latestFeedback = latestBySentenceKey(oldFeedback);
const migratedFeedback = [];
for (const [sentenceKey, feedback] of latestFeedback) {
  const mark = bySentenceKey.get(sentenceKey);
  if (!mark) continue;
  migratedFeedback.push({
    ...feedback,
    feedbackId: `fb-${randomUUID()}`,
    createdAt: Date.now(),
    markId: mark.markId,
    sentenceKey,
    captureId: mark.captureId,
    sessionId: mark.sessionId,
    turn: mark.turn,
    step: mark.step,
    algoVersion: mark.algoVersion,
    migratedFrom: feedback.markId,
  });
}

mkdirSync(OUT, { recursive: true });
const annotationNew = join(OUT, "annotations.rebuild.jsonl");
const feedbackNew = join(OUT, "feedback.rebuild.jsonl");
writeFileSync(annotationNew, newMarks.map((m) => JSON.stringify(m)).join("\n") + (newMarks.length ? "\n" : ""), "utf8");
writeFileSync(feedbackNew, migratedFeedback.map((f) => JSON.stringify(f)).join("\n") + (migratedFeedback.length ? "\n" : ""), "utf8");

const annBackup = backupOld(OUT, /^annotations(\.\d+)?\.jsonl$/, "annotations");
const fbBackup = backupOld(OUT, /^feedback(\.\d+)?\.jsonl$/, "feedback");
renameSync(annotationNew, join(OUT, "annotations.jsonl"));
renameSync(feedbackNew, join(OUT, "feedback.jsonl"));
rmSync(tmp, { recursive: true, force: true });

console.log(JSON.stringify({
  outputDir: OUT,
  captures: captures.length,
  annotations: newMarks.length,
  feedback: migratedFeedback.length,
  orphanedFeedback: latestFeedback.size - migratedFeedback.length,
  backups: { annotations: annBackup, feedback: fbBackup },
}, null, 2));
