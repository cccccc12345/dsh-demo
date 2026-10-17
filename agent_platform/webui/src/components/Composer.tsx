import { useEffect, useRef, useState } from "react";

interface ComposerProps {
  disabled: boolean;
  running: boolean;
  onSubmit: (text: string, team: boolean) => void;
  team: import("../types").TeamPanel | null;
  workflow: import("../types").WorkflowInfo | null;
}

export type { ComposerProps };

export function Composer({ disabled, running, onSubmit, workflow }: ComposerProps) {
  const [text, setText] = useState("");
  const [team, setTeam] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || disabled || running) return;
    setText("");
    setTeam(false);
    onSubmit(t, team);
  };

  return (
    <footer className="composer">
      <div className="composer-inner">
        <div className="composer-panel">
          <textarea
            ref={ref}
            rows={1}
            value={text}
            disabled={disabled || running}
            placeholder={
              running
                ? "Agent 正在处理,请稍候…"
                : "给 agent 一个任务…(Enter 发送,Shift+Enter 换行)"
            }
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-row2">
            <label
              className="team-toggle"
              title={workflow?.description || "由平台按顺序编排多个角色 agent"}
            >
              <input
                type="checkbox"
                checked={team}
                disabled={disabled || running}
                onChange={(e) => setTeam(e.target.checked)}
              />
              <span>
                👥 工作流模式
                {workflow ? `(${workflow.agents.length} 个角色)` : ""}
              </span>
            </label>
            <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
            <button className="send-btn" onClick={submit} disabled={disabled || running}>
              {running ? "运行中…" : "发送"}
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}
