# 审查报告：M3.5 正文热力图代码（任务 t15）

> 状态：**完成** ｜ 审查员：reviewer ｜ 日期：2026-08-21
> 审查对象（t13 交付，commit 0ddee7e + fcf6cae）：`src/client/{markdown,highlighter,tokens,index,panel}.js`、`lib/client-utils.js`、`scripts/build-client.mjs`、`test/self-test.mjs` Part D2
> 对照依据：`docs/research-client-render.md`（t14）、architecture-v4 §1.2/§3.1、README §7.1 色阶公式、`docs/verify-m35.md`
> 结论：**0 阻塞 / 4 重要 / 8 建议**。当前两个 commit 可保留；重要级建议在联调前后尽快修复（均为小改动）。

---

## 0. 验证方式（通读 + 实跑 + 独立实验）

- `node test/self-test.mjs`：**134/134 通过**（与任务说明总数一致；注意 Part D2 实际为 **16 项**断言而非描述的 20 项——总数不受影响，属描述小误差）。
- **构建可复现性**：重跑 `node scripts/build-client.mjs` 后与已提交的 `lib/client.js` **字节级一致**（306.2 KB）✓。
- 独立实验（本审查新增）：
  - **R1 真实数据回放**：用 `docs/m0-sample-nothinking.json` 的 61 个真实 content token 喂给 `createTokenMatcher`，对拼接正文逐字符匹配 → **61/61 全消费、`join(segments) === text` 成立**（无丢字符/重复/错位）；
  - **R2 卡死游标**：构造"图片 markdown 字符在捕获 token 中但不在任何 text 块"的序列 → 图片之后的所有文本块**完全不上色**（游标卡在第一个找不到的 token，`break` 后每个后续块都提前退出）；
  - **R3–R7 边界**：markdown 语法 token（`**加粗**`）、重复 token、列表标记、inline-code 反引号、文本内多余字符——全部正确重建；
  - **link scheme 实测**：`[x](javascript:alert(1))` 与 `data:text/html,hi` 被原样渲染为 `<a href>`（无 scheme 白名单）；`image` 的 javascript: src 被正确拒绝（http(s) 白名单生效）。

---

## 1. 重要级

### IMP-1. token 匹配器卡死游标：图片/文本块外 token 序列使其后所有文本块不上色
- **问题描述**：`match()`（lib/client-utils.js:181-216）对"当前段找不到的 token"执行 `break`（:194），游标不推进，留待下一文本块。若捕获 token 序列含"文本块外内容"（如图片 markdown 字符——模型生成 `![alt](url)` 作为 content 时会被捕获，但客户端 `toAssistantBlocks` 将其抽成 `kind:'image'` 块，chars 不在任何 text 块中），则**该 token 之后的全部文本块每次 match 都立即 break** → 图片之后的正文一律不上色（R2 实证：`b2=["后续文字"]` 无任何 token 段，remaining=13）。纯文本消息（主用例）不受影响（R1 实证全对），但含图片/附件/工具块的消息热力图静默失效。
- **严重度**：重要（功能级、数据相关；不崩、不丢字，只丢高亮）
- **位置**：`lib/client-utils.js:181-216`（createTokenMatcher.match，`idx === -1 → break`）
- **建议修法**：① 联调清单补"含图片/多文本块消息"用例确认触发条件；② 若确认，改 match 为"该 token 在当前段找不到时，检查其是否存在于**剩余全部文本**（调用方把各 text 块拼接传入）：也不存在 → 跳过该 token（cursor++）继续；存在 → 才 break 留待下一块"。或把匹配改为对"全部 text 块拼接文本 + 各块边界"一次性匹配后按边界切片。

### IMP-2. link href 无 scheme 白名单：`javascript:`/`data:` URL 渲染为可点击链接
- **问题描述**：`mdastToReact` 的 `link` 分支（src/client/markdown.js:88-93）直接 `href: node.url ?? "#"`，无 scheme 校验。实测 `[x](javascript:alert(document.cookie))` 与 `[x](data:text/html,hi)` 均被渲染为 `<a href>`。模型输出可被提示注入操纵，点击即执行页面上下文 JS。同一渲染器对 `image` 已做 http(s) 白名单（:96）、对 `html` 节点直接跳过（:124）——安全基线在，唯独 link 遗漏。
- **严重度**：重要（安全；低触发概率但真实可利用）
- **位置**：`src/client/markdown.js:88-93`
- **建议修法**：href 仅放行 `^https?:` / `^mailto:`，其余渲染为纯文本 `<span>`（或加 `rel` 之外再禁 target）；补一条 D2 断言（`javascript:` link 不产出 `a[href]`）。

### IMP-3. useTokens 无共享缓存：面板与 shadow 对同一消息重复请求（最多 2×4 次）
- **问题描述**：turnTail 面板（panel.js:184）与 shadow（highlighter.js:181）各自调用 `useTokens`，对同一 `(sessionId, turn, step)` 各发起一次 fetch；assoc-pending 退避重取（首次 + 3 次 = 4 次）时放大为 2×4 = 8 次请求。review 点 4"多组件共享会不会重复请求"——**会**。数据量小、不破坏正确性，但无谓浪费且在高频刷新场景叠加。
- **严重度**：重要（性能/协议礼貌；建议修复）
- **位置**：`src/client/tokens.js:20-67`（无模块级缓存）
- **建议修法**：模块级 `Map<"session|turn|step", {promise|result}>`：in-flight 去重（第二个请求复用同一个 promise）+ 结果短缓存（如 10s 或按 probeId）；注意与 assoc-pending 重试语义兼容（缓存仅在 captured:true/empty 终态写入）。

### IMP-4. D2 缺真实数据 matcher 回放与"卡死游标"用例
- **问题描述**：review 点 1 明确要求"可用 `docs/m0-sample-nothinking.json` 的真实 tokens 做回放"验证拼接一致性；现 D2 只测合成字符串（lib/client-utils.js 单测）。R1（真实 61 tokens 全消费）与 R2（卡死）均无对应断言——R2 的回归防护为空。另 D2 无 link scheme 断言（IMP-2 相关）。
- **严重度**：重要（测试覆盖缺口，直接导致 IMP-1 漏检）
- **位置**：`test/self-test.mjs` Part D2（:755-842）
- **建议修法**：① 加"真实样本 matcher 回放"：读 nothinking 样本重建正文与 token 列表 → 断言全消费 + `join === text`；② 加 R2 场景用例（图片占位 token 在中间 → 断言后续块仍能匹配，验证 IMP-1 修复后行为）；③ 加 `javascript:` link 不渲染断言（IMP-2）。

---

## 2. 建议级

| # | 问题描述 | 位置 | 建议修法 |
| :--- | :--- | :--- | :--- |
| SUG-1 | 每个 token 一个 HoverCard：2000 token 消息 → 2000 个 HoverCard 实例（事件监听/定位成本未知） | highlighter.js:95-104 | 联调用长文用例测量；若卡顿，只对"有 top 备选/可疑"token 包 HoverCard，其余纯 span + CSS title |
| SUG-2 | `parseMarkdown` 每次渲染重解析整段 markdown（SettledMessage 未 memo） | highlighter.js:134-173 | `useMemo(() => parseMarkdown(b.text), [b.text])` 按块缓存 |
| SUG-3 | `findClosingAssistantStep` 依赖 `turn.steps[].data.get("assistant-step").finalNode`——t14 未直接验证该读取路径（panel.js 自称"tailData 同款"） | lib/client-utils.js:131-151 | M3 联调清单加一条"打印一次 turn.steps 结构"确认；不符则改读 `node.data` 或事件驱动 |
| SUG-4 | `useTokens` 未用 AbortController：卸载只防 setState，fetch 仍跑完 | tokens.js:28-63 | 可接受；如需省流量可加 `AbortController` |
| SUG-5 | HMR 重载时同 key 同 priority 重复注册会 throw（t14 §5 已提示），try/catch 吞掉后 shadow 可能失效直到刷新 | index.js:36-46 | 模块级"已注册"标记（或注册前查询 registry）做幂等；至少日志区分"重复注册跳过"与"真失败" |
| SUG-6 | verify-m35 §2 联调步骤未覆盖含图片/多文本块消息（IMP-1 场景）与长文性能（SUG-1） | docs/verify-m35.md | 补第 9、10 步 |
| SUG-7 | 任务描述"Part D2 20 项新增"实际 16 项（总数 134 一致） | test/self-test.mjs D2 | 描述性小误差，无需改代码 |
| SUG-8 | IMAGE_LABELS 中文硬编码 | highlighter.js:53-60 | M3.5 可接受；后续接 locale 命名空间 |

---

## 3. 七个审查点结论

1. **mdast→React 渲染器正确性**：text 节点经 matcher 增量匹配——真实数据回放 61/61 全消费、拼接逐字符一致（R1）✓；heading/list/link/table(GFM)/code/image/blockquote/hr/break/footnoteReference 齐全；未知节点尽力渲染 children 否则原文（:129-135）✓；`html` 节点跳过安全（D2 断言 + 实测）✓；GFM 表格 th/td + align ✓。**缺口**：link scheme（IMP-2）、卡死游标（IMP-1）、`footnoteDefinition` 被丢（内容丢失，可接受）、KaTeX/shiki 未实现（文档已声明，按普通文本降级）。
2. **shadow 注册**：`keyed` 槽 `{name, key:'assistant-step', priority:-10}` **不带 select** ✓（t14 §5.4 确认 keyed 无 select，分发靠 entryKey）；默认注册 priority 0，-10 严格更低，无同 key 同 priority throw 冲突 ✓；turnTail chain 槽 `select: ({turn,seq}) => turn ? {turn,seq} : null` 符合 `ChainSelect = (owner) => M|null` 官方签名 ✓（t14 §5.1/§5.3，与 0ddee7e 修正一致）。HMR 重复注册风险见 SUG-5。
3. **流式与状态**：`settled` 才启用 useTokens（highlighter.js:181），running/interrupted 走 PlainMessage 原样渲染不请求（:188-189）✓；interrupted 尾部"（已停止）"✓；卸载 cleanup `cancelled` + `clearTimeout`（tokens.js:60-63）✓；assoc-pending 首次 + 3 次退避 500ms/1s/2s 后降级 empty（captured:false 按灰渲染）✓；hook 均在任何早退之前无条件调用（无 hook 顺序违规）✓。
4. **useTokens 共享**：两组件各自实例、**会重复请求**（IMP-3）；缓存与失效策略缺失，建议模块级 in-flight/结果缓存。
5. **构建**：`platform:"neutral"` 有明确依据（decode-named-character-reference 的 DOM/同构选择，build-client.mjs:49-52 注释）✓；bundle 306.2 KB 一次性加载可接受（原生 primitives bundle 远大于此；verify-m35 §4 已说明）；external 种子词清单与 t2 §3a 一致（react/react-dom/client/jsx-runtime/5 个 dsh-client-* 包）✓；**重新构建字节级可复现** ✓；包装 `__ModuleLoader__.load({id, factory})` 与 agent-teams 一致 ✓。
6. **安全与隐私**：客户端无 key 处理、hover 数据只来自 `/tokens` ✓；`html` 节点跳过 ✓；`image` 仅 http(s) ✓（实测 javascript: src 被拒）；**link 遗漏 scheme 白名单（IMP-2）**；注入的 CSS 为静态字符串 ✓。
7. **测试**：Part D2 覆盖 matcher 全消费/还原（"拼接还原正文"）、交错纯文本、跨文本段游标、停住不吞并、codeOnly 保守着色（const/x/1 三个 span）、图片分组、mdast 结构（heading/strong/inlineCode、pre>code、table th/td、html 跳过）✓；缺口：真实样本回放、卡死场景、link scheme（IMP-4）。

## 4. verify-m35.md 可测性核对

验收点 ①–⑥（正文热力图 / hover 备选 / 代码块保守着色 / reasoning 折叠灰 / 流式结算后上色 / 与 M3 面板一致）均为具体、可人工判定的浏览器联调项 ✓；构建与常见问题章节可操作。**补两条**：含图片/多文本块消息（IMP-1）、长文性能（SUG-1）；建议同时打印一次 `turn.steps` 结构验证 `findClosingAssistantStep`（SUG-3）。

## 5. 处置建议

1. 当前两个 commit **无阻塞级问题，可保留**；
2. 联调前优先修 IMP-2（link scheme，一行 + 一条断言）与 IMP-1（卡死游标，含联调确认）；
3. IMP-3（共享缓存）与 IMP-4（补真实回放/R2/link 测试）随 M3.5 收尾；
4. SUG-1…8 随联调与 M4 处理。
