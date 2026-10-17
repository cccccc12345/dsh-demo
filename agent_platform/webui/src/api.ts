import type { AgentRoster, ChatDetail, ChatSummary, ConfigInfo, TurnEvent } from "./types";

/** 统一带 detail 提示的 fetch;409 之类让调用方按状态码区分 */
export async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail || detail;
    } catch {
      /* 非 JSON 响应体,保留默认文案 */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const api = {
  config: () => fetchJson<ConfigInfo>("/api/config"),

  agents: () => fetchJson<AgentRoster>("/api/agents"),

  stopAll: () =>
    fetchJson<{ ok: boolean; stopped: boolean; message: string }>("/api/stop", {
      method: "POST",
    }),

  chats: () => fetchJson<ChatSummary[]>("/api/chats"),

  createChat: () =>
    fetchJson<ChatSummary>("/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),

  chat: (id: string) => fetchJson<ChatDetail>(`/api/chats/${id}`),

  removeChat: (id: string) =>
    fetchJson<{ ok: boolean }>(`/api/chats/${id}`, { method: "DELETE" }),
};

/**
 * 发送一轮 turn 并消费 SSE 流。
 * 每收到一个 data: 帧调用一次 onEvent;409 表示上一条还没跑完,由调用方提示。
 */
export async function streamTurn(
  chatId: string,
  text: string,
  team: boolean,
  onEvent: (ev: TurnEvent) => void
): Promise<void> {
  const endpoint = team ? "team" : "messages";
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
    throw new ApiError(res.status, detail);
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
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        const ev = JSON.parse(line.slice(6)) as TurnEvent;
        onEvent(ev);
        // React 18 batches updates inside one task. Yield after each token so
        // the browser paints the growing text instead of only the final string.
        if (ev.type === "assistant_delta") {
          // 8ms per delta: keeps fast models (DeepSeek Flash) visibly typing
          // instead of dumping a whole paragraph in one paint.
          await new Promise<void>((resolve) => setTimeout(resolve, 8));
        }
      } catch (err) {
        console.warn("bad SSE frame", frame, err);
      }
    }
  }
}
