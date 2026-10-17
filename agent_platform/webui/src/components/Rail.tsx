import { useMemo, useState } from "react";
import type { ChatSummary, ConfigInfo } from "../types";

const BRAND_SUB = "DeepSeek Harness 平台";

function timeGroup(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return "今天";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "昨天";
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

interface RailProps {
  chats: ChatSummary[];
  runningChatId: string | null;
  activeId: string | null;
  config: ConfigInfo | null;
  disabled: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
}

export function Rail(props: RailProps) {
  const { chats, runningChatId, activeId, config, disabled, onSelect, onCreate, onDelete, theme, onToggleTheme } = props;
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const filtered = query.trim()
      ? chats.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase()))
      : chats;
    const map = new Map<string, ChatSummary[]>();
    for (const c of filtered) {
      const key = timeGroup(c.createdAt);
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [chats, query]);

  return (
    <aside className="rail">
      <div className="brand">
        <div className="brand-logo">A</div>
        <div>
          <div className="brand-name">AgentBox</div>
          <div className="brand-sub">{BRAND_SUB}</div>
        </div>
      </div>

      <button className="new-chat" onClick={onCreate} disabled={disabled}>
        <span>＋</span> 新会话
      </button>

      <div className="rail-search">
        <input
          placeholder="搜索会话…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索会话"
        />
      </div>

      <nav className="chat-list" aria-label="会话列表">
        {groups.length === 0 && <div className="chat-empty">{query ? "没有匹配的会话" : "还没有会话"}</div>}
        {groups.map(([label, list]) => (
          <div key={label}>
            <div className="chat-empty" style={{ textAlign: "left", padding: "6px 10px 2px" }}>{label}</div>
            {list.map((chat) => (
              <div
                key={chat.id}
                className={`chat-item${chat.id === activeId ? " active" : ""}`}
                onClick={() => onSelect(chat.id)}
              >
                {runningChatId === chat.id && <span className="chat-item-dot" />}
                <div className="chat-item-title" title={chat.title}>{chat.title}</div>
                <button
                  className="chat-item-del"
                  title="删除会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(chat.id);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ))}
      </nav>

      <div className="rail-foot">
        {config && (
          <>
            <div className="chip-row">
              {config.mock ? (
                <span className="chip chip-mock"><span className="dot" />mock</span>
              ) : (
                <span className="chip"><span className="dot" style={{ background: "var(--dsw-static-green-500)" }} />real</span>
              )}
              <span className="chip">{config.model}</span>
              <span className="chip">{config.provider}</span>
            </div>
            <div className="workspace-line" title={config.workspace}>{config.workspace}</div>
          </>
        )}
        <button className="theme-toggle" onClick={onToggleTheme} title="切换亮暗主题">
          {theme === "dark" ? "🌙 暗色" : "☀️ 亮色"}
        </button>
      </div>
    </aside>
  );
}
