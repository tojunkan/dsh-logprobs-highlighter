/**
 * logprobs-highlighter — 捕获存储（内存环形缓冲 + 模型黑名单 + sessionId FIFO + 关联索引）
 *
 * 结构与语义（architecture-v4 §3.3 / README §5.3 / §5.5）：
 * - 环形缓冲：默认 20 条 / 1 小时（ringSize / ringTtlMs 可配，先到先淘汰）
 * - 每请求一条 CaptureEntry：{ id, sessionId, compact, model, createdAt,
 *   reasoningState, complete, blocks[3], usage, assoc }
 * - complete 语义（I1）：complete:true（[DONE]/finish_reason/usage 到达）可参与关联；
 *   complete:false = aborted（流中止/上游错误）不参与关联——assoc.attach 出队时
 *   跳过 aborted 并 GC（防 FIFO 顺移错位，宁可无数据不错位）
 * - sessionId FIFO：按 x-deepseek-harness-session-id 入队待关联；无 session-id 头
 *   的请求（R8）不入队（无法关联），仅保留在环形缓冲供 /status 可见
 * - 关联索引：Map<sessionId, Map<"turn:step", probeId>>（assoc.attach 写入）
 * - 模型黑名单：400/422 降级成功后记忆"该模型不支持 logprobs"，后续直接透传不注入
 *
 * @module logprobs-highlighter/capture
 */

/** 新建捕获条目（blocks 初始为三角色空数组）。 */
export function createEntry({ id, sessionId, compact = false, model, createdAt = Date.now() }) {
  return {
    id,
    sessionId: sessionId ?? null,
    compact,
    model,
    createdAt,
    reasoningState: "unknown", // present | absent | unknown（流结束时定论）
    complete: false, // 流正常结束 = true；中止/上游错误 = false（aborted）
    blocks: [
      { role: "text", tokens: [] },
      { role: "reasoning", tokens: [] },
      { role: "tool-call", tokens: [] },
    ],
    usage: null,
    assoc: null, // 关联前为 null；关联后 { turn, step, messageId, at }
  };
}

export function createCaptureStore(config, logger) {
  const { ringSize = 20, ringTtlMs = 3600_000 } = config || {};
  const ring = []; // CaptureEntry[]（先到先淘汰）
  const byId = new Map(); // probeId -> CaptureEntry
  const fifo = new Map(); // sessionId -> CaptureEntry[]（待关联队列，含 aborted，由 attach 跳过并 GC）
  const index = new Map(); // sessionId -> Map<"turn:step", probeId>
  const blockedModels = new Set(); // 模型黑名单（不支持 logprobs）
  let evictedCount = 0;

  /**
   * 淘汰：超过 ringSize 或超过 ringTtlMs 的旧条目（先到先淘汰）。
   * IMP-2：同步清理各 sessionId FIFO 队列中的同一条目（防无界内存增长 +
   * 防"已淘汰条目仍参与关联"——否则 attach 会出队已淘汰条目写悬挂索引）。
   */
  function prune() {
    const now = Date.now();
    const evicted = [];
    while (ring.length > 0 && (ring.length > ringSize || now - ring[0].createdAt > ringTtlMs)) {
      const e = ring.shift();
      byId.delete(e.id);
      evicted.push(e);
      evictedCount++;
    }
    if (evicted.length === 0) return;
    const evictedIds = new Set(evicted.map((e) => e.id));
    for (const q of fifo.values()) {
      for (let i = q.length - 1; i >= 0; i--) {
        if (evictedIds.has(q[i].id)) q.splice(i, 1);
      }
    }
    for (const [k, q] of fifo) if (q.length === 0) fifo.delete(k);
  }

  /**
   * 存入捕获条目（流结束后由 proxy 调用）：
   * - 压入环形缓冲（含 aborted，供 /status 与诊断可见）；
   * - 有 sessionId 且非 compact → 压入 sessionId FIFO 待关联（aborted 也入队，
   *   由 attach 跳过并 GC，语义与"出队时跳过 aborted"一致）。
   */
  function store(entry) {
    ring.push(entry);
    byId.set(entry.id, entry);
    prune();
    if (entry.sessionId && !entry.compact) {
      let q = fifo.get(entry.sessionId);
      if (!q) {
        q = [];
        fifo.set(entry.sessionId, q);
      }
      q.push(entry);
    }
  }

  /**
   * 出队并关联（assoc 模块在 assistant/message 事件时调用）：
   * 按 sessionId 从 FIFO 头部取一条——跳过 aborted（complete:false）条目并 GC；
   * 命中 complete 条目 → 写索引 (sessionId, "turn:step") → probeId、填 entry.assoc，
   * 返回条目；FIFO 空/全是 aborted → 返回 null（客户端查询得 captured:false）。
   * @param {string} sessionId
   * @param {{turn:number, step:number, messageId:string|null, usage:object|null}} meta
   */
  function attach(sessionId, meta) {
    const q = fifo.get(sessionId);
    if (!q || q.length === 0) return null;
    let entry = null;
    while (q.length > 0) {
      const candidate = q.shift(); // GC：无论命中与否都移出队列
      // IMP-2 兜底：prune 已同步清理 FIFO，但双保险——环形缓冲中已不存在的条目
      // （异常路径/未来改动）一律跳过，不写悬挂索引。
      if (!byId.has(candidate.id)) continue;
      if (candidate.complete) {
        entry = candidate;
        break;
      }
      // aborted：跳过（继续看下一条）
    }
    if (!entry) return null;
    entry.assoc = {
      turn: meta.turn,
      step: meta.step,
      messageId: meta.messageId ?? null,
      at: Date.now(),
    };
    let perSession = index.get(sessionId);
    if (!perSession) {
      perSession = new Map();
      index.set(sessionId, perSession);
    }
    perSession.set(`${meta.turn}:${meta.step}`, entry.id);
    return entry;
  }

  /** 查询：索引命中返回 CaptureEntry，未命中返回 null。 */
  function query(sessionId, turn, step) {
    const perSession = index.get(sessionId);
    if (!perSession) return null;
    const probeId = perSession.get(`${turn}:${step}`);
    if (!probeId) return null;
    return byId.get(probeId) ?? null;
  }

  /** 某 session 是否还有未关联的完整条目（用于 /tokens 返回 assoc-pending）。 */
  function pendingCount(sessionId) {
    const q = fifo.get(sessionId);
    if (!q || q.length === 0) return 0;
    let n = 0;
    for (const e of q) if (e.complete) n++;
    return n;
  }

  function markUnsupported(model) {
    if (model) blockedModels.add(model);
  }

  function isSupported(model) {
    return !blockedModels.has(model);
  }

  /** /status 快照。 */
  function stats() {
    let pendingAssoc = 0;
    for (const q of fifo.values()) pendingAssoc += q.length;
    return {
      ringSize,
      ringTtlMs,
      entries: ring.length,
      pendingAssoc,
      indexEntries: index.size,
      blockedModels: [...blockedModels],
      evictedCount,
    };
  }

  /** dispose：清空内存。 */
  function clear() {
    ring.length = 0;
    byId.clear();
    fifo.clear();
    index.clear();
    blockedModels.clear();
  }

  if (logger?.debug) logger.debug(`capture store ready: ringSize=${ringSize} ringTtlMs=${ringTtlMs}`);

  return { store, attach, query, pendingCount, markUnsupported, isSupported, stats, clear };
}
