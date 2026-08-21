# 客户端渲染 API 调研报告（任务 t14）— M3.5 正文热力图前置调研

> 状态：**完成**（全部结论基于安装目录源码，`路径:行号` 证据；未找到项已明说）。
> 日期：2026-08-20 ｜ 调研员：researcher
> 调研对象：`/home/unidu/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 下 dsh-client-ui-primitives / dsh-client-ui-conversation / dsh-client-ui-attachment / dsh-client-ui-slots / dsh-client-runtime。
> 用途：M3.5 正文热力图渲染策略（engineer 在等）。与 [research-dsh-plugin.md](research-dsh-plugin.md)（t2）§3a/§3b 配套，本报告补足组件级细节。

---

## 结论速览（每题一行）

1. **MarkdownText 无法通过 props/回调插入 token span**：内部是 micromark→mdast→React 的**私有**渲染管线，text 节点渲染为**纯字符串**（`renderNode` case "text"），无 renderer 映射、无 ref、无 onRender、无 children 槽；唯一内容钩子是 `fileMentions`（仅 inline-code → 按钮）。逐 token 上色**必须自渲染 markdown**（把 micromark/mdast 打包进插件 client bundle，非种子词、允许打包）。
2. **ImageGallery** 导出自 `@deepseek-ai/dsh-client-ui-attachment`（lib/index.js:506）；props `{images, load, align, labels}`；真实用法见 AssistantMarkdown（ui-conversation client.js:9057-9062）。
3. **Tooltip / HoverCard**：engineer 猜测**基本正确**——`HoverCard({anchor, content, ...})` ✓；`Tooltip({label, children, ...})` ✓（label 可为函数；children 必须单个 anchor 元素）。
4. **assistant-step `node.data`**：`{status, turn, step, blocks, time, usage?, finalNode?}`；`status ∈ 'running' | 'settled' | 'interrupted'`；blocks 为 AssistantBlock 联合（text/reasoning/image/tool-call/other）。
5. **turnTail chain 槽的 select**：`ChainSelect<O,M> = (owner) => M | null`（纯函数，**只收 owner props**）；turnTail 的 owner props 实为 **`{turn, seq, openFile}`**（非 `(session, turn)`）；**keyed 槽（conversation.chat.node）不支持 select**（select 是 chain 专属），分发靠 `entryKey`，shadow 注册只需 `{key:'assistant-step', priority:-10}`。

---

## 1. MarkdownText 内部实现与 token 级插入可行性

### 1.1 实现机制（证据）

- 位置：`dsh-client-ui-primitives/lib/index.js`（编译产物单文件）。`MarkdownText = memo(function MarkdownText({ text, streaming = false, codeLabels, fileMentions }) {...})`（**index.js:5544**）。
- **不用 react-markdown**：依赖是 micromark/mdast 全家桶（package.json deps：`mdast-util-from-markdown ^2.0.3`、`mdast-util-gfm ^3.1.0`、`mdast-util-math ^3.0.0`、`micromark-extension-gfm ^3.0.0`、`micromark-extension-math ^3.1.0`、`shiki ^4.3.1`、`katex ^0.16.47`）。
- 管线（文件头注释 index.js:5411-5421）：`parse.ts` 语法（micromark）→ mdast → `render.tsx`（自定义 React 渲染器）。流式时用 `StreamingRenderer`（index.js:5452-5527）增量解析，冻结前部块缓存。
- 渲染产物是 **React 元素树**（`renderSettled`/`StreamingRenderer.render` 返回元素数组，`MarkdownText` 包一层 `<div className=markdown>`，index.js:5563-5566），**不是 HTML 字符串**。
- 渲染器是**模块私有 switch**：`renderNode(node, key, context)`（index.js:5166+），关键一行 **`case "text": return node.value;`（index.js:5168）——text 节点直接返回纯字符串**，不是元素、没有挂载点。inline 容器（p/strong/em/code/link 等）才有 React 元素与 key。

### 1.2 有没有注入入口（逐项否决）

| 假设的入口 | 结论 | 证据 |
| :--- | :--- | :--- |
| 自定义 renderer/组件映射 prop | ❌ 无 | props 只有 `text/streaming/codeLabels/fileMentions`（index.js:5544；types/markdown/MarkdownText.d.ts:32-37） |
| onRender / ref 回调 | ❌ 无 | 同上；函数体无任何回调参数 |
| children 插槽 | ❌ 无 | 产物是固定 `<div className=markdown>`（index.js:5563-5566） |
| 遍历产物替换叶子 | ⚠️ 理论可行但拿不到树 | `renderNode` 是私有函数，`MarkdownText` 只返回最终 div；`extractMarkdownPlainText` 是唯一导出的解析入口（index.js:5844-5853，**只出纯文本**）；`parseGfm`/`parseGfmWithMath`/`IncrementalMarkdownParser` 均未导出（导出清单 index.js:5855） |
| 内容钩子 `fileMentions` | ⚠️ 唯一先例但仅限 inline-code | `fileMentions.resolve(value)` 命中时把 inline-code 渲染成 `<button>`（index.js:5177-5189）；类型 `MarkdownFileMentions`（types/markdown/render.d.ts:52-64）——只能"整 token 变按钮"，不能对任意文本逐 token 上色 |

### 1.3 结论

- **不可行**：通过 MarkdownText 的 props/回调/产物遍历在 token 级插入 `<span>`。
- **可行路径 A（shadow 逐 token 上色）**：shadow `assistant-step` 时**自渲染 markdown**——把 micromark/mdast 系列依赖打包进插件自己的 client bundle（约束只是"种子词必须 external"，自有依赖随便打；版本参照 primitives package.json deps）。自渲染管线里 text 节点按 token 切片包 `<span data-token>` + HoverCard。代价：与原生 MarkdownText 的 GFM/KaTeX/shiki 渲染有差距，需自实现或简化（代码块、表格、数学是重头）。
- **可行路径 B（低风险）**：turnTail 面板——用 `extractMarkdownPlainText(markdown)`（index.js:5844）或直接拼 `blocks` 文本，做"消息下方热力条 + token hover"，完全不碰消息本体渲染。
- **不推荐**：DOM 层 MutationObserver 把渲染后的文本节点切 span（与 React 调和冲突，流式/冻结缓存重渲染时易碎）。

---

## 2. ImageGallery

- **导出包**：`@deepseek-ai/dsh-client-ui-attachment`（lib/index.js:506：`export { AttachmentRail, DropOverlay, ImageGallery, ImageLightbox, MessageImage }`）。该包是种子词（t2 报告 §3a），客户端可直接 import。
- **props**（types/MessageImage.d.ts）：
  ```ts
  function ImageGallery({ images, load, align, labels }: {
    images: readonly { attachment: ImageAttachmentRef }[];
    load: ImageLoader;                 // (attachment) => Promise<string> 会话授权 URL 加载器
    align: 'start' | 'end';
    labels: MessageImageLabels;        // 需自己提供一整组本地化字符串
  }): JSX.Element | null               // images.length===0 时返回 null（index.js:492）
  ```
- **真实用法（一行）**——抄 ui-conversation 的 AssistantMarkdown（dsh-client-ui-conversation/lib/client.js:9057-9062）：
  ```jsx
  <ImageGallery images={group} load={imageLoader} align="start" labels={messageImageLabels(t)} />
  ```
  - `imageLoader = loadImage ?? (() => Promise.reject(...))`（client.js:9021）
  - `messageImageLabels(t)`（client.js:2496-2505）返回的 labels 键：`image` / `open` / `openNamed(label)` / `loading` / `loadFailed` / `lightbox`（lightbox 又含一组键）。**shadow 自渲染时需用自己 locale 命名空间构造同样形状的 labels**（`messageImageLabels` 本身未导出，是模块私有）。
  - `ImageAttachmentRef` 类型来自 `@deepseek-ai/dsh-attachment`（MessageImage.d.ts:1）。
- **注意**：连续 image 块会被 AssistantMarkdown 合并为一组再传（client.js:9048-9056）——shadow 里要复刻这个合并逻辑。

---

## 3. Tooltip / HoverCard

两者均从 `@deepseek-ai/dsh-client-ui-primitives` 导出（index.js:5855）。

### 3.1 Tooltip（index.js:2301；types/Tooltip.d.ts）

```ts
function Tooltip({ label, side = 'right', delayMs = 0, disabled = false, maxWidth, children }: {
  label: string | (() => string);   // 函数形式仅在气泡可见时求值
  side?: 'right' | 'bottom' | 'top'; // 默认 'right'
  delayMs?: number;                  // hover 延迟；键盘焦点立即
  disabled?: boolean;
  maxWidth?: number;
  children: ReactElement;            // 必须"单个 anchor 元素"，ref 会被合并转发
})
```
- **engineer 猜测 `Tooltip({label, children})` 正确**，补充：label 可为解析函数、children 必须单元素（其 ref 与 tooltip 的 ref 合并，index.js:2303-2308）。

### 3.2 HoverCard（index.js:1797；types/HoverCard.d.ts）

```ts
function HoverCard({ anchor, content, openDelayMs = 500, disabled = false, copyText, copyLabel = '复制', copiedLabel = '复制成功' }: {
  anchor: ReactNode;   // hover 目标，渲染在原位（包一层 span）
  content: ReactNode;  // 卡片内容，指针可移入、可读可选
  openDelayMs?: number; disabled?: boolean;
  copyText?: string; copyLabel?: string; copiedLabel?: string;
})
```
- **engineer 猜测 `HoverCard({anchor, content})` 正确**；补充：默认延迟 500ms，可选复制按钮文案。适合做"token hover 备选词卡片"（anchor=上色 span，content=备选词条 + 置信度）。

### 3.3 最小示例（M3.5 用）

```jsx
import { HoverCard, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';

// token 级：anchor 是上色后的 token span
<HoverCard
  anchor={<span data-token="42">2024</span>}
  content={<div>{top.map(a => <div key={a.token}>{a.token}: {Math.exp(a.logprob).toFixed(2)}</div>)}</div>}
/>

// 面板级：label 可为函数（气泡出现才求值）
<Tooltip label={() => `logprob=${lp}`}><span>hover me</span></Tooltip>
```

---

## 4. assistant-step 节点 data 完整结构

### 4.1 `node.data`（projectAssistant，dsh-client-ui-conversation/lib/client.js:7380-7403）

```ts
data = {
  status: 'running' | 'settled' | 'interrupted',  // client.js:7386
  turn: number, step: number,                     // state.turn / state.step（数值型，engineer 已确认）
  blocks: AssistantBlock[],                       // settled?.blocks ?? compactBlocks(state.blocks)
  time: number,                                   // 首个可见 seq 或 settled 时间戳
  usage?: unknown,                                // 仅 finalize 后有（7399）
  finalNode?: AssistantNode,                      // 仅 settled/interrupted 有（7400）
}
```

- status 判定（client.js:7386）：`settled?.interrupted === true ? 'interrupted' : settled === void 0 ? 'running' : 'settled'`。
- **node 从哪来**：ChatNodeSeat 把 `routedOwner = {...owner, node: routedNode}` 传给槽（client.js:5222-5225），`renderSlot("conversation.chat.node", routedOwner, {entryKey: routedNode.kind, hookContext: nodeKey, fallback: <JsonBlock/>})`（client.js:5231-5239）。entryKey 即 node kind（`assistant-step` 等内置 key 列表见 client.js:9323-9396）。

### 4.2 `blocks` 类型（AssistantBlock，dsh-client-runtime/lib/types/client/sessions/conversation.d.ts:30-47；实现 dsh-client-runtime/lib/client.js:6892-6917）

```ts
type AssistantBlock =
  | { kind: 'text';      text: string }                       // 正文，喂给 MarkdownText
  | { kind: 'reasoning'; text: string }                       // 思维链，原生用 ReasoningRow（未导出）
  | { kind: 'image';     attachment: ImageAttachmentRef }     // 图片，喂给 ImageGallery
  | { kind: 'tool-call'; callId: string; name: string; argsRaw: string }  // 工具调用 JSON
  | { kind: 'other';     block: unknown };                    // 未知 → 原生渲染 JsonBlock
```

- 来源：`toAssistantBlocks(message.content)`（client.js:7334；runtime client.js:6884-6886）；流式中由 `updateChunk` 按 chunk.type（block-start/text-delta/reasoning-delta/tool-call-delta/block-end/usage）增量更新（client.js:7257-7304）。
- 默认渲染（AssistantMarkdown，client.js:9020-9084）：text→`<MarkdownText>`、reasoning→`<ReasoningRow>`（未导出，client.js:8948，Think 折叠行）、连续 image 合并→`<ImageGallery>`、tool-call→跳过、other→`<JsonBlock>`；`streaming || interrupted` 时尾部追加"已停止"标记（client.js:9078-9081）。

### 4.3 `finalNode`（client.js:7323-7356）

settled 形态：
```ts
{ kind: 'assistant', seq, messageId: message.id, time, turn, step,
  blocks, usage, timing: { stepStartTime, firstTokenTime, completedTime } }
```
interrupted 形态（无 usage/timing，`interrupted: true`，seq 为合成小数）：`{ kind:'assistant', seq: boundary.seq + offset, time, turn, step, blocks, interrupted: true }`。
类型定义（runtime conversation.d.ts:88-101，`AssistantNode`）另有 `provenance` / `requestConfig` 可选字段。

---

## 5. turnTail chain 槽的 select 签名（+ keyed 槽是否支持 select）

### 5.1 select 的真实类型（dsh-client-ui-slots/lib/types/index.d.ts）

- **`ChainSelect<O, M> = (owner: O) => M | null`**（index.d.ts:223）。文档（:213-222）：**纯函数，只收 owner props**；渲染时按 priority 升序逐条尝试（默认 0，平级按注册顺序），**首个非 null 返回选中该 entry 并把返回值作为组件的 `matched` prop**；全 null 落到 owner 的 fallback。**禁止外部可变读取/副作用**。
- chain 槽注册的 KindOptions：`{ select: ChainSelect<...>（必填）, priority?: number }`（index.d.ts:388-394）。
- 组件侧：chain entry 额外收到框架注入的 `matched` prop（`MatchedShare`，index.d.ts:245-251）。

### 5.2 turnTail 的 owner props（决定 select 的入参）

`TurnTailNodeView` 渲染 chain 子槽（dsh-client-ui-conversation/lib/client.js:9283-9287）：
```js
renderSlotChain("conversation.chat.turnTail", { turn, seq: closing?.finalNode.seq ?? data.seq, openFile })
```
→ **owner props = `{ turn, seq, openFile }`**（`turn` 是 location 的 turn 对象，client.js:9280-9281；`seq` 是结算节点 seq；`openFile` 是文件打开回调）。

### 5.3 结论：用户草稿需修正

- ❌ 用户写的 `select: (session, turn) => ({turn, sessionId: session?.id})` **不符合实际签名**——select 只收 **owner props**（一个参数），不是 (session, turn)。
- ✅ 正确写法（turnTail chain 注册）：
  ```js
  ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
    name: "conversation.chat.turnTail",
    select: ({ turn, seq }) => (turn ? { turn, seq } : null),   // 返回 → matched prop
    priority: 0,
  }, LogprobsPanel));
  ```
  `matched` 即 `{turn, seq}`；组件内用 `useSession`（scope session 注入的 SessionStandardProps，index.d.ts:190、:162-174）取快照/查数据。
- 官方唯一 chain select 先例：`selectApproval({ interactions }) => ... | null`（ui-conversation client.js:9452-9454，注册于 9706）——同样是"owner props 纯函数"。

### 5.4 keyed 槽（conversation.chat.node）**不支持 select**

- keyed KindOptions 只有 `{ key, priority? }`（index.d.ts:378-381）；`select` 只在 chain 的 KindOptions 出现（:388-394）；StoredEntry.select 注释"present exactly on chain-slot entries"（index.d.ts:447）。
- keyed 分发靠 renderSlot 的 `entryKey`（RenderOpts.entryKey，index.d.ts:193；ChatNodeSeat 传 `entryKey: routedNode.kind`，client.js:5231-5233）。
- **shadow assistant-step 注册（无需 select）**：
  ```js
  ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
    name: "conversation.chat.node",
    key: "assistant-step",
    priority: -10,          // 必须严格低于默认 0；同 key 同 priority 会 throw（index.d.ts:381）
    locale: NS,             // 声明后组件 props 注入 t
  }, MyAssistantNodeView));
  ```
  默认 `assistant-step` 注册不带 priority（=0，client.js:9338-9342），`-10` 即可 shadow。组件收到的 props：`node`（routedOwner.node）+ owner 共享（openFile/loadImage/fileMentions/useTurnData/t/renderSlot 等，参考 AssistantNodeView 签名 client.js:9088）+ session 标准 props（useSession）。

---

## 6. 对 M3.5 渲染策略的建议

1. **数据契约先行**：服务端按 `(sessionId, turn, step)` 提供 `GET /plugins/logprobs-highlighter/tokens?session=&turn=&step=`（t2 报告 §3c/§6 已定）；客户端 shadow 或 turnTail 都能从 `node.data.turn/step` 与 `useSession` 拿 sessionId——**两种渲染共用同一接口**。
2. **分两期，M3.5 先做 turnTail 面板**（低风险，验证数据链路）：
   - 注册 chain entry（§5.3 写法），`matched={turn, seq}`；面板内对 `turn` 的 text blocks 逐 token 渲染热力条 + `HoverCard` 备选词；文本可用 `extractMarkdownPlainText`（primitives index.js:5844）取纯文本按 token 切片，或用 blocks 直接拼。
   - 面板可折叠、只在 `status==='settled'`（或 turn 关闭）时请求 logprobs，避免流式期间空转。
3. **shadow assistant-step 逐 token 行内高亮（后置，建议 M4 评估）**：
   - 前提是**自渲染 markdown**（§1.3 路径 A）：把 `micromark-extension-gfm@^3.0.0`、`mdast-util-from-markdown@^2.0.3`、`mdast-util-gfm@^3.1.0` 等打进插件 client bundle；text 节点按 token 切片 `<span data-token>`；token 序列用 t1 报告的 bytes/token 双重对齐。
   - 其余块尽量对齐原生：reasoning→简单 pre 化或自实现 Think 折叠（`ReasoningRow` 未导出，client.js:8948）；连续 image 合并→`<ImageGallery images={group} load={loadImage} align="start" labels={自建 labels}/>`（§2）；tool-call→跳过；other→`JsonBlock`。
   - `priority:-10` shadow；`status==='running'` 时渲染原生降级（或不渲染高亮只渲染文本）；interrupted 尾部加"已停止"。
   - 若不想自渲染整段 markdown，**降级选项**：shadow 内 text 块用 `MarkdownText` 保持原渲染，把逐 token 上色只做在"代码/inline-code 之外"的粗粒度（如按块级着色）——但 token 级精细上色必须自渲染。
4. **低风险补强（不 shadow 也能做）**：README §6.3 最高权重是"数字/人名/API 名/路径"——原生 `MarkdownText` 已有 `fileMentions`（inline-code → 按钮）先例可参考；若只求 inline-code 的 hover，可在 turnTail 面板里对 code 内容单独展示备选词，避免 shadow 成本。
5. **注意**：keyed 槽同 key 同 priority 会 throw（index.d.ts:381）——shadow 的 priority 必须严格 < 0；HMR 重载时重复注册可能触发，注册前判重或幂等处理。

---

## 7. 明确"未找到"项

1. MarkdownText 的自定义 renderer/组件映射、onRender、ref、children 插槽——**未找到**（props 固定 4 个）。
2. `parseGfm` / `parseGfmWithMath` / `IncrementalMarkdownParser` / `renderNode` 的导出——**未找到**（模块私有；唯一导出是 `MarkdownText` 与 `extractMarkdownPlainText`，index.js:5855）。
3. `AssistantMarkdown` / `ReasoningRow` / `messageImageLabels` / `AssistantNodeView` 的导出——**未找到**（ui-conversation 模块私有；`MarkdownText` 与 `ImageGallery` 是替代品）。
4. keyed 槽上的 `select` 支持——**未找到**（select 是 chain 专属，keyed 用 entryKey）。

## 8. 证据索引（路径:行号速查）

| 证据 | 位置 |
| :--- | :--- |
| MarkdownText props 与实现 | primitives `lib/index.js:5544-5567` |
| markdown 管线注释（micromark/mdast/incremental） | primitives `lib/index.js:5411-5421`；`package.json` deps |
| StreamingRenderer | primitives `lib/index.js:5452-5527` |
| **text 节点 → 纯字符串** | primitives `lib/index.js:5168` |
| 私有渲染 switch renderNode | primitives `lib/index.js:5166-5204` |
| fileMentions（inline-code 按钮钩子） | primitives `lib/index.js:5177-5189`；`types/markdown/render.d.ts:52-64` |
| extractMarkdownPlainText（唯一导出解析入口） | primitives `lib/index.js:5844-5853`；导出清单 `:5855` |
| Tooltip | primitives `lib/index.js:2301`；`types/Tooltip.d.ts` |
| HoverCard | primitives `lib/index.js:1797`；`types/HoverCard.d.ts` |
| ImageGallery 实现与导出 | attachment `lib/index.js:491-504,506`；`types/MessageImage.d.ts` |
| ImageGallery 真实用法（含 image 组合并） | ui-conversation `lib/client.js:9048-9062` |
| messageImageLabels（labels 形状） | ui-conversation `lib/client.js:2496-2505` |
| projectAssistant → node.data | ui-conversation `lib/client.js:7380-7403` |
| status 枚举（running/settled/interrupted） | ui-conversation `lib/client.js:7386` |
| finalNode（settled/interrupted 两形态） | ui-conversation `lib/client.js:7323-7356` |
| toAssistantBlocks / AssistantBlock 分类 | runtime `lib/client.js:6884-6917`；`types/client/sessions/conversation.d.ts:30-47,88-101` |
| 流式块增量 updateChunk | ui-conversation `lib/client.js:7257-7304` |
| AssistantMarkdown（块→组件映射） | ui-conversation `lib/client.js:9020-9084` |
| AssistantNodeView（默认渲染器 props） | ui-conversation `lib/client.js:9088-9115` |
| ChatNodeSeat（entryKey 分发 + fallback） | ui-conversation `lib/client.js:5222-5240` |
| assistant-step 默认注册（priority 0） | ui-conversation `lib/client.js:9338-9342` |
| turnTail chain 槽声明（scope session） | ui-conversation `lib/client.js:9377-9391` |
| TurnTailNodeView → renderSlotChain owner props | ui-conversation `lib/client.js:9277-9315`（`9283-9287`） |
| ChainSelect 类型与纯函数约束 | slots `lib/types/index.d.ts:213-223` |
| chain KindOptions（select 必填 + priority） | slots `lib/types/index.d.ts:388-394` |
| keyed KindOptions（key + priority，无 select） | slots `lib/types/index.d.ts:378-381` |
| StoredEntry.select 仅 chain | slots `lib/types/index.d.ts:447` |
| PropsRuntime 组合（session 标准 props） | slots `lib/types/index.d.ts:190` |
| selectApproval 先例 | ui-conversation `lib/client.js:9452-9454,9706` |
