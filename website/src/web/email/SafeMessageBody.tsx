import DOMPurify from "dompurify";
import { Component, createElement, useMemo, type ReactNode } from "react";
import type { ProjectedMessageBody } from "../../contracts/conversations";

const allowedTags = [
  "p", "br", "div", "span", "strong", "b", "em", "i", "u", "s", "del",
  "blockquote", "pre", "code", "ul", "ol", "li", "table", "thead", "tbody",
  "tfoot", "tr", "th", "td", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "a"
] as const;

type AllowedTag = typeof allowedTags[number];

export type SafeEmailNode =
  | { kind: "text"; text: string }
  | {
      kind: "element";
      tag: AllowedTag;
      href?: string | undefined;
      title?: string | undefined;
      colSpan?: number | undefined;
      rowSpan?: number | undefined;
      children: SafeEmailNode[];
    };

const allowedTagSet = new Set<string>(allowedTags);
const plainUrlPattern = /<?https?:\/\/[^\s<>"']+>?/giu;

export function SafeMessageBody({
  body,
  fallbackText
}: {
  body?: ProjectedMessageBody | undefined;
  fallbackText: string;
}) {
  const resetKey = `${body?.format ?? "text"}\0${body?.content ?? fallbackText}`;
  return (
    <EmailRenderBoundary fallbackText={fallbackText} resetKey={resetKey}>
      <SafeMessageBodyContent body={body} fallbackText={fallbackText} />
    </EmailRenderBoundary>
  );
}

function SafeMessageBodyContent({
  body,
  fallbackText
}: {
  body?: ProjectedMessageBody | undefined;
  fallbackText: string;
}) {
  const nodes = useMemo(
    () => body?.format === "html"
      ? sanitizeEmailHtml(body.content)
      : linkifyPlainText(body?.content || fallbackText),
    [body, fallbackText]
  );

  return (
    <div className={`safe-message-body safe-message-body-${body?.format ?? "text"}`}>
      {renderNodes(nodes)}
    </div>
  );
}

class EmailRenderBoundary extends Component<{
  children: ReactNode;
  fallbackText: string;
  resetKey: string;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      return <div className="safe-message-body safe-message-body-text">{this.props.fallbackText}</div>;
    }
    return this.props.children;
  }
}

export function sanitizeEmailHtml(html: string): SafeEmailNode[] {
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...allowedTags],
    ALLOWED_ATTR: ["href", "title", "colspan", "rowspan"],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true
  }) as unknown as DocumentFragment;

  return [...fragment.childNodes].flatMap(toSafeNode);
}

export function linkifyPlainText(text: string): SafeEmailNode[] {
  const nodes: SafeEmailNode[] = [];
  let cursor = 0;
  plainUrlPattern.lastIndex = 0;
  for (const match of text.matchAll(plainUrlPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push({ kind: "text", text: text.slice(cursor, index) });

    const matched = match[0];
    const wrapped = matched.startsWith("<") && matched.endsWith(">");
    const candidate = wrapped ? matched.slice(1, -1) : matched;
    const { urlText, suffix } = splitTrailingPunctuation(candidate);
    const href = safeHttpUrl(urlText);
    if (href) {
      if (wrapped && index > 0 && !/\s/u.test(text[index - 1]!)) {
        nodes.push({ kind: "text", text: " " });
      }
      nodes.push({ kind: "element", tag: "a", href, children: [{ kind: "text", text: urlText }] });
      if (suffix) nodes.push({ kind: "text", text: suffix });
    } else {
      nodes.push({ kind: "text", text: matched });
    }
    cursor = index + matched.length;
  }
  if (cursor < text.length) nodes.push({ kind: "text", text: text.slice(cursor) });
  return nodes;
}

function toSafeNode(node: Node): SafeEmailNode[] {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ? [{ kind: "text", text: node.textContent }] : [];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  let children = [...element.childNodes].flatMap(toSafeNode);
  if (!allowedTagSet.has(tag)) return children;

  const safeTag = tag as AllowedTag;
  if (["table", "thead", "tbody", "tfoot", "tr"].includes(safeTag)) {
    children = children.filter((child) => child.kind !== "text" || child.text.trim() !== "");
  }
  if (safeTag === "a") {
    const href = safeHttpUrl(element.getAttribute("href") ?? "");
    return href
      ? [{ kind: "element", tag: safeTag, href, title: cleanTitle(element.title), children }]
      : children;
  }

  return [{
    kind: "element",
    tag: safeTag,
    title: cleanTitle(element.title),
    colSpan: safeSpan(element.getAttribute("colspan")),
    rowSpan: safeSpan(element.getAttribute("rowspan")),
    children
  }];
}

function renderNodes(nodes: SafeEmailNode[], path = "body"): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${path}-${index}`;
    if (node.kind === "text") return node.text;
    const children = renderNodes(node.children, key);
    if (node.tag === "a" && node.href) {
      return <a key={key} href={node.href} title={node.title} target="_blank" rel="noopener noreferrer">{children}</a>;
    }
    if (node.tag === "table") {
      return createElement("table", {
        key,
        title: node.title,
        className: isDataTable(node) ? "safe-email-data-table" : "safe-email-layout-table"
      }, children);
    }
    if (node.tag === "br" || node.tag === "hr") {
      return createElement(node.tag, { key, title: node.title });
    }
    return createElement(node.tag, {
      key,
      title: node.title,
      colSpan: node.colSpan,
      rowSpan: node.rowSpan
    }, children);
  });
}

function isDataTable(table: Extract<SafeEmailNode, { kind: "element" }>): boolean {
  return hasHeaderOutsideNestedTable(table.children);
}

function hasHeaderOutsideNestedTable(nodes: SafeEmailNode[]): boolean {
  return nodes.some((node) => {
    if (node.kind === "text") return false;
    if (node.tag === "th") return true;
    if (node.tag === "table") return false;
    return hasHeaderOutsideNestedTable(node.children);
  });
}

function safeHttpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function cleanTitle(value: string): string | undefined {
  const title = value.trim();
  return title ? title.slice(0, 500) : undefined;
}

function safeSpan(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 20 ? parsed : undefined;
}

function splitTrailingPunctuation(value: string): { urlText: string; suffix: string } {
  let end = value.length;
  while (end > 0 && /[.,;:!?]/u.test(value[end - 1]!)) end -= 1;
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
    while (end > 0 && value[end - 1] === close
      && count(value.slice(0, end), close) > count(value.slice(0, end), open)) end -= 1;
  }
  return { urlText: value.slice(0, end), suffix: value.slice(end) };
}

function count(value: string, token: string): number {
  return [...value].filter((character) => character === token).length;
}
