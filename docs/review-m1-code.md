# 审查报告：M0/M1 代码（任务 t7）

> 状态：**完成** ｜ 审查员：reviewer ｜ 日期：2026-08-20
> 审查对象：`scripts/m0-probe.mjs`（含 `--replay`）、`lib/{index,shared,proxy,capture,assoc,baseurl,routes,client}.js`、`package.json`、`cordis.patch.yml`、`test/self-test.mjs`
> 对照依据：architecture-v4.md、review-architecture-v4.md（B1/B2/I1–I3 修法）、research-dsh-plugin.md（t2 证据）、m0-sample-*.json（真实基准）
> 结论：**1 个阻塞级、5 个重要级、9 个建议级。阻塞级修复前，真实 dsh 联调不得开始。**

---

## 0. 验证方式（代码通读 + 实跑）

- `node --check` 全部 8 个 lib 文件 + 探测脚本：语法全部通过。
- `node test/self-test.mjs`：**46/46 断言通过**（计数与任务说明一致）。
- 另写 3 个**独立实验**（mock 上游 + 真实 proxy 实例）实证关键怀疑点：
  - **T1** 非流式（application/json）2xx 响应 → `textTokens: 0`（logprobs 未捕获，仅 usage）；
  - **T2** 环形淘汰后 FIFO 未清理 → `pendingAssoc=3`（已淘汰条目仍留队），attach 返回已淘汰条目、query 返回 null；
  - **T3** 上游 gzip SSE → 反代把**解压后明文 body + `content-encoding: gzip` 头**转发给下游，下游 fetch 解压失败（实测 Z_DATA_ERROR 崩溃）；并确认 undici fetch **默认发送 `accept-encoding: gzip, deflate`**。

---

## 1. 阻塞级（修复前不得开始真实 dsh 联调）

### BLK-1. 反代未剔除 `content-encoding`，上游压缩时整条链路崩溃
- **问题描述**：`pickHeaders`（proxy.js:26-39）只剔除 hop-by-hop 头，未剔除 `content-encoding`。undici fetch 会自动解压响应体但**保留该头**（T3 实证：转发出去的是明文 `data: ...` + `content-encoding: gzip`；下游 fetch 收到后尝试 gunzip 明文 → `Z_DATA_ERROR` 崩溃）。且 undici fetch **默认发送 `accept-encoding: gzip, deflate`**（实证）——反代自己就在向上游"请求压缩"，DeepSeek 或用户自定义上游（CDN/网关）一旦压缩 SSE，dsh 端整流失败。影响三条路径：`injected`（注入捕获路径）、`passthrough`（非 DeepSeek/compact/黑名单）、`forwardUpstreamResponse`（400/422 重试与错误转发）。
- **严重度**：阻塞（联调首条真实请求就可能触发；修复一行 + 一条测试）
- **位置**：`lib/proxy.js:26-39`（pickHeaders / HOP_BY_HOP）
- **建议修法**：`HOP_BY_HOP` 增加 `content-encoding`（`content-length` 已在其中）；self-test 增加 gzip mock 用例：上游返回 gzip 胖流 → 断言客户端收到的响应 `content-encoding` 不存在且 body 为明文 `data:` 帧、捕获正常。

---

## 2. 重要级（影响正确性/内存/数据链路，M1 内必须落实）

### IMP-1. 非流式（非 SSE）响应不捕获 logprobs——文档承诺未实现
- **问题描述**：proxy.js:238-259 非流式分支用 `classifySegment(choice?.delta ?? {})` 分类——非流式响应没有 `delta`（是 `choices[0].message`），`{}` 分类为 `"other"` → `lpArr = null` → **content/reasoning logprobs 一条都不捕获**（T1 实证：textTokens=0，仅 usage 与剥皮正常）。文档明确承诺"非流式响应同样支持（`choices[0].logprobs.content[]` 按数组顺序对齐，无 index）"（README §5.2 / arch §1.1/§5 风险 #3）。dsh 恒 `stream:true`，联调不受影响，但 M0 未测项"非流式无 index 实证"与本承诺均要求支持。
- **严重度**：重要
- **位置**：`lib/proxy.js:238-259`
- **建议修法**：非流式分支按 `choice?.message`（content / reasoning_content / tool_calls）分类并读取 `lp.content` / `lp.reasoning_content`；补一条 mock 非流式用例断言捕获 1:1 对齐（含无 index 的双重校验）。

### IMP-2. FIFO 不随环形缓冲淘汰清理——无界内存增长 + 已淘汰条目参与关联
- **问题描述**：`capture.prune`（capture.js:49-56）只从 `ring` 删除并 `byId.delete`，**不清除各 sessionId FIFO 队列中的同一条目**（T2 实证：ringSize=2 存 3 条后 `pendingAssoc=3`；attach 能出队已被淘汰的 complete 条目并写索引，随后 query 因 `byId` 已删返回 null → 客户端灰，但索引悬挂）。长会话 + 大量 aborted/永不关联条目时 FIFO 无界增长（`ringSize` 只约束 ring，不约束 FIFO）——内存上限承诺（README §7"仅内存 20 条/1 小时"）被打破。
- **严重度**：重要
- **位置**：`lib/capture.js:49-56`（prune）、`:86-112`（attach）
- **建议修法**：prune 时遍历 `fifo` 各队列按 `id` 剔除被淘汰条目（或条目加 `evicted` 标记，attach 跳过且 prune 顺带清理）；attach 增加 `byId.has(candidate.id)` 前置校验。

### IMP-3. assoc 事件载荷形状未验证且解析不宽容——形状不符则静默永不关联
- **问题描述**：`assoc.js:21-42` 只读 `event.data` 下的 `turn/step/message/usage`。t2 证据（agent-loop :650-658）只证实 `assistant/message` 载荷**包含** `{turn, step, message:{id}, usage?}`，未证实是事件根字段还是 `event.data` 子字段（t2 同时提到"事件带 seq/time 信封"）。若实际形状为事件根字段，`event.data` 恒为 undefined → `data={}` → 每次 warn"缺 turn/step" → **关联器静默失效**（M3 数据链路整体断裂），且 M1 验收清单没有任何验证关联器的条目。
- **严重度**：重要
- **位置**：`lib/assoc.js:21-42`；对照 architecture-v4 §3.4 与 M1 验收
- **建议修法**：同时兼容两种形状（`const data = event.data ?? event`，或 `event.turn ?? event.data?.turn`）；**M1 联调清单增加硬性一条**：首次 `assistant/message` 时 `logger.info` 打印原始事件 JSON（不含对话内容），人工核对形状后固定解析（可在 M1 验收 ③ 附近加"assoc 日志出现 probe 关联成功"断言）。

### IMP-4. I1（aborted 跳过/GC）无任何测试覆盖——关键语义裸奔
- **问题描述**：complete/aborted 语义（review I1）已在代码实现（proxy finalize + capture.attach 跳过），但 self-test **没有**：① 上游中途截断（end 无 [DONE]/finish/usage）→ `complete:false`；② FIFO 混排 [aborted, complete] → attach 跳过 aborted 并 GC、返回 complete 的用例。该语义是"宁可无数据不错位"的核心，一旦回归（如 complete 判定改错）无测试兜底。
- **严重度**：重要
- **位置**：`test/self-test.mjs`（Part B 缺 aborted 系列）
- **建议修法**：mock 上游对指定请求在 2 个 chunk 后 `res.end()`（不写 [DONE]/finish/usage）→ 断言捕获条目 `complete:false`、`attach` 返回 null（或跳过后续 aborted 命中下一条 complete）、`pendingCount` 只数 complete。

### IMP-5. routes.js / baseurl.js / assoc.js 零测试覆盖——M1 验收 ④⑥ 无测试支撑
- **问题描述**：self-test 只覆盖 `shared/capture/proxy`。M1 验收 ④（`/status` 返回监听与捕获计数）与 ⑥（卸载还原 baseURL、8787 关闭）依赖的 `routes.js`、`baseurl.js` 完全未测；`/tokens` 的 `captured:false`/`assoc-pending`/400 参数校验响应形状、baseurl 的 takeover→restore（比对当前值再还原）/残留自愈（I3）均无断言。
- **严重度**：重要
- **位置**：`test/self-test.mjs`（缺 routes/baseurl 测试）；`lib/routes.js`、`lib/baseurl.js`
- **建议修法**：① 用最小 mock ctx（`settings.get/update` 内存实现 + `on/effect/get` 桩）直测 `createSettingsTakeover`：接管写 `127.0.0.1:8787`、restore 还原原值、当前值被用户改过则不覆盖、残留检测自愈、manageBaseUrl=false 不接管；② 直测 `registerRoutes` 的 handler（注入内存 webServer 桩，调用 handler(req,res) 断言 JSON 形状：captured:true/false、assoc-pending、400 missing-param、/status 字段）。

---

## 3. 建议级

| # | 问题描述 | 位置 | 建议修法 |
| :--- | :--- | :--- | :--- |
| SUG-1 | 非 SSE 分支 `res.write(outText)` 后无显式 `res.end()`，依赖 finally 兜底——目前正确但脆弱 | proxy.js:258 | 该分支显式 `res.end()`，finally 只兜异常路径 |
| SUG-2 | self-test mock 未记录请求头，无"Authorization 原样到达上游"断言；也无"日志不含密钥"检查（安全项） | test/self-test.mjs（B1） | mock 记录 `headers.authorization` 并断言 `=== "Bearer sk-test"`；加一条捕获日志字符串不含密钥的断言 |
| SUG-3 | `notCapturedReason` 仍无 `"evicted"`（review R2 未闭环）——"被淘汰"与"从未捕获"同返 not-found，M3 面板无法提示"数据已淘汰" | routes.js:82-94；capture.js | capture 记录最近 evictedId 集合（小容量）或按 `entry.createdAt` 与 ring 存活窗口判别后返回 `"evicted"` |
| SUG-4 | `assoc.js` 的 `normalizeUsage(usage ?? null)` 结果未使用（attach 忽略 meta.usage）——无害但误导 | assoc.js:35 | 删除该行或注释说明"usage 以流内解析为准" |
| SUG-5 | dispose 回调内 `void (async () => …)` 不 await（index.js:103-110）——cordis 同步 dispose 下进程退出可能截断还原/关闭 | index.js:103 | 同步顺序执行：先 `baseurl.restore()` 的同步部分，再异步 close/clear，或返回 Promise（若 cordis 支持） |
| SUG-6 | 400/422 降级仅测 400 与"重试成功"；422 与"重试仍失败→原样透传错误体"路径无用例（isLogprobsRejection 已支持 422） | test/self-test.mjs（B5/B6） | 补 422 mock 与 retry-also-fails 用例 |
| SUG-7 | `m0-probe --replay` 的"raw 未改动"仅文字声明，无校验和 | scripts/m0-probe.mjs（runReplay） | 写回前对 raw 拼接做 hash 并在汇总打印前后对比结果 |
| SUG-8 | 设计限制（I1 残余）：客户端中止但上游正常完成时，complete 条目仍会与下一次 `assistant/message` 错配（FIFO 无法感知 dsh 侧 abort） | capture.js:86-112；architecture-v4 §5 风险 #8 | M3 联调观察实际频率；可选缓解：assoc 时校验 `|entry.createdAt − message 时间|` 窗口，超阈值跳过；事件若带 x-request-id 则精确匹配 |
| SUG-9 | `client.js` turnTail 注册的 chain 槽签名（name/kind/scope）按 t2 证据无法完全确定，已 try/catch 兜底 | lib/client.js:69-82 | 维持 M1 现状；M3 联调前对照 `dsh-client-ui-conversation` 的 chain 槽定义确认 `slots.register` 参数 |

---

## 4. 六个审查点结论

1. **正确性**：SSE 边界缓冲、`\r\n` 跨 chunk、`[DONE]`/usage/finish 保留、剥皮字段保真均正确（含 46 断言与 T1-T3 实证）；`classifySegment` 三规则与文档/实测完全一致（Part A 24/24 断言直接锁定 B1）；I1 complete/aborted、400/422 降级+黑名单、compact 跳过、R8 无 session-id 均实现。**缺口**：BLK-1（content-encoding）、IMP-1（非流式捕获）、IMP-2（FIFO 泄漏）、IMP-3（assoc 形状）。
2. **安全性**：8787 仅 `127.0.0.1` 监听 ✓；Authorization 只透传、日志扫描无 body/密钥泄露 ✓；内存上限**被 IMP-2 打破**（FIFO 无界）；dispose 还原 baseURL + 关端口 + 清内存 ✓（但 SUG-5 不 await）；I3 启动自愈已实现（等命名空间 + 残留检测 + 代理先启动 + 失败回滚）✓（缺测试，见 IMP-5）。
3. **接口**：`/tokens` 与 `/status` 响应符合 arch §3.1/§3.2（captured:false + notCapturedReason、reasoningState 三态、assoc-pending、message/usage/blocks/marks 齐全，confidence=exp(logprob) 正确）✓；R5 的 captured:false 时 reasoningState=null 已定 ✓；缺 `"evicted"`（SUG-3）。
4. **插件约定**：package.json 三字段（`dsh.bundle.patch`/`dsh.client`{inject,platform}/`exports["./client"]`）✓；cordis.patch.yml insert 行与包名同步 ✓（patch 具体 schema 以 M1 验收①装载为准）；服务端 `inject=["settings"]` + internal/service 重试 ✓；client.js 的 `__ModuleLoader__.load({id, factory})` + apply/inject 写法与 agent-teams 样例一致 ✓。
5. **可测试性**：明确区分"真实样本回放（Part A，复算非新请求）"与"mock 自测（Part B，合成数据）" ✓，46/46 通过；Part A 直接防 B1 回归 ✓。**缺口**：aborted 系列（IMP-4）、routes/baseurl/assoc（IMP-5）、Authorization 断言（SUG-2）、422/重试失败（SUG-6）。
6. **潜在竞态**：settings 命名空间晚就绪（internal/service + 2s 轮询 + 30s 超时）✓；webServer 晚绑定（effect + internal/service）✓；多会话 FIFO 按 sessionId 隔离 ✓；残余竞态见 IMP-3（事件形状）、SUG-8（dsh 侧 abort）。

## 5. review-architecture-v4 修法落实核对

| 修法 | 状态 |
| :--- | :--- |
| B1 三规则（非空 content 优先等） | ✅ shared.js classifySegment 与 proxy.js 一致，Part A 断言锁定；README §3.3 / arch §0.4.2 已同步 |
| B2 数据回填（样本重放 + 双结果 + 指针修正） | ✅ 样本 `--replay` 重生成（content 24/61、对齐 24/24、61/61），docs M0/M1 行已更新，验收⑧改双样本 + 分类断言 |
| I1 complete/aborted + attach 跳过/GC | ✅ 已实现（IMP-4：缺测试；SUG-8：dsh 侧 abort 残余限制） |
| I2 上游来源（managed→original；否则 upstreamBaseUrl） | ✅ index.getUpstream + baseurl 实现，/status 显示实际值（BLK-1 破坏该链路时除外） |
| I3 启动自愈（残留检测→先起代理→失败回滚） | ✅ 已实现（IMP-5：缺测试；enabled=false 路径也有残留兜底） |
| R6 topLogprobs 约束 | ✅ z.union 实现 |
| R8 无 session-id 不入 FIFO | ✅ capture.store 条件入队 |

## 6. 处置建议

1. **先修 BLK-1**（一行 + 一条 gzip 测试），随后即可开始真实 dsh 联调；
2. M1 联调清单补三项硬验证：assoc 原始事件形状打印（IMP-3）、gzip 上游（BLK-1 回归）、/status 与 /tokens 实查（IMP-5 补测后）；
3. IMP-1/2/3 随 M1 收尾修复；IMP-4/5 补测试后自测应达 55+ 断言；
4. SUG-1…9 随各里程碑顺手处理，不阻塞。
