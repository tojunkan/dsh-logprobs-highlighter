# dsh 插件机制调研报告（任务 t2）— logprobs 高亮插件可行性验证

> 状态：**整理完成**（素材来自 captain 的调研 subagent，基于安装目录源码 + 实际运行 profile 的第三方插件样例；本报告做抽查复核，关键证据文件均存在）。
> 日期：2026-08-20 ｜ 调研员：researcher
> 调研对象：`/home/unidu/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh/`（**v0.1.0-rc.6**，编译产物）+ 实际运行的 profile `~/.dsh/profiles/web/`（装有 3 个第三方插件，含完整 server+client 双端样例 `@nanmicoder/dsh-agent-teams`）。
> 用途：架构设计 v4（t3）与 M1 插件骨架（t5）的输入。与 [research-api-logprobs.md](research-api-logprobs.md)（t1）配套。

**抽查复核记录**：`lib/bin.js`、`lib/plugin-9h8shc4d.js`、`lib/profile-boot-DG5t9aNs.js` 存在；profile 目录含 `cordis.patch.yml`/`cordis.yml`/`package.json`/`node_modules`；`~/.dsh/settings.yaml` 存在；`node_modules/@nanmicoder/dsh-agent-teams` 的 package.json 确含 `exports["."]`、`exports["./client"]`、`dsh.bundle.patch`，profile package.json 确含 `dependencies`（dsh-memory/dsh-agent-teams/dsh-anchored-standard）与 `dsh.profile.bundles` 有序列表。素材与实况一致。

---

## 1. 插件安装与声明

- 命令入口：`dsh plugin --profile <name> <pnpm args>` 在 profile 目录转发 pnpm（`lib/bin.js:96-105`；`lib/plugin-9h8shc4d.js:108`），首次自动 initProfile；安装成功后**自动 reconcile** `dsh.profile.bundles`（按"已安装依赖中声明了 `dsh.bundle.patch` 的包"重新生成，`plugin-9h8shc4d.js:46-78`），无需手改 manifest。相对路径 `add ./plugin` 或 `add "link:$(pwd)"` 会被解析为绝对路径。
- Profile 目录结构（`~/.dsh/profiles/web/`）：`package.json`（dependencies + `dsh.profile.bundles` 有序层列表）、`cordis.yml`（空根配置，每次启动重写）、`cordis.patch.yml`（用户 patch 层）、`node_modules/`（pnpm 树外插件）。真实样例 package.json：dependencies 含 `@max-null/dsh-memory`、`@nanmicoder/dsh-agent-teams`、`dsh-anchored-standard`；bundles 列表含 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@nanmicoder/dsh-agent-teams`、`dsh-anchored-standard`。
- 配置层叠加顺序（`profile-boot-DG5t9aNs.js:147-153`）：`dsh.profile.bundles` 各 bundle patch → profile 自身 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml`（home 级更高）→ `--patch` overlay。用户 patch 是 YAML 数组：`- id/config`（整体替换该行）、`- insert`（插入新行）、`!!js` 表达式。
- **最小插件包（双端样例 `@nanmicoder/dsh-agent-teams`）**的 package.json 关键字段：

  | 字段 | 值/含义 |
  | :--- | :--- |
  | `name` / `type: "module"` / `main` | 标准 ESM 包 |
  | `exports["."]` / `exports["./client"]` | 服务端入口 + 客户端 bundle 入口 |
  | `dsh.bundle.patch` | 指向 `cordis.patch.yml`（服务端配置注入） |
  | `dsh.client.inject` | 依赖的 client 服务数组，如 `["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-conversation"]` |
  | `dsh.client.platform` | `"web"` |
  | `peerDependencies` | cordis、dsh-llm、react 等 |

  - `cordis.patch.yml` 用 `insert` 把自己的行插入配置树。
  - 服务端入口导出 `name` / `inject`（服务名数组）/ `Config`（schemastery `z.object`）/ `apply(ctx, config)`（cordis v4 标准插件约定）。
  - 纯服务端插件只需 `main` + `peerDependencies`；纯 bundle 插件只需 `dsh.bundle.patch`。

## 2. 服务端插件能力

### 2a. HTTP 服务/中间件 — 可行，机制完备

- `dsh-host-webserver` 提供 `webServer` Service（进程内 `node:http` + 路由注册表）：`register({kind:'exact'|'prefix', path, handler(req,res)})`（`index.js:53-60`），`registerUpgrade`（WebSocket）、`registerFallback`（**唯一 fallback 席位已被前端静态占用**）、`tapIndex`。Config：host `127.0.0.1`、port `3080`（web profile）。
- 第三方先例（agent-teams `lib/index.js:87-171`）：`ctx.get('webServer') ?? ctx.get('httpServer')` 取服务，`ctx.effect(() => webServer.register({kind:'exact', path:'/plugins/dsh-agent-teams/state', handler}), ...)`，并用 `ctx.on('internal/service',...)` 处理晚绑定。客户端直接 fetch 该路由轮询。
- `dsh-api-gateway` = Typert RPC 网关（拦截客户端 `/api` 端点做 C→S 方法派发，`index.js:61-63`），**不是** LLM 反代。`dsh-host-apiproxy` = Web GUI 的 API 实现（session.prompt/history 等），"Transport-agnostic by design: registers no routes"，**也不是**可复用反代。
- 反代落地两种方式：
  - **① 独立端口（推荐）**：插件内 `createServer` 监听 `127.0.0.1:8787`（webserver 包自己就是 node:http，无禁止；baseURL 指 `http://127.0.0.1:8787`，路径拼 `{baseURL}/chat/completions`）——最干净，与 3080 路由表零冲突。
  - **② 同端口**：`webServer.register` 前缀路由（如 `/v1`），baseURL 指 `http://127.0.0.1:3080`；注意 `/api`、`/plugins`、`/plugins/events` 路由已被占用、fallback 被占、不能撞名。

### 2b. 读写其他插件设置（改 llm-deepseek baseURL）— 可行，实时生效

- `dsh-settings` 提供 `settings` 服务：`register(ns, schema, {base})`、`get(ns)`、`update(ns, patch, expectedRevision?)`（merge，`index.js:402`）、`replace`、`mutate`；每命名空间 revision 冲突检测。`installSettingsSection(ctx, ns, schema, entry, hooks)`（`index.js:618-636`）把插件自身配置接上 settings 服务。
- `llm-deepseek`：NS = `settingsNamespace("llm-deepseek")`（`index.js:629`）；Config 含 `baseURL: z.string()`（`:651`）；baseURL 解析（`:705-707`）= `config.baseURL ?? $DEEPSEEK_BASE_URL ?? https://api.deepseek.com`（config 是 settings 解析后的值）；`installSettingsSection`（`:773-778`）→ **写 settings 后下一次请求即用新 baseURL，无需重启**（`dsh-base/cordis.patch.yml:75-79` 注释确认）。
- 实测：`Config({baseURL:'http://127.0.0.1:8787'})` 部分字段可解析（thinking/reasoningEffort 可选），`ctx.settings.update("llm-deepseek", {baseURL:"http://127.0.0.1:8787"})` merge 写入合法。settings 持久化在 `$DSH_HOME/settings.yaml`。
- 注意：llm-deepseek 命名空间注册在 boot 早期，我们插件写它要等命名空间就绪（`ctx.on('internal/service',...)` 重试或 `inject` 顺序保证）。

### 2c. 监听 LLM 流/消息完成事件 — 可行

- 事件源头是 Session：每次 `session.append` 在 emitCtx 派发 `session/event` 参数 `(session, event)`（`dsh-session/lib/index.js:1440-1479`）。监听方式（先例 dsh-token-meter）：`ctx.on("session/event", (session) => {...})`（`dsh-token-meter/lib/index.js:424`）。
- 消息完成事件 = `assistant/message`，agent-loop 在流结束后 append（`dsh-agent-loop/lib/index.js:650-658`）：`{turn, step, message:{id, role:'assistant', content:[blocks], source:{provider,model}}, usage?}`。流式中间事件 `assistant/chunk`；每轮 `turn/start`、`turn/end`。事件带 seq/time 信封与 sourceEventSeqs。
- 客户端经 mux SSE 收到同样 `session/event` 帧。
- **与反代捕获关联**：wire 请求体不含 turn/step（`llm-deepseek serializeRequest :107-135`），headers 只有 `x-deepseek-harness-session-id` 与 `x-deepseek-harness-compact`（`:578-580`）。同会话流式请求**串行**（agent-loop 每次 await 一个 stream），所以**按 sessionId FIFO 匹配**即可把捕获 logprobs 关联到 `(turn, step, message.id)`。compaction 请求带 `compact:1` 可跳过捕获。

## 3. 客户端插件能力

### 3a. 注册/加载 — 可行（真实样例）

- 声明：`dsh-client-modules` 扫描声明 `dsh.client`（platform:"web"）且 `exports["./client"]` 存在的包，组合 `window.__DSH_BOOT__` 图 `{id, url:'/plugins/<id>/client.js?rev=', rev, inject, immediately?}`（`dsh-client-modules/lib/index.js:61-85,248-264`）；webServer 注册 `/plugins` 前缀路由（`:158-162`）并 tapIndex 注入 manifest。
- 浏览器侧：客户端 bundle 是**单个文件**，必须调用 `window.__ModuleLoader__.load({id:"<包名>", factory:(require)=>{...}})` 导出 `apply(ctx)` 与 `inject`（服务名数组）。agent-teams `lib/client.js:1188-1231` 标准样例：`const inject = ["conversationEvents","slots","sessions"]; apply(ctx){ ctx.conversationEvents.register(...); ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({name, key:"agent-teams", inject:()=>({...})}, Component)); }`。
- factory 内 `require()` 只能解析**平台种子词**（react、react-dom/client、`@deepseek-ai/dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-web-react`、`dsh-client-ui-attachment`、`dsh-client-schema-form`）、shell 静态模块、其他已注册 graph 行。打包时这些包要 external，`dsh.client.inject` 声明依赖顺序。
- HMR：`dsh-client-hmr` node 半每 500ms stat 轮询 bundle 文件（`index.js:38,78-91`），变化则 `clientModules.rebuilt(id)` 重哈希并经 `/plugins/events` SSE 广播（`:145-152`）；浏览器半 `EventSource('/plugins/events')` 收到后 invalidate→prefetch→refresh（`client.js:35-85`）。注释明言"without a rebuild watcher (`pnpm run dev:web`) rewriting client bundles, the poll observes no changes"（`dsh-client-hmr/README.md:5`）。**安装版没有 `pnpm run dev:web` 脚本**——安装版对应做法是自行 watch/rebuild 插件包的 client bundle（tsdown 之类）。
- 客户端可注入服务汇总：`connection, typert, remote, remote.commands, modules, loader, slots, layout, sessions, workspaces, locale, conversationEvents, conversationViews, settingsScope`。`dsh-client-ui-primitives` 导出 `MarkdownText, MessageText, Tooltip, HoverCard, StateDot, JsonBlock` 等（`dsh-client-ui-primitives/lib/index.js:5855`）。

### 3b. 消息渲染扩展点 — 部分可行（无"装饰"插槽，有替代路径）

- 槽机制（`dsh-client-ui-slots`）：四种 kind `single/keyed/list/chain`。**keyed 槽**允许同一 key 不同 priority 多次注册，**最低 priority 胜出（shadowing）**（`:70-79, :179-194`）。客户端 API：`ctx.slots.inject(name, () => ctx.slots.register({...}, Component))`（`dsh-client-runtime/lib/client.js:55-110,331-333`）。
- 消息流渲染（`dsh-client-ui-conversation/lib/client.js`）：`ChatNodeSeat → renderSlot("conversation.chat.node", routedOwner, {entryKey: routedNode.kind, ...})`（`:5200-5240`）。内置 key：`user, steering, context, assistant-step, command, manual-compaction, compaction, model-retry, turn-error, turn-max-tokens, turn-tail, unknown`（`:9323-9396`）。assistant 节点数据 `projectAssistant`（`:7380-7403`）：`{status, turn, step, blocks, time, usage?, finalNode?}`，`blocks = toAssistantBlocks(message.content)`，text 块 `{kind:'text', text}`。默认渲染器 `AssistantNodeView`（`:9088-9115`）→ `AssistantMarkdown`（`:9020-9084`）用 `MarkdownText` 渲染 text、`ReasoningRow` 渲染 reasoning、`ImageGallery` 渲染图片。**`AssistantMarkdown`/`ReasoningRow` 未导出**，`MarkdownText` 从 ui-primitives 导出。
- 其他插槽：`conversation.view`（会话视图 tab）、`conversation.chat.commandview`、`conversation.chat.turnTail`（**chain 槽**，scope session，`:9377-9391`）、`settings.general.item` 等。
- **结论：没有 assistant 文本内部装饰插槽（AssistantNodeView 无 children 槽）**。逐 token 上色 + hover 三条路径：

  | 路径 | 做法 | 代价/风险 |
  | :--- | :--- | :--- |
  | ① shadow assistant-step | 注册 `{name:'conversation.chat.node', key:'assistant-step', priority:-10}`，用自己的组件替换默认渲染。`node.data.blocks` 有全部文本，可复用 `MarkdownText` 渲染 markdown、再按 token 切片包 `<span data-token>` 并 hover 显示 top_logprobs | reasoning/图片/流式中断态需自己渲染（reasoning 可简单 pre 化，图片可引 `ImageGallery`——ui-attachment 在种子词里） |
  | ② turnTail chain 槽 | 每条消息下方追加"logprobs 面板/热力条"（不碰消息本体渲染），token 级 hover 放面板内 | **低风险方案**；不显示行内高亮 |
  | ③ 兜底 | body portal 浮层 + DOM 定位（agent-teams ActivityPanel 先例，`lib/client.js:1201-1215`）叠加高亮 | 定位脆弱 |

- 扩展点注册方式（照抄 agent-teams）：`ctx.conversationEvents.register(def)`（自定义 node kind 需定义 `match/start/update/buildViewNode`，`:10157-10204`）+ `ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({name, key, priority, inject}, Component))`。slot 注册 `options.priority` 默认 0，**取低者**。

### 3c. 客户端拿服务端数据 — 可行，多通道

- **HTTP 路由（推荐，先例可证）**：服务端 `webServer.register` 自定义路由，客户端直接 fetch 同源路径。agent-teams 轮询 `/plugins/dsh-agent-teams/state`（`lib/client.js:170-189,896-920`），资产经 `/plugins/dsh-agent-teams/assets` 前缀路由。
- RPC：`ctx.connection.api.*`（typed unary，POST `/api/<method>`）：session.list/history/prompt、settings.update、llm.models、host.describe；`ctx.connection.api.events.mux/host`（SSE 流）；通用通道 `ctx.connection.rpc.call(channel, endpoint, payload, signal)`（`:10093-10114`）；网关可 intercept 新端点。
- 远程事件：`ctx.remote.$on(event, listener)`。
- 对 logprobs 插件：服务端把捕获数据按 `(sessionId, turn, step)` 存内存，客户端渲染 assistant-step 时 `fetch('/plugins/logprobs-highlighter/tokens?session=...&turn=...&step=...')`。

## 4. 开发工作流（安装版 dsh）

- 代码放任意目录（如 `/home/unidu/dsh/logprobs_highlighter/`），然后 `dsh plugin --profile web add "link:/home/unidu/dsh/logprobs_highlighter"`（pnpm symlink 装入 profile node_modules，nodeLinker: hoisted），reconcile 自动加入 bundles。
- 重载：**host 侧改动重启 dsh**；**client 侧改动重打包 bundle**，client-hmr 500ms 轮询到变化即热替换（保险起见刷新页面）。agent-teams README 印证："link: 安装后，改完代码跑 pnpm build 即时生效，不必重装插件（客户端改动需刷新页面，host 侧改动需重启 dsh 服务）"。
- `pnpm run dev:web` 是源码仓库 apps/web 的重建 watcher，**安装版里没有**；安装版自行 watch/rebuild 插件包 client bundle。
- 插件开发文档：安装目录内未找到 SKILL/docs（`dsh-plugin-development` 技能在第三方仓库，如 NanmiCoder/dsh-agent-teams，`npx skills add NanmiCoder/dsh-agent-teams --skill dsh-plugin-development`）。`dsh-app-boot/README.md` 对 profile/patch 层机制描述最完整。可用 `dsh --profile web --dump-config` 离线检查组合后配置树。

## 5. 可行性决策表

### 方案 A：服务端反代（注入 → 分流 → 剥皮 → 捕获 + 改 baseURL）

| 能力 | 结论 | 依据 | 关键限制 |
| :--- | :--- | :--- | :--- |
| 进程内起 HTTP 服务（独立端口 8787） | ✅ **可行，推荐** | webserver 包自身即 node:http；无禁止条款；`createServer` 与 3080 路由表零冲突 | 反代需自己实现完整 HTTP 客户端转发（Node 原生 fetch 即可） |
| 同端口前缀路由（/v1） | ⚠️ 可行但有冲突面 | `dsh-host-webserver` `register({kind:'prefix'})`（index.js:53-60） | `/api`、`/plugins`、`/plugins/events` 已占用、fallback 被占、不能撞名 |
| 把 llm-deepseek baseURL 指向本地 | ✅ **可行，实时生效** | `llm-deepseek index.js:705-707`（config.baseURL ?? $DEEPSEEK_BASE_URL ?? api.deepseek.com）、`:773-778` + `dsh-base/cordis.patch.yml:75-79` 注释 | 需等命名空间就绪（`ctx.on('internal/service',...)` 重试或 inject）；写入持久化于 settings.yaml；`$DEEPSEEK_BASE_URL` 也可覆盖 |
| 注入 logprobs/top_logprobs + 剥皮转发 | ✅ 可行 | 反代是完整 HTTP 服务端/客户端 | 剥皮需保留 `[DONE]`、usage、其余字段原样（与 t1 §2 的 finish/usage 块形态呼应） |
| 捕获流内 logprobs 并关联消息 | ✅ 可行 | `ctx.on('session/event')`（dsh-session index.js:1440-1479；dsh-token-meter :424 先例）；`assistant/message` 带 turn/step/message.id/usage（agent-loop index.js:650-658） | **wire 请求不带 turn/step → 按 sessionId FIFO 关联**（同会话流串行）；compaction（`x-deepseek-harness-compact:1`）跳过或单独标记 |

### 方案 B：客户端 token 高亮渲染

| 能力 | 结论 | 依据 | 关键限制 |
| :--- | :--- | :--- | :--- |
| 客户端插件被 Web 加载 | ✅ 可行 | `dsh-client-modules` 扫描 + `__DSH_BOOT__` 图（index.js:61-85,248-264）；`__ModuleLoader__.load` 样例（agent-teams client.js:1188-1231） | bundle 单文件；require 只能解析种子词/external 列表；打包需 external |
| 拿消息文本/usage | ✅ 可行 | assistant-step node `data.blocks` + `data.usage`（`projectAssistant`，ui-conversation :7380-7403） | blocks 含 text/reasoning/图片等 kind，需按 kind 分流 |
| 拿 logprobs 数据 | ✅ 可行 | 服务端 webServer 自定义路由 + 客户端同源 fetch（agent-teams 轮询先例） | 服务端需内存索引 (sessionId, turn, step) |
| 逐 token 上色 + hover（shadow assistant-step） | ⚠️ **可行但"替换而非装饰"** | keyed 槽 shadowing（低 priority 胜出，ui-slots :70-79,179-194）；无消息内部装饰插槽（AssistantNodeView 无 children 槽） | 需自渲染 reasoning/图片/流式/中断态 chrome；`MarkdownText` 可复用、`ReasoningRow` 未导出；流式期间 logprobs 不完整 → 只对 `status==='settled'` 节点上色 |
| turnTail 面板（消息下方热力条/hover） | ✅ **可行，低风险，推荐 M3 先做** | `conversation.chat.turnTail` chain 槽（ui-conversation :9377-9391） | 不碰消息本体渲染；token hover 在面板内而非行内 |
| portal 浮层兜底 | ⚠️ 兜底可用 | agent-teams ActivityPanel 先例（client.js:1201-1215） | 需 DOM 定位计算，脆弱 |

## 6. 对架构设计的直接启示（供 t3 架构 v4 / t5 M1 使用）

1. **反代形态**：插件内 `createServer` 监听 `127.0.0.1:8787`（独立端口方案，绕开 3080 的 `/api`、`/plugins`、`/plugins/events`、fallback 占用）；`{baseURL}/chat/completions` 路径拼接不变。
2. **baseURL 接管**：`ctx.settings.update("llm-deepseek", {baseURL:"http://127.0.0.1:8787"})` 实时生效、无需重启；但必须**等 `llm-deepseek` 命名空间就绪**（`ctx.on('internal/service', ...)` 重试，或在 `inject` 中声明依赖）；插件卸载/禁用时应恢复原 baseURL（记录旧值，`ctx.on('dispose', ...)` 还原）。
3. **捕获关联模型**：服务端同时做两件事——反代按 `x-deepseek-harness-session-id` FIFO 暂存捕获块；`ctx.on('session/event')` 收 `assistant/message`（带 turn/step/message.id/usage）后按 sessionId 出队关联，内存按 `(sessionId, turn, step)` 存，供客户端查询。`x-deepseek-harness-compact: 1` 的请求跳过捕获（与 README §3.3/§5.1 一致）。
4. **客户端渲染分期**：**M3 先做 turnTail 面板**（低风险，验证数据链路：assistant/message 事件 → 内存捕获 → HTTP 查询 → hover 备选词），**再做 shadow assistant-step** 逐 token 上色（priority:-10；复用 `MarkdownText`；reasoning 块简单 pre 化；图片引 `ImageGallery`；只对 settled 节点上色）。数据接口从一开始就按 `(sessionId, turn, step)` 设计，两种渲染共用。
5. **开发工作流**：`dsh plugin --profile web add "link:<插件目录>"` 装入；client bundle 自行 watch/rebuild（安装版无 `pnpm run dev:web`）；host 改动重启 dsh、client 改动 HMR；`dsh --profile web --dump-config` 离线验证配置树。
6. **事件/数据通道备选**：若不想自建 HTTP 路由，可用 `ctx.connection.rpc.call` 通用通道或 `ctx.remote.$on` 事件；但 HTTP 路由有 agent-teams 先例，最稳。

## 7. 与 t1 报告（research-api-logprobs.md）的交叉核对

| 交叉点 | t1 结论 | 本素材 | 是否矛盾 |
| :--- | :--- | :--- | :--- |
| 带宽/放大倍数 | top2 x1.68 / top5 x2.29（1 token/chunk），README 4–6 倍需修正 | 素材未涉及带宽 | **不矛盾**，互补（t1 已给出修正数字） |
| 模型名与 baseURL 优先级 | deepseek-v4-flash/pro 为官方模型；README 优先级 config → $DEEPSEEK_BASE_URL → 默认 | 素材确认 `llm-deepseek` 解析顺序 `config.baseURL ?? $DEEPSEEK_BASE_URL ?? https://api.deepseek.com`（index.js:705-707） | **一致**，互为佐证 |
| 思考模式 / reasoning 段 | v4 思考模式是默认模式；reasoning_content 是否伴随 logprobs 未确认（M0 必测） | 素材证实客户端 `blocks` 中 reasoning 以独立 kind 出现（`AssistantMarkdown`/`ReasoningRow` 渲染，且 ReasoningRow 未导出） | **不矛盾**；交叉印证 shadow 方案 B1 需自实现 reasoning 渲染的成本 |
| 非流式 logprobs.content 带 index | t1 证伪：官方 schema 无 index 字段，README v3 需修正 | 素材未涉及 | 无新信息；README 修正项保持有效 |
| 请求头 `x-deepseek-harness-*` | README §3.3 列出 session-id / compact 头 | 素材确认 wire headers 只有 `x-deepseek-harness-session-id` 与 `x-deepseek-harness-compact`（llm-deepseek :578-580） | **一致**，且支持"compact 请求跳过捕获"设计 |
| 流式 finish/usage 形态 | t1：finish 块不带 logprobs、usage 在末块 | 素材：agent-loop 在流结束后 append `assistant/message`（带 usage） | **一致**；反代剥皮需保留 usage（呼应 t1 §2.3） |

**结论：两份报告无实质矛盾，互相补充。** 架构 v4 可直接以 t1（API 格式）+ 本报告（插件机制）为双输入。

## 8. 明确"未找到"项（素材 §6 保留）

1. assistant 消息文本内部的自定义装饰/子插槽（未找到——`AssistantNodeView` 无 children 槽）。
2. 安装目录内任何插件开发文档/SKILL（未找到；`dsh-plugin-development` 技能在第三方仓库，可 `npx skills add NanmiCoder/dsh-agent-teams --skill dsh-plugin-development`）。
3. `dsh-host-apiproxy` 中可复用的 LLM 请求反代组件（未找到；它是 Web GUI RPC API 实现，非反代）。
4. dsh 内核对插件自行 `createServer` 监听端口无任何限制（webserver 包自身即 node:http）。

## 9. 证据索引（路径:行号速查）

| 证据 | 位置 |
| :--- | :--- |
| `dsh plugin` 命令转发 pnpm / 自动 reconcile bundles | `lib/bin.js:96-105`；`lib/plugin-9h8shc4d.js:108`；`plugin-9h8shc4d.js:46-78` |
| 配置层叠加顺序 | `lib/profile-boot-DG5t9aNs.js:147-153` |
| webServer 路由注册 API | `dsh-host-webserver/lib/index.js:53-60` |
| agent-teams 服务端路由先例（晚绑定） | `@nanmicoder/dsh-agent-teams/lib/index.js:87-171` |
| settings update(merge)/installSettingsSection | `dsh-settings/lib/index.js:402`、`:618-636` |
| llm-deepseek NS / baseURL schema / 解析 / 接 settings | `dsh-llm-deepseek`（编译产物）`index.js:629`、`:651`、`:705-707`、`:773-778` |
| settings 写后实时生效注释 | `dsh-base/cordis.patch.yml:75-79` |
| session/event 派发 / 监听先例 | `dsh-session/lib/index.js:1440-1479`；`dsh-token-meter/lib/index.js:424` |
| assistant/message 事件载荷 | `dsh-agent-loop/lib/index.js:650-658` |
| wire 请求体/头（无 turn/step；compact 头） | `dsh-llm-deepseek` serializeRequest `:107-135`、headers `:578-580` |
| 客户端模块扫描与 __DSH_BOOT__ 图 / /plugins 路由 | `dsh-client-modules/lib/index.js:61-85`、`:248-264`、`:158-162` |
| 客户端 bundle 样例（inject/apply） | `@nanmicoder/dsh-agent-teams/lib/client.js:1188-1231` |
| client HMR 轮询 / SSE / 无 dev:web 注释 | `dsh-client-hmr/lib/index.js:38,78-91,145-152`；`client.js:35-85`；`README.md:5` |
| keyed 槽 shadowing（低 priority 胜出） | `dsh-client-ui-slots/lib/index.js:70-79`、`:179-194` |
| slots.inject API | `dsh-client-runtime/lib/client.js:55-110`、`:331-333` |
| 消息流渲染 ChatNodeSeat / 内置 key / projectAssistant / 默认渲染器 | `dsh-client-ui-conversation/lib/client.js:5200-5240`、`:9323-9396`、`:7380-7403`、`:9088-9115`、`:9020-9084` |
| turnTail chain 槽 | `dsh-client-ui-conversation/lib/client.js:9377-9391` |
| RPC 通用通道 / conversationEvents register | `dsh-client-runtime`（`connection.rpc.call` `client.js:10093-10114`）；`dsh-client-ui-conversation/lib/client.js:10157-10204` |
| ActivityPanel portal 先例 | `@nanmicoder/dsh-agent-teams/lib/client.js:1201-1215` |
| ui-primitives 导出 | `dsh-client-ui-primitives/lib/index.js:5855` |
| 开发工作流印证（link: + build 即时生效） | `@nanmicoder/dsh-agent-teams/README.md` |

> 注：以上路径为素材作者在编译产物中定位的符号位置；`dsh-*` 内部包路径已按 `@deepseek-ai/dsh/node_modules/@deepseek-ai/*` 惯例缩写，M1 实现时以实际安装树为准。抽查确认的实体：`lib/bin.js`、`lib/plugin-9h8shc4d.js`、`lib/profile-boot-DG5t9aNs.js`、profile 目录结构、`@nanmicoder/dsh-agent-teams`（package.json 的 exports/dsh.bundle.patch/dsh.client 字段）、profile package.json 的 bundles 列表。
