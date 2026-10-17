import type { ComposerProps } from "./Composer";

interface DockProps {
  open: boolean;
  data: ComposerProps["team"];
}

const AGENT_META = {
  coder: { name: "👨‍💻 Coder", desc: "实现工程师" },
  reviewer: { name: "🔍 Reviewer", desc: "代码审查" },
} as const;

export function TeamDock({ open, data }: DockProps) {
  return (
    <aside className={`dock${open ? " open" : ""}`}>
      <div className="dock-title">👥 团队面板</div>
      {!data && <div className="dock-empty">勾选团队模式后发送任务,这里会实时展示 Coder / Reviewer 的分工与审查状态。</div>}
      {data && (
        <>
          {(["coder", "reviewer"] as const).map((agent) => {
            const stage = agent === "coder" ? data.coderStage : data.reviewerStage;
            const round = agent === "coder" ? data.coderRound : data.reviewerRound;
            const text = agent === "coder" ? data.coderText : data.reviewerText;
            return (
              <div className="dock-card" key={agent}>
                <div className="dock-card-head">
                  <span>{AGENT_META[agent].name}</span>
                  <span className="dock-stage">
                    {stage ? (
                      <>
                        {stage !== "done" && <span className="live-dot" />}
                        {stage === "start" && "编码中"}
                        {stage === "fix" && `第 ${round ?? 0} 轮修复中`}
                        {stage === "review" && "审查中"}
                        {stage === "done" && "本轮结束"}
                      </>
                    ) : (
                      "待命"
                    )}
                  </span>
                </div>
                <div className="dock-preview">{text || "— 尚无输出 —"}</div>
              </div>
            );
          })}
          <div className="dock-card">
            <div className="dock-card-head">审查时间线</div>
            {data.timeline.length === 0 && <div className="dock-empty">还没有 verdict。</div>}
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
        </>
      )}
    </aside>
  );
}
