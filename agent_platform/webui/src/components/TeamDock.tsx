import type { AgentSpecInfo, TeamPanel } from "../types";

interface DockProps {
  open: boolean;
  data: TeamPanel | null;
  agents: AgentSpecInfo[];
}

function stageLabel(stage?: string, round?: number): string {
  if (!stage) return "待命";
  if (stage === "start") return "运行中";
  if (stage === "fix") return `第 ${round ?? 0} 轮修复中`;
  if (stage === "review") return "审查中";
  if (stage === "done") return "已完成";
  return stage;
}

export function TeamDock({ open, data, agents }: DockProps) {
  return (
    <aside className={`dock${open ? " open" : ""}`}>
      <div className="dock-title">👥 工作流面板</div>
      {!data && (
        <div className="dock-empty">
          勾选工作流模式后发送任务,这里会实时展示各阶段角色的进度与输出。
        </div>
      )}
      {data && (
        <>
          {agents.map((agent) => {
            const stage = data.stages[agent.id];
            return (
              <div className="dock-card" key={agent.id}>
                <div className="dock-card-head">
                  <span>{agent.emoji} {agent.name}</span>
                  <span className="dock-stage">
                    {stage?.stage && stage.stage !== "done" && <span className="live-dot" />}
                    {stageLabel(stage?.stage, stage?.round)}
                  </span>
                </div>
                <div className="dock-preview">{stage?.text || "— 尚无输出 —"}</div>
              </div>
            );
          })}
          {data.timeline.length > 0 && (
            <div className="dock-card">
              <div className="dock-card-head">审查时间线</div>
              <div className="dock-time">
                {data.timeline.map((t, i) => (
                  <div className="tl-item" key={i}>
                    {t.verdict === "APPROVE" ? (
                      <span style={{ color: "var(--dsw-static-green-500)" }}>✅</span>
                    ) : (
                      <span style={{ color: "var(--dsw-static-red-500)" }}>🔁</span>
                    )}
                    <span>第 {t.round} 轮 · {t.verdict === "APPROVE" ? "通过" : "打回"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
