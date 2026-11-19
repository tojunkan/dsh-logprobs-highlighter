/**
 * logprobs-highlighter — 捕获存储（内存环形缓冲 + 模型黑名单 + sessionId FIFO + 关联索引）
 *
 * provider 模式下 sessionId 由 `GenerateOptions.sessionId` 直传（不再依赖 HTTP 头），
 * turn/step 仍由 assoc 监听 `assistant/message` 补上。
 *
 * - 环形缓冲：默认 20 条 / 1 小时（ringSize / ringTtlMs 可配，先到先淘汰）
 * - 每请求一条 CaptureEntry：{ id, sessionId, provider, model, purpose, createdAt,
 *   durationMs, chunks, reasoningState, complete, blocks[3], usage, assoc }
 * - complete：流正常收尾（finish/usage）为 true；中止/上游错误为 false（aborted），
 *   assoc.attach 出队时跳过并 GC（宁可无数据不错位）
 * - sessionId FIFO：有 sessionId 且非辅助请求（compaction / session-title）才入队
 * - 关联索引：Map<sessionId, Map<"turn:step", probeId>>（assoc.attach 写入）
 * - 模型黑名单：400/422 且报 logprobs 不支持 → 记入黑名单，后续请求不再注入
 *
 * @module logprobs-highlighter/capture
 */

/** 新建捕获条目（blocks 初始为三角色空数组，text 为累积正文）。 */
export function createEntry({ id, sessionId, provider = null, model, purpose = null, createdAt = Date.now() }) {
  return {
    id,
    sessionId: sessionId ?? null,
    provider,
    model,
    purpose, // null | 'compaction' | 'session-title'
    compact: purpose !== null,
    createdAt,
    durationMs: null,
    chunks: 0,
    reasoningState: "unknown", // present | absent | unknown（流结束时定论）
    complete: false, // 流正常结束 = true；中止/上游错误 = false（aborted）
    blocks: [
      { role: "text", text: "", tokens: [] },
      { role: "reasoning", text: "", tokens: [] },
      { role: "tool-call", text: "", tokens: [] },
    ],
    usage: null,
    sampling: null, // { temperature, topP, thinking, reasoningEffort }（用于标签可比性）
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
    // 辅助请求（compaction / session-title）不参与消息关联，但仍留在环形缓冲里
    // 供 /status 与落盘分析。已预绑定（bind）的条目也不需要 FIFO。
    if (entry.sessionId && !entry.purpose && !entry.assoc) {
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

  /**
   * 预绑定：provider 在请求发出前就能从 session 的 `step/start` 事件读到
   * 当前 (turn, step)（dsh 在每次 LLM 请求前 append 它）。提前绑定后条目
   * 不再入 FIFO，避免流结束后 `assistant/message` 迟到造成错位。
   * @param {object} entry
   * @param {{turn:number, step:number, messageId?:string|null}} meta
   */
  function bind(entry, meta) {
    if (!entry || !entry.sessionId) return null;
    if (typeof meta?.turn !== "number" || typeof meta?.step !== "number") return null;
    entry.assoc = {
      turn: meta.turn,
      step: meta.step,
      messageId: meta.messageId ?? null,
      at: Date.now(),
    };
    let perSession = index.get(entry.sessionId);
    if (!perSession) {
      perSession = new Map();
      index.set(entry.sessionId, perSession);
    }
    perSession.set(`${meta.turn}:${meta.step}`, entry.id);
    return entry;
  }

  /** 某 session 是否还有未关联的完整条目（用于 /tokens 返回 assoc-pending）。 */
  function pendingCount(sessionId) {
    const q = fifo.get(sessionId);
    if (!q || q.length === 0) return 0;
    let n = 0;
    for (const e of q) if (e.complete) n++;
    return n;
  }

  /** 最近条目（新→旧），供 /debug 与 /captures 使用。 */
  function list(limit = 20) {
    const n = Math.max(0, Math.min(Number(limit) || 0, ring.length));
    return n === 0 ? [] : ring.slice(-n).reverse();
  }

  /**
   * 按 turn 取“最后一个有正文的 step”（前端只知道 turn，不知道 step）。
   * @param {string} sessionId
   * @param {number} turn
   */
  function latestByTurn(sessionId, turn) {
    const perSession = index.get(sessionId);
    if (!perSession) return null;
    let best = null;
    for (const [key, id] of perSession) {
      const [t, s] = key.split(":").map(Number);
      if (t !== turn) continue;
      const entry = byId.get(id);
      if (!entry) continue;
      if ((entry.blocks?.[0]?.tokens?.length ?? 0) === 0) continue;
      if (!best || s > best.step) best = { step: s, entry };
    }
    return best ? best.entry : null;
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

  return { store, attach, bind, query, latestByTurn, pendingCount, list, markUnsupported, isSupported, stats, clear };
}
