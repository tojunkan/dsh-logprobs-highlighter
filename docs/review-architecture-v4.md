# 审查报告：架构设计 v4（任务 t6）

> 状态：**完成** ｜ 审查员：reviewer ｜ 日期：2026-08-20
> 审查对象：`README.md`（v4）+ `docs/architecture-v4.md`（v4）
> 交叉验证材料：`docs/research-api-logprobs.md`（t1）、`docs/research-dsh-plugin.md`（t2）、`scripts/m0-probe.mjs` 与 `docs/m0-sample*.json`（真实 M0 样本，本次逐条核验原始 chunk 数据）。
> 结论：**发现 2 个阻塞级、4 个重要级、8 个建议级问题。阻塞级修复前，工程师不得开工 M1（t5）。**

---

## 0. 本次核验方式（与仅读文档不同之处）

除通读两份文档外，对 `docs/m0-sample-thinking.json` / `m0-sample-nothinking.json` 的 **231 + 63 个原始 chunk 逐一解析复核**，得到以下独立于文档的基准事实（下文所有判断以此为准）：

| 项 | m0-sample-thinking.json | m0-sample-nothinking.json |
| :--- | :--- | :--- |
| 运行参数 | deepseek-v4-flash，top2，max_tokens=800，思考默认 | 同左，thinking disabled |
| chunk 总数 | 231（含首 chunk role-only，logprobs:null） | 63 |
| reasoning 段 | 205 tokens，1 token/chunk，对齐 205/205 | 0 |
| **content 段** | **24 tokens**（delta 如 `{"content":"202","reasoning_content":null}`），1 token/chunk，**对齐 24/24**，bytes 校验 0 不一致 | 61 tokens，1 token/chunk，对齐 61/61，bytes 0 不一致 |
| 带宽 | 原始 121830 B / 剥皮 67798 B = **x1.797** | 32207 / 17091 = **x1.884** |
| usage | completion 230（reasoning 205 + content 24 + 1） | completion 61 |
| 内嵌 summary 的 content 统计 | **错误**（segments.content.chunks=0，系修复前旧分类器生成，与 raw 数据矛盾） | 正确 |

另核验：首 chunk 两模式均 logprobs:null（✓ README §3.3）；usage 附着末 chunk、[DONE] 到达、finish_reason=stop（✓）；no-thinking 模式 chunk 的 delta **不带** reasoning_content 键（旧分类器在该模式下不犯错，bug 只发生在思考模式的 content chunk）。

---

## 1. 阻塞级（必须修复，否则 M1 不得开工）

### B1. 角色分类规则与实测结论矛盾——文档仍写着导致 t4 bug 的错误规则
- **问题描述**：README §3.3 与 architecture-v4 §0.4.2 均写"思考段 chunk 的 `delta.content` 为 `null`，**角色判定以 `reasoning_content` 字段为准**"。但真实数据（m0-sample-thinking.json raw）显示思考模式下 **content chunk 的 delta 为 `{"content":"202","reasoning_content":null}`——`reasoning_content` 键存在但值为 null**。若按"以 reasoning_content 字段为准"实现（键存在即判 reasoning），24 个 content chunk 会被吞进 reasoning 段——这正是 m0-probe.mjs `classifySegment` 注释记载的、t4 已修复的第二个 bug（"曾把 24 个 content chunk 吞进 reasoning 段"）。文档（实施依据）与已修复脚本规则互相矛盾，M1 照文档实现必然复现该 bug，且 M1 验收 ⑧（双字段捕获对照）失败。
- **严重度**：阻塞
- **位置**：README §3.3；architecture-v4.md §0.4.2（另 README §3.1/§6.1 的描述未受此影响，可保留）
- **建议修法**：两处改为与 `m0-probe.mjs classifySegment` 一致的规则：**① 非空 `content` 优先**（content 与 reasoning 同 chunk 时按 content 算）；② `reasoning_content` 键存在但为 null **不算** reasoning；③ 空内容角色宣告/过渡块按键存在性兜底。并在 M1 验收 ⑧ 中增加"思考模式 content chunk 分类正确（24/24 不被吞入 reasoning）"断言。

### B2. M0 真实数据回填不完整且自相矛盾（docs ↔ 样本文件 ↔ 脚本头部注释 三方不一致）
- **问题描述**（4 个子问题，均以 §0 的 raw 复核为准）：
  - (a) README §5.4、§8 与 architecture-v4 §0.4、§4 称"content 段结构与分块粒度**待二次实测**（max_tokens=800）"，但 max_tokens=800 的真实样本**已存在且 content 段已实测**：thinking 模式 content 24 tokens、no-thinking 61 tokens，均 1 token/chunk、对齐 24/24 与 61/61、bytes 0 不一致。仅"多 token chunk（>1/chunk）"尚未观测到（真实样本全部 1 token/chunk，多 token 拼接仍只有 mock 验证）。
  - (b) README §8 / arch §4 M0 行写"**202 chunks 采样 docs/m0-sample.json**"——`docs/m0-sample.json` 现为 **no-thinking 运行（63 chunks）**；thinking 样本在 `m0-sample-thinking.json`（231 chunks）。"202" 与任何现存文件不符（应为早期 max_tokens=200 运行、已被覆盖）。M1 验收 ⑧ 引用的校验基线文件是错的。
  - (c) `m0-sample-thinking.json` **内嵌 summary**（segments.content.chunks=0、conclusions.content="未出现该段"）由修复前旧分类器生成，与同一文件内的 raw 数据（24 个 content chunk）矛盾；而 `m0-probe.mjs` 头部注释（content 24 tokens）是正确的。引用样本时若用内嵌 summary 会得到错误结论。
  - (d) 带宽数字只回填了 Run A（x1.804，max_tokens=200，content 0 chunk），未回填 Run B 实测 **x1.797（thinking）/ x1.884（no-thinking）**；README §0.1 勘误 #1 把 t1 的桌面估算（x1.68/x2.29、204B/387B）标为"实测"，与真实实测（x1.80–1.88）并存时易混淆。
- **严重度**：阻塞（docs 是实施依据，M1 验收 ⑧ 与 M2 基准数据直接受影响；原始数据完好，修正成本低）
- **位置**：README §0.1、§5.4、§8 M0 行；architecture-v4.md §0.2/§0.4/§4 M0 行；docs/m0-sample-thinking.json（内嵌 summary）
- **建议修法**：① 用修复后的 m0-probe.mjs 重跑（或从 raw 重算）并重新生成 m0-sample-thinking.json 的内嵌 summary；② docs M0 行改为"Run A + Run B 双结果"（含 x1.797/x1.884、thinking content 24 tokens 1/chunk、no-thinking 61 tokens），修正样本文件指针；③ M1 验收 ⑧ 改为"对照 m0-sample-thinking.json **和** m0-sample-nothinking.json 双样本校验"；④ 勘误 #1 的估算数字标注来源（t1 桌面序列化估算）并与真实实测并列。

---

## 2. 重要级（影响正确性/可用性，M1 或 M3 内必须落实）

### I1. 关联器 FIFO 孤儿条目导致错位——比"无数据"更糟的"错数据"
- **问题描述**：流中断/超时/用户中止/上游错误时，反代已把捕获条目压入 FIFO，但 dsh 不会发 `assistant/message`（或发 turn-error/model-retry 后重试）。下一条真实 `assistant/message` 出队时拿到的是**上一次失败尝试**的捕获 → 高亮错位到错误消息，且此后该 session 的关联整体顺移一位。文档风险 #8 的缓解只覆盖"FIFO 空 → captured:false 灰色"，**不覆盖 FIFO 顺移**（顺移产生错误数据而非缺失，违背"宁可无数据不错位"原则）。
- **严重度**：重要
- **位置**：architecture-v4.md §2.2、§3.3、§3.4、§5 风险 #8；README §5.5
- **建议修法**：捕获条目增加 `complete` 标记（以 [DONE]/finish_reason/usage 到达为准，流中止/上游错误则为 aborted）；`assoc.attach` 出队时跳过 aborted 条目并 GC；或利用 assistant/message 载荷（若含 x-request-id 对应关系）做二次校验；文档写明中止/重试语义。

### I2. 反代上游目标未定义——自定义 baseURL 用户会被打到错误上游
- **问题描述**：文档未说明反代转发到哪个上游。若用户原 baseURL 是自定义上游（`$DEEPSEEK_BASE_URL=…`），接管后反代若硬编码 `https://api.deepseek.com`，请求会带着错误密钥打错上游；`/status` 示例的 `upstream: "https://api.deepseek.com"` 暗示硬编码。manageBaseUrl:false 模式下也没有上游配置项。
- **严重度**：重要
- **位置**：architecture-v4.md §1.1 proxy.ts、§2.1、§3.2（/status）、§3.5 Config
- **建议修法**：明确"反代上游 = 接管前的旧 baseURL（baseurl.ts 记录的 original）"；Config 增加 `upstreamBaseUrl`（默认 `https://api.deepseek.com`，manageBaseUrl:false 模式用此配置）；/status 的 upstream 显示实际值。

### I3. settings.yaml 崩溃残留——SIGKILL 后 baseURL 永久指向 8787
- **问题描述**：接管写入的 baseURL 持久化在 `$DSH_HOME/settings.yaml`；dispose 只在正常卸载/禁用时还原。dsh 被 SIGKILL/崩溃时 dispose 不执行，下次启动 llm-deepseek 指向 127.0.0.1:8787；若插件同时加载失败，所有 LLM 请求打向死端口，用户对话全挂且难以自查。
- **严重度**：重要
- **位置**：architecture-v4.md §1.1 baseurl.ts、§2.2 卸载、§5 风险 #7；README §3.6/§7
- **建议修法**：baseurl.ts 启动自愈——apply 时若检测到当前 baseURL == 本插件代理地址，视为"自己写的"：先确保代理监听成功再接管，代理启动失败则回滚还原并打告警；文档补一条崩溃恢复步骤。

### I4. 客户端渲染与 assoc 完成存在竞态——"assoc-pending" 缺客户端重取机制
- **问题描述**：服务端定义了 `notCapturedReason: "assoc-pending"`，但客户端没有"assoc 完成后重新查询"的触发机制（事件重取/轮询/推送均未定义）。若节点渲染时 assoc 未完成 → captured:false → 永久灰色，即使稍后 assoc 完成也不会重试。服务端同步处理事件使窗口极小，但多会话并发/事件顺序不保证时真实存在。
- **严重度**：重要
- **位置**：architecture-v4.md §3.1（assoc-pending）、§1.2 data.ts；README §6.6
- **建议修法**：文档明确客户端重取策略（如 conversationEvents 收到 assistant/message 或 turn/end 后重查一次；或 assoc-pending 时退避重试 N 次；或服务端在 assoc 完成后推送事件）。

---

## 3. 建议级

| # | 问题描述 | 位置 | 建议修法 |
| :--- | :--- | :--- | :--- |
| R1 | "compact 请求透传但不捕获"有歧义：透传指"不注入"还是"注入但不捕获"？ | README §3.4/§5.1；arch §2.2 | 明确为"不注入、不捕获（原样透传）"（与"其余一律原样透传"语义一致、省带宽），或明确为"注入但不捕获"，两文档统一 |
| R2 | `notCapturedReason` 枚举缺"环形淘汰"值（风险 #11 已承诺面板提示"数据已淘汰"） | arch §3.1、§5 风险 #11 | 枚举增加 `"evicted"` |
| R3 | 角色术语不一致：README §6.1 用 `answer`（text），arch §3.1 用 `text` | README §6.1 vs arch §3.1 | 统一为 `text`（与 blocks[].role 一致），M2 前定稿 |
| R4 | README §0.1 勘误 #1 将 t1 桌面估算标为"实测"（x1.68/x2.29、204B/387B） | README §0.1 | 标注"桌面序列化估算（t1 §6）"，与 §5.4 真实实测 x1.797/x1.884 并列 |
| R5 | `marks[].level` 枚举未定义；`captured:false` 响应中 `reasoningState` 行为未定义 | arch §3.1 | 补 level 枚举（high/medium 等）与 captured:false 时 reasoningState 的约定（返回 null 或省略） |
| R6 | `Config.topLogprobs` 用 `z.number()`，未约束 {0,2,5,20} | arch §3.5 | 改用 `z.union([z.literal(0),…])` 或文档注明运行时校验 |
| R7 | 服务端插件 `inject` 列表未写明（settings/webServer/session 依赖声明方式）；t2 §2a 建议 `webServer ?? httpServer` 兜底未体现 | arch §1.1 index.ts、§1.1 routes.ts | 写明服务端 inject 清单与晚绑定兜底（与 t2 一致） |
| R8 | 缺失 `x-deepseek-harness-session-id` 头的请求处理未定义（捕获条目键为 undefined/占环形缓冲） | arch §3.3 | 明确：无 session-id 的请求丢弃捕获或入独立键 + 短 TTL |
| R9 | README §3.4 列出 `x-deepseek-harness-user-id` 头，但 t2 §2c 证据仅确认 session-id 与 compact 两个头 | README §3.4 | M1 联调时实测确认 user-id 头存在性，无则从文档删除 |

---

## 4. 七个审查点结论

1. **模块划分**：通过。server（proxy/capture/assoc/baseurl/routes）+ client（data/turnTail/highlighter）+ shared（types/routes）职责清晰，依赖单向（proxy→capture→assoc→routes）；FIFO 归属 capture.ts 与 §3.3 一致；capture.ts 兼管黑名单可接受。仅 R7（inject 清单未写明）。
2. **插件 API 假设**：全部有 t2 证据支撑——`settings.update` 接管 baseURL 实时生效（t2 §2b，llm-deepseek :705-707/:773-778）；`webServer.register` 路由 + `ctx.effect` + internal/service 晚绑定（t2 §2a，agent-teams 先例）；`session/event` 监听 `assistant/message` 带 turn/step/message.id/usage（t2 §2c，agent-loop :650-658）；keyed 槽 shadowing 低 priority 胜出、`assistant-step` 为内置 key（t2 §3b，ui-slots :70-79/:179-194）；`link:` 安装 + 自动 reconcile（t2 §1）；turnTail chain 槽（t2 §3b :9377-9391）；`MarkdownText`/`ImageGallery` 可复用（t2 §3a/§3b）；package.json 三字段（t2 §1）。
3. **数据流时序**：主链路无缺口；竞态缺口见 I1（FIFO 孤儿/顺移）、I4（assoc 晚于渲染）。流中断/超时/重试/多会话并发的处理需按 I1 补齐。
4. **接口约定**：基本完整可用（captured:false、reasoningState 三态、错误码表齐备）；缺口见 R2（evicted）、R5（level 枚举/captured:false 的 reasoningState 行为）。
5. **里程碑**：M1–M4 验收标准基本可测；M1 验收 ⑧ 引用错误基线文件（B2-b）且缺"content 分类不被吞并"断言（B1）；M0 行需按 B2 更新（content 段结构已实测、剩余未测项为：多 token chunk、非流式无 index 实证、400/422 真实错误体、top_logprobs=0、top5 带宽）。
6. **安全**：127.0.0.1 绑定、密钥只透传不落盘、内存保留、卸载还原 baseURL 均落实；缺口见 I3（崩溃残留）、I2（上游定义影响密钥去向）。
7. **真实数据回填**：字段名与存在性正确（reasoning_content 双字段、首 chunk null、对齐 100%）；但带宽/样本指针/content 段结构结论与样本文件不一致（B2）。原始数据本身可信，问题在文档与内嵌 summary。

---

## 5. 处置建议

1. **先修 B1、B2**（均为文档/数据修正，无需改代码）：由 architect 按 §1 修法更新 README + architecture-v4.md，并用修复后的 m0-probe.mjs 重新生成 m0-sample-thinking.json 内嵌 summary；修完后再开工 M1（t5）。
2. I1、I2、I3 需在 M1 设计中落实（capture 条目加 complete 标记、upstream 来源、baseurl 自愈）；I4 在 M3 前落实。
3. R1–R9 随各里程碑顺手修正，不阻塞。
