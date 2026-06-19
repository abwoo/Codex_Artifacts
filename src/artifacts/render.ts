import fs from "node:fs";
import path from "node:path";
import { ArtifactType, TEMPLATE_DIR } from "../core/shared";

export const MAX_RENDERED_BYTES = 16 * 1024 * 1024;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function defaultContent(type: ArtifactType): string {
  return fs.readFileSync(path.join(TEMPLATE_DIR, `${type}.md`), "utf8");
}

export function sourceContent(from: string | undefined, type: ArtifactType, stdin?: string): { content: string; sourceType: string; sourcePath: string } {
  if (!from) return { content: defaultContent(type), sourceType: "template", sourcePath: `templates/${type}.md` };
  if (from === "-") return { content: stdin ?? "", sourceType: "stdin", sourcePath: "stdin" };
  const ext = path.extname(from).toLowerCase();
  if (![".html", ".htm", ".md"].includes(ext)) {
    throw new Error("Artifact source must be .html, .htm, .md, or stdin with an explicit --type.");
  }
  return { content: fs.readFileSync(from, "utf8"), sourceType: "file", sourcePath: path.resolve(from) };
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const html: string[] = [];
  let paragraph: string[] = [];
  let code: string[] = [];
  let table: string[] = [];
  let inCode = false;
  let list: "" | "ul" | "ol" = "";
  let sectionOpen = false;

  const ensureSection = () => {
    if (!sectionOpen) {
      html.push("<section>");
      sectionOpen = true;
    }
  };
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = "";
  };
  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) {
      ensureSection();
      html.push(`<p>${inlineMarkdown(text)}</p>`);
    }
    paragraph = [];
  };
  const flushTable = () => {
    if (table.length < 2) {
      table = [];
      return;
    }
    ensureSection();
    html.push("<table>");
    table.forEach((row, index) => {
      if (index === 1 && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(row)) return;
      const tag = index === 0 ? "th" : "td";
      html.push("<tr>");
      row.trim().replace(/^\||\|$/g, "").split("|").forEach((cell) => html.push(`<${tag}>${inlineMarkdown(cell.trim())}</${tag}>`));
      html.push("</tr>");
    });
    html.push("</table>");
    table = [];
  };
  const startSection = (title: string) => {
    flushParagraph();
    closeList();
    flushTable();
    if (sectionOpen) html.push("</section>");
    html.push(`<section><h2>${inlineMarkdown(title)}</h2>`);
    sectionOpen = true;
  };

  for (const line of lines) {
    if (/^\s*```\s*/.test(line)) {
      flushParagraph();
      closeList();
      flushTable();
      if (inCode) {
        ensureSection();
        html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushParagraph();
      closeList();
      flushTable();
      continue;
    }
    if (/^\s*<.+>\s*$/.test(line)) {
      flushParagraph();
      closeList();
      flushTable();
      ensureSection();
      html.push(line);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph();
      closeList();
      table.push(line);
      continue;
    }
    flushTable();
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (level === 1) continue;
      if (level === 2) startSection(heading[2].trim());
      else {
        ensureSection();
        html.push(`<h3>${inlineMarkdown(heading[2].trim())}</h3>`);
      }
      continue;
    }
    const ul = /^\s*[-*]\s+(.+)$/.exec(line);
    if (ul) {
      flushParagraph();
      ensureSection();
      if (list !== "ul") {
        closeList();
        html.push("<ul>");
        list = "ul";
      }
      html.push(`<li>${inlineMarkdown(ul[1].trim())}</li>`);
      continue;
    }
    const ol = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (ol) {
      flushParagraph();
      ensureSection();
      if (list !== "ol") {
        closeList();
        html.push("<ol>");
        list = "ol";
      }
      html.push(`<li>${inlineMarkdown(ol[1].trim())}</li>`);
      continue;
    }
    const quote = /^\s*>\s+(.+)$/.exec(line);
    if (quote) {
      flushParagraph();
      closeList();
      ensureSection();
      html.push(`<blockquote>${inlineMarkdown(quote[1].trim())}</blockquote>`);
      continue;
    }
    paragraph.push(line.trim());
  }
  if (inCode) {
    ensureSection();
    html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  }
  flushParagraph();
  closeList();
  flushTable();
  if (sectionOpen) html.push("</section>");
  return html.join("\n");
}

function htmlText(value: string): string {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*`|{}()[\];:=.,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTag(content: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(content);
  return match?.[1]?.trim();
}

function artifactBody(content: string): string {
  const trimmed = content.trimStart().replace(/^\uFEFF/, "");
  if (/^(<!doctype\s+html|<html[\s>])/i.test(trimmed)) {
    return extractTag(trimmed, "body") || trimmed.replace(/<!doctype[^>]*>/i, "").replace(/<\/?html[^>]*>/gi, "");
  }
  if (/^<section[\s>]/i.test(trimmed)) return trimmed;
  return markdownToHtml(content);
}

function summary(content: string, type: string): string {
  const title = htmlText(extractTag(content, "title") || "");
  const heading = htmlText(extractTag(content, "h1") || extractTag(content, "h2") || "");
  const paragraph = htmlText(extractTag(content, "p") || "");
  const plain = title || heading || paragraph || htmlText(content).replace(/[-]+/g, " ").replace(/\s+/g, " ").trim();
  return plain ? `${plain.slice(0, 150)}${plain.length > 150 ? "..." : ""}` : `A local Codex ${type} artifact.`;
}

export function renderArtifactDocument(input: {
  title: string;
  type: string;
  version: number;
  updatedAt: string;
  source: string;
  content: string;
}): string {
  const template = fs.readFileSync(path.join(TEMPLATE_DIR, "shell.html"), "utf8");
  const body = artifactBody(input.content);
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">`;
  const html = template
    .replace("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">", `<meta name="viewport" content="width=device-width, initial-scale=1">\n  ${csp}`)
    .replaceAll("{{TITLE}}", escapeHtml(input.title))
    .replaceAll("{{TYPE}}", escapeHtml(input.type))
    .replaceAll("{{VERSION}}", String(input.version))
    .replaceAll("{{UPDATED_AT}}", escapeHtml(input.updatedAt))
    .replaceAll("{{SOURCE}}", escapeHtml(input.source))
    .replaceAll("{{SUMMARY}}", escapeHtml(summary(input.content, input.type)))
    .replace("{{CONTENT}}", body);
  validateRenderedArtifact(html);
  return html;
}

export function validateRenderedArtifact(html: string): void {
  const size = Buffer.byteLength(html, "utf8");
  if (size > MAX_RENDERED_BYTES) throw new Error(`Rendered artifact is ${size} bytes, over the 16 MiB limit.`);
  const htmlWithoutCode = html.replace(/<pre\b[\s\S]*?<\/pre>/gi, "").replace(/<code\b[\s\S]*?<\/code>/gi, "");
  const forbidden: Array<[RegExp, string]> = [
    [/\bsrc\s*=\s*["'](?!data:|blob:|#)/i, "external src attribute"],
    [/\bhref\s*=\s*["'](?!#|mailto:|tel:|data:|blob:|\/artifacts\/|\/share\/)/i, "external or multipage href"],
    [/\bfetch\s*\(/i, "fetch()"],
    [/\bXMLHttpRequest\b/i, "XMLHttpRequest"],
    [/\bWebSocket\b/i, "WebSocket"],
    [/\bEventSource\b/i, "EventSource"],
    [/@import\s+url/i, "CSS @import"],
    [/\burl\(\s*["']?https?:/i, "external CSS URL"]
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(htmlWithoutCode)) throw new Error(`Artifact contains forbidden ${label}.`);
  }
}

export function htmlAttr(value: string): string {
  return escapeHtml(value);
}

export function escapeText(value: string): string {
  return escapeHtml(value);
}
