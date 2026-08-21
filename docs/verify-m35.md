# M3.5 联调指引 — 正文逐 token 热力图（shadow assistant-step）

> 状态：待浏览器联调 ｜ 日期：2026-08-20 ｜ 作者：engineer（t13）
> 前置：M1 反代已联调（真实对话可捕获）、M3 turnTail 面板已联调（数据链路
> `/tokens` 可用）；本里程碑在**消息正文**上做逐 token 热力图。

## 0. 原理摘要

- MarkdownText 是封闭 mdast 管线（text 节点渲染为纯字符串，primitives index.js:5168），
  无 token span 注入入口 → **自渲染 markdown**（t14 §1.3 路径 A）。
- micromark/mdast 系列依赖（`mdast-util-from-markdown` + GFM 扩展）**打包进 client
  bundle**（非种子词，esbuild neutral platform 取同构纯 JS 版），自写 mdast→React
  渲染器（`src/client/markdown.js`）；text 节点按捕获 token 序列增量匹配
  （`lib/client-utils.js createTokenMatcher`，M0 对齐语义：token 拼接 === 正文，
  已在真实样本复算验证：thinking 24 / no-thinking 61 tokens 全部还原）。
- shadow：`conversation.chat.node` keyed 槽，`key:"assistant-step"`, `priority:-10`
  （默认 0，低者胜出；keyed 槽无 select——t14 §5.4）。
- 数据：`node.data.{turn,step}`（projectAssistant 数值型）+ kit `sessionId` →
  `GET /plugins/logprobs-highlighter/tokens`；`status==='settled'` 才请求（流式
  running/interrupted 渲染原始文本，不上色）；assoc-pending 退避重取 3 次（I4）。

## 1. 构建

```bash
cd /home/unidu/dsh/logprobs_highlighter
npm install            # esbuild + micromark/mdast devDeps（pnpm 装）
node scripts/build-client.mjs   # 产出 lib/client.js（约 300KB，含 markdown 管线）
node test/self-test.mjs         # 134+ 断言全绿（含 D2 mdast/匹配器单测）
```

改动 `src/client/**`、`lib/client-utils.js` 后重跑构建；刷新浏览器（client-hmr
500ms 轮询，保险起见手动刷新）。

## 2. 联调步骤

1. 确认插件装载、`/status` 正常（M1/M3 已联调）；发一条新消息并等它生成完。
2. **正文着色**：已完成的助手消息正文应逐 token 上色——**浅色底**（`hsl(hue,80%,85%)`，
   蓝=高置信、红=低置信、灰=无数据），hover 加深。
3. **hover 备选词**：悬停任意着色 token 弹出 HoverCard：token 原文、logprob、置信度、
   **Top-N 备选条形图**（宽度=概率相对占比，hover 显示数值）。
4. **代码块保守着色**：``` 段以 `<pre>` 渲染，只对**数字/标识符**上色（语法符号
   如 `{`、`=`、`(` 不上色）。
5. **reasoning 灰色折叠**：思考段折叠为灰色 `<details>`，展开显示原文（有概率数据
   但不标记，README §7.1；summary 即注明）。
6. **流式期间不上色**：消息生成过程中（running）显示原始文本；生成完毕（settled）
   自动切换为热力图（keyed 槽快照驱动重渲染）。
7. **面板共存**：turnTail 面板（M3 总览）仍在消息下方，与正文热力图数据一致。
8. 无捕获/非 DeepSeek 消息：正文按普通 markdown 渲染（无着色），不破坏阅读。

## 3. 验收点（对照 README §8 M3.5 行）

| # | 验收点 | 期望 |
| :--- | :--- | :--- |
| ① | 消息正文热力图 | 逐 token 浅色底（红→蓝 + 灰），markdown（标题/列表/表格/加粗/行内码）渲染不回归 |
| ② | hover 备选词 | HoverCard 显示原文/logprob/置信度/Top-N 条形图 |
| ③ | 代码块保守着色 | `<pre>` 渲染，仅数字/标识符上色，语法符号零上色 |
| ④ | reasoning 折叠灰 | 折叠展示、展开灰色、hover 注明"有概率数据但不标记" |
| ⑤ | 流式结算后上色 | running 原样文本 → settled 后上色；interrupted 显示"（已停止）" |
| ⑥ | 与 M3 面板数据一致 | 同一 (sessionId,turn,step) 的捕获，正文与面板颜色/数值一致 |

## 4. 常见问题

- **正文没上色**：确认 bundle 已重建（步骤 1）且消息已 settled；浏览器 Network 看
  `/tokens` 请求是否 200 且 `captured:true`；`captured:false` 时按设计降级为无着色。
- **控制台 `assistant-step shadow 注册失败`**：keyed 槽参数与当前 dsh 版本不符，
  对照 `dsh-client-ui-conversation` 的 assistant-step 默认注册（client.js:9338-9342）
  修正；注意同 key 同 priority 会 throw，勿与默认 0 冲突。
- **markdown 渲染差异**：自渲染器覆盖 heading/list/link/table/blockquote/code 等
  常用语法；数学（KaTeX）/高亮（shiki）未实现——此类内容按普通文本/代码渲染。
- **性能**：bundle 约 300KB 一次性加载；每次 settled 渲染做一次 `/tokens` 请求，
  热力图只在有捕获的消息上出现。

## 5. git 历史（用户要求两个 commit）

1. `fix(client): turnTail select 官方签名`（chain 槽 select 单参数修正，独立提交）；
2. `feat(client): M3.5 shadow assistant-step 正文逐 token 热力图`（本里程碑全部改动）。
