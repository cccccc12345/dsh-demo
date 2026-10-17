"use strict";

/* -------------------------------------------------------------------------
 * 状态
 * ---------------------------------------------------------------------- */

const state = {
  currentChatId: null,
  chats: [],
  streaming: false,
  streamingChatId: null,
  mock: false,
};

const $messages = document.getElementById("messages");
const $input = document.getElementById("input");
const $send = document.getElementById("send");
const $chatList = document.getElementById("chat-list");
const $chatTitle = document.getElementById("chat-title");
const $banner = document.getElementById("banner");
const $newChat = document.getElementById("new-chat");
const $teamMode = document.getElementById("team-mode");

const AGENT_LABEL = { coder: "👨‍💻 Coder", reviewer: "🔍 Reviewer" };

/* -------------------------------------------------------------------------
 * 工具
 * ---------------------------------------------------------------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function timeLabel(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* 轻量 markdown:围栏代码块 / 行内代码 / 粗体 / 链接 */
function renderMarkdown(text) {
  const parts = String(text).split(/```/);
  let html = "";
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf("\n");
      const firstLineOk = nl >= 0 && /^[a-zA-Z0-9_-]{0,12}\s*$/.test(part.slice(0, nl));
      const code = firstLineOk ? part.slice(nl + 1) : part;
      html += `<pre class="code"><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`;
      return;
    }
    let seg = escapeHtml(part);
    seg = seg.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
    seg = seg.replace(/\*\*([^*\n]+\S)\*\*/g, "<strong>$1</strong>");
    seg = seg.replace(
      /\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>'
    );
    seg = seg
      .split(/\n{2,}/)
      .map(
        (p) =>
          `<p>${p
            .split("\n")
            .map((line) => (line.trim() ? escapeHtml(line) : ""))
            .reduce((acc, line, idx) => {
              if (idx === 0) return line;
              return acc.endsWith("<br>") || line === "" ? acc + line : acc + "<br>" + line;
            }, "")}</p>`
      )
      .join("");
    html += seg;
  });
  return html;
}

/* -------------------------------------------------------------------------
 * 渲染
 * ---------------------------------------------------------------------- */

function renderBanner(config) {
  if (config.mock) {
    $banner.className = "banner warn";
    $banner.innerHTML =
      "🧪 <b>Mock 模式</b> — test-harness/.env 里的 DEEPSEEK_API_KEY 还是占位符,消息由本地剧本回放。<br>填入真实 key 后重启服务即为真实 agent。" +
      (config.startupError ? `<br><span class="err">${escapeHtml(config.startupError)}</span>` : "");
  } else {
    $banner.className = "banner ok";
    $banner.innerHTML = `✅ 真实模式 — provider <b>${escapeHtml(config.provider)}</b> · model <b>${escapeHtml(config.model)}</b>,agent 的工具都在 <code class="inline">${escapeHtml(config.workspace)}</code> 目录下执行`;
  }
  document.getElementById("config-meta").textContent = `model: ${config.model} · provider: ${config.provider}`;
  document.getElementById(
    "config-chips"
  ).innerHTML = `<span class="chip">${config.mock ? "🧪 mock" : "🟢 real"}</span><span class="chip">${escapeHtml(config.model)}</span>`;
}

function renderChatList() {
  $chatList.innerHTML = "";
  for (const chat of state.chats) {
    const item = el("div", "chat-item" + (chat.id === state.currentChatId ? " active" : ""));
    const label = el("div", "chat-item-title", chat.title || "新会话");
    if (chat.streaming) label.classList.add("streaming");
    item.appendChild(label);
    const del = el("button", "chat-item-del", "✕");
    del.title = "删除会话";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      void deleteChat(chat.id);
    });
    item.appendChild(del);
    item.addEventListener("click", () => selectChat(chat.id));
    $chatList.appendChild(item);
  }
}

function bubble(role, markdown, agentLabel) {
  const wrap = el("div", "bubble-row " + role);
  const bubbleEl = el("div", "bubble");
  if (role === "user") {
    bubbleEl.textContent = markdown;
  } else {
    bubbleEl.innerHTML = renderMarkdown(markdown);
  }
  if (agentLabel) wrap.classList.add("agent-" + agentLabel);
  wrap.appendChild(
    el(
      "div",
      "bubble-meta",
      (role === "user" ? "你" : agentLabel || "Agent") + " · " + timeLabel(Date.now())
    )
  );
  wrap.appendChild(bubbleEl);
  $messages.appendChild(wrap);
  $messages.scrollTop = $messages.scrollHeight;
  return wrap;
}

/* transcript 里的 system 备注(tt 错误/重建提示),按错误样式渲染 */
function bubbleSystem(text) {
  const wrap = el("div", "bubble-row assistant");
  const content = el("div", "err-box");
  content.innerHTML = renderMarkdown(text);
  wrap.appendChild(content);
  $messages.appendChild(wrap);
  $messages.scrollTop = $messages.scrollHeight;
}

function progressNode() {
  const wrap = el("div", "progress");
  const spinner = el("span", "spinner");
  const label = el("span", "progress-label", "Agent 启动中…");
  const steps = el("span", "steps");
  wrap.append(spinner, label, steps);
  $messages.appendChild(wrap);
  $messages.scrollTop = $messages.scrollHeight;
  return {
    node: wrap,
    update(label) {
      if (label) wrap.querySelector(".progress-label").textContent = label;
    },
    addStep(text) {
      const chip = el("span", "step-chip", text);
      wrap.querySelector(".steps").appendChild(chip);
      $messages.scrollTop = $messages.scrollHeight;
      return chip;
    },
    addTool(text) {
      return this.addStep(text); // 同芯片样式;tool/result 结果附加到该芯片内
    },
    remove() {
      wrap.remove();
    },
  };
}

/* 工具结果折叠块 */
function toolResultNode(isError, text) {
  const details = document.createElement("details");
  details.className = "tool-result" + (isError ? " error" : "");
  const summary = el("summary", null, isError ? "⚠️ 失败" : "输出");
  const pre = el("pre", null, text || "(无输出)");
  details.append(summary, pre);
  return details;
}

/* -------------------------------------------------------------------------
 * 数据交互
 * ---------------------------------------------------------------------- */

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail || detail;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json();
}

async function refreshChats() {
  state.chats = await fetchJson("/api/chats");
  renderChatList();
}

async function selectChat(chatId) {
  if (state.streaming) return; // 流式进行中禁止切换,避免 UI 混乱
  state.currentChatId = chatId;
  $chatTitle.textContent = "…";
  $messages.innerHTML = "";
  state.chats.forEach((c) => (c.streaming = c.id === state.streamingChatId));
  renderChatList();
  try {
    const data = await fetchJson(`/api/chats/${chatId}`);
    $chatTitle.textContent = data.title || "新会话";
    document.title = `${data.title || "新会话"} · Agent 平台`;
    (data.transcript || []).forEach((entry) => {
      if (entry.role === "system") bubbleSystem(entry.text);
      else bubble(entry.role, entry.text, entry.agent);
    });
  } catch (e) {
    $chatTitle.textContent = "加载失败";
    console.error(e);
  }
  if (!state.streaming) {
    $input.disabled = false;
    $send.disabled = false;
    $input.focus();
  }
}

async function deleteChat(chatId) {
  try {
    await fetchJson(`/api/chats/${chatId}`, { method: "DELETE" });
    if (state.currentChatId === chatId) {
      state.currentChatId = null;
      $messages.innerHTML = "";
      $chatTitle.textContent = "选择或创建一个会话";
      $input.disabled = true;
      $send.disabled = true;
    }
    await refreshChats();
  } catch (e) {
    alert(e.message);
  }
}

async function createChat() {
  if (state.streaming) return;
  const chat = await fetchJson("/api/chats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  state.chats.unshift(chat);
  renderChatList();
  await selectChat(chat.id);
}

/* 发送消息:POST + fetch 流式读取 SSE */
async function sendMessage() {
  const text = $input.value.trim();
  if (!text || state.streaming) return;
  if (!state.currentChatId) {
    await createChat();
    if (!state.currentChatId) return;
  }
  $input.value = "";
  autosize();
  state.streaming = true;
  state.streamingChatId = state.currentChatId;
  setStreamingUi(true);
  const chatId = state.currentChatId;
  const chatMeta = state.chats.find((c) => c.id === chatId);
  if (chatMeta) {
    chatMeta.streaming = true;
    if (chatMeta.title === "新会话") chatMeta.title = text.slice(0, 18);
    renderChatList();
  }

  bubble("user", text);
  const progress = progressNode();
  const toolChips = {}; // callId -> chip element
  const agentBubbles = {}; // agent(coder/reviewer) -> {contentEl}
  const ensureAgent = (agent) => {
    if (!agentBubbles[agent]) {
      const wrap = bubble("assistant", "", agent);
      agentBubbles[agent] = { wrap, contentEl: wrap.querySelector(".bubble") };
    }
    return agentBubbles[agent];
  };
  let assistantBubble = null; // {node, contentEl}

  const ensureAssistant = () => {
    if (!assistantBubble) {
      const wrap = bubble("assistant", "");
      const contentEl = wrap.querySelector(".bubble");
      assistantBubble = { wrap, contentEl };
    }
    return assistantBubble;
  };

  function handle(ev) {
    const isChild = ev.scope === "child";
    const agentTag = ev.agent ? AGENT_LABEL[ev.agent] + " " : "";
    switch (ev.type) {
      case "user_echo":
        break;
      case "phase": {
        const label = AGENT_LABEL[ev.agent] || ev.agent;
        const stage =
          ev.stage === "start" ? "开始编码" : ev.stage === "fix" ? `第 ${ev.round} 轮修复` : "审查中";
        progress.update(`${label} ${stage}…`);
        progress.addStep(`${label} ${stage}`);
        break;
      }
      case "verdict":
        progress.addStep(
          ev.verdict === "APPROVE"
            ? "✅ Reviewer 通过"
            : `🔁 Reviewer 打回(第 ${ev.round} 轮)`
        );
        break;
      case "agent_spawn":
        progress.addStep("🤖 子代理已启动");
        break;
      case "agent_done":
        progress.addStep(
          `🏁 子代理结束(${ev.status || ev.stop})` +
            (ev.summary ? ": " + ev.summary.slice(0, 80) : "")
        );
        break;
      case "turn_start":
        if (isChild) {
          progress.addStep(`🤖 子代理 turn ${ev.turn} 开始`);
          break;
        }
        progress.update(`Turn ${ev.turn} 进行中…`);
        break;
      case "step_start":
        if (isChild) break;
        progress.update(`Turn ${ev.turn} · Step ${ev.step} …`);
        break;
      case "step_end":
        break;
      case "reasoning": {
        const text = String(ev.text || "").replace(/\s+/g, " ").trim();
        if (text)
          progress.addStep(
            (isChild ? "🤖 💭 " : "💭 ") + text.slice(0, 90) + (text.length > 90 ? "…" : "")
          );
        break;
      }
      case "tool_call": {
        const chip = progress.addTool(
          agentTag +
            (isChild ? "🤖 " : "") +
            `${ev.name} ` +
            (ev.detail ? ev.detail.slice(0, 90) : "")
        );
        if (ev.callId) toolChips[ev.callId] = chip;
        break;
      }
      case "tool_result": {
        const chip = toolChips[ev.callId] || progress.addTool("tool");
        chip.appendChild(toolResultNode(ev.isError, ev.text));
        if (ev.callId) delete toolChips[ev.callId];
        break;
      }
      case "message": {
        if (isChild) {
          if (ev.text)
            progress.addStep("🤖 子代理回复: " + ev.text.slice(0, 100) + (ev.text.length > 100 ? "…" : ""));
          break;
        }
        if (ev.reasoning) {
          const text = String(ev.reasoning).replace(/\s+/g, " ").trim();
          progress.addStep(
            agentTag + "💭 " + text.slice(0, 90) + (text.length > 90 ? "…" : "")
          );
        }
        if (ev.text) {
          const cur = ev.agent ? ensureAgent(ev.agent) : ensureAssistant();
          cur.contentEl.innerHTML = renderMarkdown(ev.text);
          cur.contentEl.dataset.set = "1";
          $messages.scrollTop = $messages.scrollHeight;
        }
        break;
      }
      case "chat_title": {
        $chatTitle.textContent = ev.title;
        const meta = state.chats.find((c) => c.id === chatId);
        if (meta && ev.title) meta.title = ev.title;
        renderChatList();
        break;
      }
      case "error": {
        const cur = ensureAssistant();
        cur.contentEl.innerHTML = `<div class="err-box">⚠️ ${escapeHtml(ev.message)}</div>`;
        $messages.scrollTop = $messages.scrollHeight;
        break;
      }
      case "turn_end":
        break;
      case "end": {
        // 服务端已写入 transcript;空回复时给出可见提示
        if (ev.response) {
          const cur = ensureAssistant();
          if (!cur.contentEl.dataset.set) {
            cur.contentEl.innerHTML = renderMarkdown(ev.response);
            cur.contentEl.dataset.set = "1";
          }
        } else if (assistantBubble) {
          const cur = assistantBubble;
          if (!cur.contentEl.dataset.set) {
            cur.contentEl.innerHTML = '<span class="dim">(本轮没有文本回复,详见下方会话记录)</span>';
            cur.contentEl.dataset.set = "1";
          }
        }
        break;
      }
      default:
        break;
    }
    $messages.scrollTop = $messages.scrollHeight;
  }

  try {
    const endpoint = $teamMode.checked ? "team" : "messages";
    const res = await fetch(`/api/chats/${chatId}/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok || !res.body) {
      let detail = res.statusText;
      try {
        detail = (await res.json()).detail || detail;
      } catch {
        /* ignore */
      }
      throw new Error(detail);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          handle(JSON.parse(dataLine.slice(6)));
        } catch (err) {
          console.warn("bad SSE frame", frame, err);
        }
      }
    }
  } catch (e) {
    const cur = ensureAssistant();
    cur.contentEl.innerHTML = `<div class="err-box">⚠️ ${escapeHtml(e.message || String(e))}</div>`;
  } finally {
    progress.remove();
    state.streaming = false;
    state.streamingChatId = null;
    setStreamingUi(false);
    const active = state.currentChatId === chatId;
    await refreshChats();
    if (active) await selectChat(chatId);
  }
}

function setStreamingUi(on) {
  $input.disabled = on;
  $send.disabled = on;
  $send.textContent = on ? "运行中…" : "发送";
  document.getElementById("new-chat").disabled = on;
  $teamMode.disabled = on;
  $chatList.classList.toggle("locked", on);
  $input.placeholder = on
    ? "Agent 正在处理,请稍候…"
    : "给 agent 一个任务…(Enter 发送,Shift+Enter 换行)";
}

function autosize() {
  $input.style.height = "auto";
  $input.style.height = Math.min($input.scrollHeight, 160) + "px";
}

/* -------------------------------------------------------------------------
 * 事件绑定与启动
 * ---------------------------------------------------------------------- */

$send.addEventListener("click", () => void sendMessage());
$input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});
$input.addEventListener("input", autosize);
$newChat.addEventListener("click", () => void createChat());

(async function init() {
  try {
    const config = await fetchJson("/api/config");
    state.mock = config.mock;
    renderBanner(config);
    await refreshChats();
    if (state.chats.length > 0) await selectChat(state.chats[0].id);
    else $input.disabled = true;
  } catch (e) {
    $banner.className = "banner warn";
    $banner.textContent = "无法连接后端: " + e.message;
    $banner.classList.remove("hidden");
  }
})();
