/**
 * logprobs-highlighter — 自写 mdast→React 渲染器（M3.5 正文热力图）
 *
 * 背景（t14 §1）：MarkdownText 是封闭 mdast 管线（text 节点渲染为纯字符串，
 * primitives index.js:5168），无 token span 注入入口 → 必须自渲染。
 * 方案：micromark/mdast 系列依赖（非种子词）打包进 client bundle（esbuild），
 * 本模块用 mdast-util-from-markdown + GFM 扩展解析出 mdast 树，再自写
 * 渲染器按 markdown 语义输出 React 元素；text 节点经 token 匹配器逐 token
 * 包 span（由调用方 renderToken 注入，见 highlighter.js）。
 *
 * 本模块【不 import react】：通过注入的 `h`（createElement 工厂）构建元素，
 * 因此可在 Node 中纯函数单测（Part D 用测试桩 h）。
 *
 * 语义覆盖：heading/paragraph/text/emphasis/strong/delete/inlineCode/link/
 * image/break/list/listItem/blockquote/thematicBreak/code/table(GFM)/
 * footnoteReference；html 节点直接跳过（不渲染未信任的原始 HTML）；
 * 未知节点尽力渲染 children，否则原文。
 *
 * @module logprobs-highlighter/client/markdown
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";

/** 解析 markdown 为 mdast 树（GFM：表格/删除线/自动链接）；失败降级为纯文本段落。 */
export function parseMarkdown(text) {
  const source = typeof text === "string" ? text : "";
  try {
    return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  } catch {
    return { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: source }] }] };
  }
}

/** 把 segments（token 匹配器输出）渲染为元素/字符串列表。 */
function renderSegments(segments, renderToken, keyPrefix) {
  const out = [];
  (segments || []).forEach((seg, i) => {
    if (seg.type === "token") out.push(renderToken(seg, `${keyPrefix}t${i}`));
    else if (seg.value !== "") out.push(seg.value);
  });
  return out;
}

/** 渲染内联子节点（text/emphasis/strong/link 等的 children）。 */
function inlineChildren(node, h, ctx, keyPrefix) {
  return (node.children || []).map((child, i) => mdastToReact(child, h, ctx, `${keyPrefix}c${i}`));
}

/**
 * mdast 节点 → React 元素（经 h 工厂）。
 * @param {object} node mdast 节点
 * @param {Function} h (tag, props, ...children) => element
 * @param {{matcher?: object, renderToken?: Function}} ctx matcher = createTokenMatcher 实例；
 *   renderToken(seg, key) => element（无 matcher 时 text 渲染为纯字符串）
 * @param {string} keyPrefix 递归 key 前缀（避免元素缺 key 告警）
 */
export function mdastToReact(node, h, ctx, keyPrefix = "") {
  if (!node || typeof node !== "object") return null;
  const matcher = ctx && ctx.matcher;
  const renderToken = ctx && ctx.renderToken;

  const renderTextNode = (value, codeOnly) => {
    if (!matcher) return value;
    const segments = matcher.match(value, codeOnly ? { codeOnly: true } : {});
    return renderSegments(segments, renderToken, keyPrefix);
  };

  switch (node.type) {
    case "root":
      return node.children.map((c, i) => mdastToReact(c, h, ctx, `${keyPrefix}r${i}`));
    case "paragraph":
      return h("p", { key: keyPrefix }, ...inlineChildren(node, h, ctx, keyPrefix));
    case "heading":
      return h(`h${node.depth >= 1 && node.depth <= 6 ? node.depth : 2}`, { key: keyPrefix }, ...inlineChildren(node, h, ctx, keyPrefix));
    case "text":
      return renderTextNode(node.value, false);
    case "emphasis":
      return h("em", { key: keyPrefix }, ...inlineChildren(node, h, ctx, keyPrefix));
    case "strong":
      return h("strong", { key: keyPrefix }, ...inlineChildren(node, h, ctx, keyPrefix));
    case "delete":
      return h("del", { key: keyPrefix }, ...inlineChildren(node, h, ctx, keyPrefix));
    case "inlineCode":
      // 行内码：正常上色（API 名/标识符常出现在此处，属高价值）
      return h("code", { key: keyPrefix }, renderTextNode(node.value, false));
    case "link":
      return h(
        "a",
        { key: keyPrefix, href: node.url ?? "#", title: node.title ?? undefined, target: "_blank", rel: "noreferrer" },
        ...inlineChildren(node, h, ctx, keyPrefix)
      );
    case "image":
      // mdast 内联图片：仅 http(s) 渲染 <img>，否则占位文本（不引入未信任协议）
      if (/^https?:\/\//i.test(node.url || "")) {
        return h("img", { key: keyPrefix, src: node.url, alt: node.alt ?? "", title: node.title ?? undefined, style: { maxWidth: "100%" } });
      }
      return h("span", { key: keyPrefix }, `[图片${node.alt ? `: ${node.alt}` : ""}]`);
    case "break":
      return h("br", { key: keyPrefix });
    case "list":
      return h(
        node.ordered ? "ol" : "ul",
        { key: keyPrefix, start: node.ordered && node.start ? node.start : undefined },
        ...node.children.map((c, i) => mdastToReact(c, h, ctx, `${keyPrefix}l${i}`))
      );
    case "listItem":
      return h("li", { key: keyPrefix }, ...(node.children || []).map((c, i) => mdastToReact(c, h, ctx, `${keyPrefix}i${i}`)));
    case "blockquote":
      return h("blockquote", { key: keyPrefix }, ...(node.children || []).map((c, i) => mdastToReact(c, h, ctx, `${keyPrefix}q${i}`)));
    case "thematicBreak":
      return h("hr", { key: keyPrefix });
    case "code":
      // 代码块：<pre><code>，codeOnly 保守着色（只标数字/标识符，README §6.3）
      return h(
        "pre",
        { key: keyPrefix },
        h("code", { className: node.lang ? `language-${node.lang}` : undefined }, renderTextNode(node.value, true))
      );
    case "table":
      return renderTable(node, h, ctx, keyPrefix);
    case "html":
      return null; // 未信任原始 HTML：跳过
    case "footnoteDefinition":
      return null;
    case "footnoteReference":
      return h("sup", { key: keyPrefix }, `[${node.identifier ?? "?"}]`);
    default: {
      if (node.children && node.children.length > 0) {
        return node.children.map((c, i) => mdastToReact(c, h, ctx, `${keyPrefix}u${i}`));
      }
      if (typeof node.value === "string") return renderTextNode(node.value, false);
      return null;
    }
  }
}

/** GFM 表格：首行表头 th，其余 td；align 生效。 */
function renderTable(node, h, ctx, keyPrefix) {
  const align = Array.isArray(node.align) ? node.align : [];
  const rows = node.children || [];
  return h(
    "table",
    { key: keyPrefix, style: { borderCollapse: "collapse" } },
    ...rows.map((row, ri) =>
      h(
        "tr",
        { key: `${keyPrefix}tr${ri}` },
        ...(row.children || []).map((cell, ci) => {
          const tag = ri === 0 ? "th" : "td";
          const style = { border: "1px solid rgba(127,127,127,0.35)", padding: "2px 8px" };
          if (align[ci]) style.textAlign = align[ci];
          return h(tag, { key: `${keyPrefix}${tag}${ci}`, style }, ...inlineChildren(cell, h, ctx, `${keyPrefix}${tag}${ci}`));
        })
      )
    )
  );
}
