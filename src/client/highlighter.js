/**
 * logprobs-highlighter — shadow assistant-step 正文逐 token 热力图（M3.5）
 *
 * 注册：keyed 槽 conversation.chat.node，key="assistant-step"，priority:-10
 * （默认注册 priority 0，低者胜出；keyed 槽无 select——t14 §5.4）。
 * 组件 props：node（routedOwner.node，data 来自 projectAssistant：
 *   {status: running|settled|interrupted, turn, step, blocks, usage?}）+
 *   session 标准 kit（sessionId）+ owner 共享（loadImage 等）。
 *
 * 渲染策略：
 * - status==='settled'：请求 /tokens（assoc-pending 退避重取，I4），
 *   用 mdast 自渲染 markdown，text 节点按捕获 token 序列逐 token 包
 *   <span style="background:hsl(hue,80%,85%)"> + HoverCard（备选词条形图）；
 *   代码块 <pre> 保守着色（只标数字/标识符，README §6.3）；reasoning 折叠灰
 *   （有概率数据但不标记，README §7.1）；连续 image 合并进 ImageGallery；
 *   captured:false 时降级为无 token 着色渲染（不破坏阅读）。
 * - running/interrupted：渲染原始文本（简单渲染，不请求、不上色）；interrupted
 *   尾部追加"（已停止）"。
 * - 流式结算：keyed 槽由快照驱动重渲染，status 翻转为 settled 时本组件以
 *   settled 节点重新挂载并触发 fetch（无需额外轮询）。
 *
 * @module logprobs-highlighter/client/highlighter
 */

import React, { useMemo } from "react";
import { HoverCard } from "@deepseek-ai/dsh-client-ui-primitives";
import { ImageGallery } from "@deepseek-ai/dsh-client-ui-attachment";
import {
  tokenHue,
  formatConfidence,
  formatLogprob,
  topBarData,
  createTokenMatcher,
} from "../../lib/client-utils.js";
import { parseMarkdown, mdastToReact } from "./markdown.js";
import { useTokens } from "./tokens.js";

const GRAY = "#9ca3af";
const h = React.createElement;

/** 注入一次 hover 加深样式（.lph-token:hover）。 */
if (typeof document !== "undefined" && !document.querySelector("style[data-lph-css]")) {
  const tag = document.createElement("style");
  tag.dataset.lphCss = "1";
  tag.textContent =
    ".lph-token:hover{filter:brightness(0.8)}" +
    ".lph-assistant{white-space:pre-wrap;word-break:break-word}" +
    ".lph-assistant p{margin:0.4em 0}.lph-assistant pre{background:rgba(127,127,127,0.08);padding:8px;border-radius:6px;overflow-x:auto}";
  document.head.appendChild(tag);
}

/** ImageGallery labels（自建中文；形状照抄 ui-conversation messageImageLabels）。 */
const IMAGE_LABELS = {
  image: "图片",
  open: "查看原图",
  openNamed: (label) => `查看原图：${label}`,
  loading: "加载中…",
  loadFailed: "加载失败",
  lightbox: { dialog: "图片预览", close: "关闭预览" },
};

/** token hover 卡片：原文 / logprob / 置信度 / Top-N 备选条形图。 */
function TokenHoverContent({ token }) {
  const bars = topBarData(token.top);
  return (
    <div style={{ minWidth: "160px", fontSize: "12px", lineHeight: 1.6 }}>
      <div style={{ fontWeight: 600, marginBottom: "4px" }}>{token.text || " "}</div>
      <div style={{ color: GRAY }}>
        logprob={formatLogprob(token.logprob)} · conf={formatConfidence(token.confidence)}
      </div>
      {bars.length > 0 && (
        <div style={{ marginTop: "6px" }}>
          {bars.map((alt, i) => (
            <div key={`${alt.token}-${i}`} style={{ display: "flex", alignItems: "center", gap: "6px", margin: "2px 0" }}>
              <span style={{ minWidth: "64px", overflow: "hidden", textOverflow: "ellipsis" }}>{alt.token}</span>
              <div style={{ flex: 1, height: "8px", background: "rgba(127,127,127,0.15)", borderRadius: "4px", overflow: "hidden" }}>
                <div
                  style={{
                    width: `${Math.max(2, alt.widthPct)}%`,
                    height: "100%",
                    background: alt.logprob !== null ? `hsl(${tokenHue({ logprob: alt.logprob })}, 75%, 55%)` : GRAY,
                  }}
                />
              </div>
              <span style={{ minWidth: "52px", textAlign: "right" }}>{formatConfidence(alt.confidence)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 单个 token span：浅色底 + HoverCard。 */
function TokenSpan({ seg }) {
  const hue = tokenHue(seg.token);
  const bg = hue === null ? GRAY : `hsl(${hue}, 80%, 85%)`;
  const anchor = (
    <span data-token style={{ background: bg, borderRadius: "3px", padding: "0 1px", cursor: "default" }} className="lph-token">
      {seg.value}
    </span>
  );
  return <HoverCard anchor={anchor} content={<TokenHoverContent token={seg.token} />} openDelayMs={250} />;
}

/** reasoning 块：折叠灰色（有概率数据但不标记，README §7.1；hover 注明）。 */
function ReasoningBlock({ block }) {
  return (
    <details style={{ color: GRAY, fontSize: "12px", margin: "4px 0" }} title="思考段：有概率数据但不标记">
      <summary>思考段（有概率数据，不标记）</summary>
      <pre style={{ whiteSpace: "pre-wrap", color: GRAY, margin: "4px 0" }}>{block.text}</pre>
    </details>
  );
}

/** 流式（running/interrupted）：原始文本简单渲染，不上色不请求。 */
function PlainMessage({ blocks, interrupted }) {
  const arr = Array.isArray(blocks) ? blocks : [];
  return (
    <div className="lph-assistant">
      {arr.map((b, i) => {
        if (b.kind === "text") return <div key={i} style={{ marginBottom: "6px" }}>{b.text}</div>;
        if (b.kind === "reasoning") return <ReasoningBlock key={i} block={b} />;
        if (b.kind === "image") return <div key={i} style={{ color: GRAY }}>[图片]</div>;
        if (b.kind === "tool-call") return <div key={i} style={{ color: GRAY, fontSize: "12px" }}>工具调用：{b.name ?? ""}</div>;
        return null;
      })}
      {interrupted && <span style={{ color: GRAY }}>（已停止）</span>}
    </div>
  );
}

/** settled：mdast 自渲染 + 逐 token 着色。 */
function SettledMessage({ blocks, textTokens, loadImage }) {
  const matcher = useMemo(() => createTokenMatcher(textTokens), [textTokens]);
  const renderToken = (seg, key) => <TokenSpan key={key} seg={seg} />;
  const ctx = { matcher, renderToken };
  const arr = Array.isArray(blocks) ? blocks : [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i];
    if (b.kind === "text") {
      const tree = parseMarkdown(b.text);
      out.push(
        <div key={`txt${i}`} style={{ marginBottom: "6px" }}>
          {mdastToReact(tree, h, ctx, `m${i}`)}
        </div>
      );
    } else if (b.kind === "reasoning") {
      out.push(<ReasoningBlock key={`rs${i}`} block={b} />);
    } else if (b.kind === "image") {
      const group = [b];
      while (i + 1 < arr.length && arr[i + 1] && arr[i + 1].kind === "image") {
        group.push(arr[i + 1]);
        i++;
      }
      out.push(
        <ImageGallery
          key={`img${i}`}
          images={group}
          load={loadImage ?? (() => Promise.reject(new Error("image service unavailable")))}
          align="start"
          labels={IMAGE_LABELS}
        />
      );
    } else if (b.kind === "tool-call") {
      out.push(<div key={`tc${i}`} style={{ color: GRAY, fontSize: "12px" }}>工具调用：{b.name ?? ""}</div>);
    } else {
      out.push(<div key={`ot${i}`} style={{ color: GRAY, fontSize: "12px" }}>（未知内容块）</div>);
    }
  }
  return <div className="lph-assistant">{out}</div>;
}

/** shadow assistant-step 视图。 */
export function AssistantStepView(props) {
  const { node, sessionId, loadImage } = props;
  const data = node && node.data;
  const settled = !!data && data.status === "settled";
  // 流式期间（running/interrupted）不请求：settled 后才启用 useTokens
  const tok = useTokens(sessionId, settled ? data.turn : null, settled ? data.step : null, settled);
  const textTokens = useMemo(() => {
    if (tok.phase !== "ok" || !tok.data) return [];
    return (tok.data.blocks || []).find((b) => b.role === "text")?.tokens ?? [];
  }, [tok]);

  if (!data) return null;
  if (data.status === "running") return <PlainMessage blocks={data.blocks} />;
  if (data.status === "interrupted") return <PlainMessage blocks={data.blocks} interrupted />;
  return <SettledMessage blocks={data.blocks} textTokens={textTokens} loadImage={loadImage} />;
}
