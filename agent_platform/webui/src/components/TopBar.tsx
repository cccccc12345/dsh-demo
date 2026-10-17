import type { ChatSummary } from "../types";

interface TopBarProps {
  chat: ChatSummary | null;
  status: string;
  running: boolean;
  streaming?: boolean;
  dockOpen: boolean;
  onToggleDock: () => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
}

export function TopBar(props: TopBarProps) {
  const { chat, status, running, streaming, dockOpen, onToggleDock, theme, onToggleTheme } = props;
  return (
    <header className="topbar">
      <div className="topbar-title">{chat ? chat.title : "选择一个会话"}</div>
      {running && (
        <div className="topbar-status">
          <span className="spin" /> {status || "正在思考…"}
        </div>
      )}
      {!running && streaming && (
        <div className="topbar-status" title="token 级流式输出已启用">
          ⚡ 流式
        </div>
      )}
      <div className="topbar-spacer" />
      <button
        className={`topbar-btn${dockOpen ? " on" : ""}`}
        onClick={onToggleDock}
        title="团队面板"
      >
        👥 团队
      </button>
      <button className="topbar-btn" onClick={onToggleTheme} title="切换主题">
        {theme === "dark" ? "🌙" : "☀️"}
      </button>
    </header>
  );
}
