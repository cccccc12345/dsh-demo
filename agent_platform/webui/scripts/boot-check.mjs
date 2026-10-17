/*
 * 无浏览器启动探针:在 jsdom 里以 Node ESM 加载构建产物,
 * 泄露首次渲染的运行时异常与最终 DOM 内容,用以诊断“空白页”。
 */
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import path from "node:path";

const STATIC = path.resolve(import.meta.dirname, "../../static");

const dom = new JSDOM('<!doctype html><html><body data-ds-dark-theme><div id="root"></div></body></html>', {
  url: "http://127.0.0.1:8765/",
  pretendToBeVisual: true,
});

const errs = [];
dom.window.addEventListener("error", (e) => errs.push(String(e.error?.stack || e.message)));

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.localStorage = dom.window.localStorage;
globalThis.customElements = dom.window.customElements;
try { Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true }); } catch { /* Node 只读,跳过 */ }
globalThis.matchMedia =
  typeof dom.window.matchMedia === "function"
    ? dom.window.matchMedia.bind(dom.window)
    : () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.CSSStyleDeclaration = dom.window.CSSStyleDeclaration;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.MessageChannel = dom.window.MessageChannel;

// 相对 URL 重写到后端,网络层与真实浏览器一致
window.fetch = async (u, o) => {
  const res = await fetch(new URL(u, "http://127.0.0.1:8765").href, o);
  return new dom.window.Response(await res.clone().arrayBuffer(), {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
  });
};

// 主 chunk 文件名从 index.html 里解析,避免每次构建变 hash 后再手改这里
const indexHtml = await readFile(path.join(STATIC, "index.html"), "utf8");
const entry = indexHtml.match(/assets\/(index-[\w.-]+\.js)/)?.[0];
if (!entry) {
  console.error("index.html 里没有主 chunk 引用:先在 webui/ 跑一次 pnpm build");
  process.exit(1);
}
try {
  await import(path.join(STATIC, entry));
} catch (e) {
  console.error(`加载主 chunk ${entry} 失败:`, e);
  process.exit(1);
}

// 放 React 完成 effect 与首次渲染
await new Promise((r) => setTimeout(r, 600));
dom.window.dispatchEvent(new dom.window.Event("load"));
await new Promise((r) => setTimeout(r, 800));

const html = document.getElementById("root")?.innerHTML ?? "";
console.log("#root 内 HTML 长度:", html.length);
console.log("包含 AgentBox:", html.includes("AgentBox"));
console.log("运行时 error listener 捕获:", errs.length ? errs : "无");
console.log(console.log, document.title);
