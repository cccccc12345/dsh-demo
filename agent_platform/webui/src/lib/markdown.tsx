import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";

/*
 * 安全的 markdown 渲染:marked(GFM) → 代码高亮(hljs common) → DOMPurify。
 * 代码块在 sanitize 之后再包一层官方式卡片头(语言 + 换行/复制图标),
 * 点击行为统一由会话容器上的事件委托处理。
 */

let configured = false;

function ensureConfigured(): void {
  if (configured) return;
  configured = true;
  marked.use({
    gfm: true,
    renderer: {
      code(token) {
        const raw = String(token.text ?? "");
        const langName = (token.lang || "").trim().split(/\s+/)[0];
        const language = hljs.getLanguage(langName) ? langName : "plaintext";
        let body: string;
        try {
          body = hljs.highlight(raw, { language }).value;
        } catch {
          body = raw.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
        }
        return `<pre><code class="hljs language-${language}">${body}</code></pre>\n`;
      },
    },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

const COPY_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const WRAP_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h10a3 3 0 0 1 0 6H9"/><path d="m11 15-3 3 3 3"/><path d="M4 18h2"/></svg>`;

/** 给 pre>code 包上代码卡片头;仅在 sanitize 之后调用 */
function decorate(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("a").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noreferrer noopener");
    }
  });
  doc.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement;
    if (!pre || pre.parentElement?.classList.contains("code-card")) return;
    const m = /language-([\w-]+)/.exec(code.className);
    const lang = m ? m[1] : "";
    const card = doc.createElement("div");
    card.className = "code-card";
    const head = doc.createElement("div");
    head.className = "code-card-head";
    head.innerHTML = `<span class="code-lang">${escapeHtml(lang || "text")}</span>`
      + `<span class="code-actions">`
      + `<button class="code-action" type="button" data-wrap="1" title="切换自动换行" aria-label="切换自动换行">${WRAP_SVG}</button>`
      + `<button class="code-action" type="button" data-copy="1" title="复制代码" aria-label="复制代码">${COPY_SVG}</button>`
      + `</span>`;
    const parent = pre.parentElement;
    if (!parent) return;
    // 先记录 pre 后面的兄弟节点,再把 pre 移进 card,最后把 card 插回原位置。
    // 不能先 append 再 replaceChild:pre 已经被移走,不再是 parent 的子节点;
    // 也不能用 card 替换仍在 parent 里的 pre,否则 card 会成为 pre 的祖先。
    const nextSibling = pre.nextSibling;
    card.append(head, pre);
    parent.insertBefore(card, nextSibling);
  });
  return doc.body.innerHTML;
}

export function renderMarkdown(text: string): string {
  ensureConfigured();
  const dirty = marked.parse(String(text ?? "")) as string;
  const clean = DOMPurify.sanitize(dirty, {
    ADD_ATTR: ["data-copy", "data-wrap", "target", "rel"],
  });
  return decorate(clean);
}
