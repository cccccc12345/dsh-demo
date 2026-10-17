import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";

/*
 * 安全的 markdown 渲染:marked(GFM) → 代码高亮(hljs common) → DOMPurify。
 * 代码块再包一层“卡片头(语言 + 复制)”,复制按钮在 sanitize 之后由
 * decorate() 注入,点击行为用容器上的事件委托处理,避免内联脚本。
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

/** 给 pre>code 包上代码卡片头;仅在 sanitize 之后调用 */
function decorate(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement;
    if (!pre || pre.parentElement?.classList.contains("code-card")) return;
    const m = /language-([\w-]+)/.exec(code.className);
    const lang = m ? m[1] : "";
    const card = doc.createElement("div");
    card.className = "code-card";
    const head = doc.createElement("div");
    head.className = "code-card-head";
    head.innerHTML = `<span class="code-lang">${escapeHtml(lang || "code")}</span>`
      + `<button class="code-copy" type="button" data-copy="1">复制</button>`;
    card.append(head, pre);
    pre.parentElement?.replaceChild(card, pre);
  });
  return doc.body.innerHTML;
}

export function renderMarkdown(text: string): string {
  ensureConfigured();
  const dirty = marked.parse(String(text ?? "")) as string;
  const clean = DOMPurify.sanitize(dirty, {
    ADD_ATTR: ["data-copy"],
  });
  return decorate(clean);
}
