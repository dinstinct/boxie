// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SafeMessageBody,
  linkifyPlainText,
  sanitizeEmailHtml,
  type SafeEmailNode
} from "./SafeMessageBody";

describe("SafeMessageBody", () => {
  it("preserves useful structure while removing executable and tracking content", () => {
    const nodes = sanitizeEmailHtml(`
      <style>body { display: none }</style>
      <script>window.pwned = true</script>
      <h2 onclick="window.pwned = true">Project update</h2>
      <p style="position:fixed" class="spoof">Open <strong>today</strong>.</p>
      <img src="https://tracker.example/pixel.gif" onerror="window.pwned = true">
      <iframe src="https://attacker.example"></iframe>
      <svg><a href="https://attacker.example">SVG link</a></svg>
      <form action="https://attacker.example"><button>Submit</button></form>
      <a href="javascript:alert(1)">unsafe</a>
      <a href="https://example.com/path" title="A safe destination">safe</a>
    `);
    const serialized = JSON.stringify(nodes);

    expect(serialized).toContain("Project update");
    expect(serialized).toContain("today");
    expect(serialized).not.toMatch(/script|style|iframe|svg|form|button|onclick|onerror|tracker\.example|javascript/i);
    expect(findLinks(nodes)).toEqual(["https://example.com/path"]);
  });

  it("renders only validated links with isolation attributes", () => {
    const markup = renderToStaticMarkup(
      <SafeMessageBody
        body={{ format: "html", content: '<p>Hello <a href="https://example.com">there</a></p><a href="data:text/html,bad">bad</a>' }}
        fallbackText=""
      />
    );

    expect(markup).toContain('href="https://example.com/"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).not.toContain("data:text/html");
  });

  it("linkifies http links in plain text without treating the message as markup", () => {
    const nodes = linkifyPlainText(
      "Sent from Outlook Android<https://aka.ms/AAb9ysg>. **Not Markdown** <img src=x>"
    );

    expect(findLinks(nodes)).toEqual(["https://aka.ms/AAb9ysg"]);
    expect(flattenText(nodes)).toBe(
      "Sent from Outlook Android https://aka.ms/AAb9ysg. **Not Markdown** <img src=x>"
    );
  });

  it("rejects link credentials and non-http protocols", () => {
    const nodes = sanitizeEmailHtml(`
      <a href="mailto:person@example.com">mail</a>
      <a href="https://user:secret@example.com">credential URL</a>
      <a href="https://example.com">web</a>
    `);
    expect(findLinks(nodes)).toEqual(["https://example.com/"]);
  });

  it("renders void elements and formatted tables without invalid React children", () => {
    expect(() => renderToStaticMarkup(
      <SafeMessageBody
        body={{
          format: "html",
          content: "<p>First<br>Second</p><hr><table>\n<tbody>\n<tr>\n<td>Cell</td>\n</tr>\n</tbody>\n</table>"
        }}
        fallbackText="First\nSecond\nCell"
      />
    )).not.toThrow();

    const nodes = sanitizeEmailHtml("<table>\n<tbody>\n<tr>\n<td>Cell</td>\n</tr>\n</tbody>\n</table>");
    expect(findStructuralWhitespace(nodes)).toEqual([]);
  });

  it("styles only semantic tables while leaving nested email layout tables invisible", () => {
    const markup = renderToStaticMarkup(
      <SafeMessageBody
        body={{
          format: "html",
          content: "<table><tbody><tr><td><h2>Notification</h2><table><thead><tr><th>Status</th><th>Job</th></tr></thead><tbody><tr><td>Failed</td><td>CI</td></tr></tbody></table></td></tr></tbody></table>"
        }}
        fallbackText="Notification Status Job Failed CI"
      />
    );

    expect(markup.match(/safe-email-layout-table/g)).toHaveLength(1);
    expect(markup.match(/safe-email-data-table/g)).toHaveLength(1);
  });
});

function findLinks(nodes: SafeEmailNode[]): string[] {
  return nodes.flatMap((node): string[] => node.kind === "text"
    ? []
    : [...(node.tag === "a" && node.href ? [node.href] : []), ...findLinks(node.children)]
  );
}

function flattenText(nodes: SafeEmailNode[]): string {
  return nodes.map((node) => node.kind === "text" ? node.text : flattenText(node.children)).join("");
}

function findStructuralWhitespace(
  nodes: SafeEmailNode[],
  parent?: string
): string[] {
  return nodes.flatMap((node): string[] => {
    if (node.kind === "text") {
      return parent && ["table", "thead", "tbody", "tfoot", "tr"].includes(parent) && !node.text.trim()
        ? [node.text]
        : [];
    }
    return findStructuralWhitespace(node.children, node.tag);
  });
}
