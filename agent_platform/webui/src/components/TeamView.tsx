import type { AgentSpecInfo, TeamPanel, WorkflowInfo } from "../types";
import { cx } from "../lib/ui";
import { Markdown } from "./Markdown";
import {
  IconAlert,
  IconCheck,
  IconChevronRight,
  IconLoader,
  IconSparkles,
  IconUsers,
  IconWorkflow,
} from "./Icons";

interface TeamViewProps {
  data: TeamPanel | null;
  workflow: WorkflowInfo | null;
  running: boolean;
  answer?: string;
  onStartTeam: () => void;
}

function stageLabel(stage?: string, round?: number): string {
  if (!stage) return "待命";
  if (stage === "start") return "运行中";
  if (stage === "fix") return `第 ${round ?? 0} 轮修复`;
  if (stage === "review") return "审查中";
  if (stage === "done") return "已完成";
  return stage;
}

function stageTone(stage?: string): string {
  if (!stage) return "is-idle";
  if (stage === "done") return "is-done";
  return "is-running";
}

function StageCard({ agent, data }: { agent: AgentSpecInfo; data: TeamPanel }) {
  const stage = data.stages[agent.id];
  const tone = stageTone(stage?.stage);
  return (
    <div className={cx("team-stage", tone)}>
      <div className="team-stage-head">
        <span className="team-avatar">{agent.emoji}</span>
        <div className="team-stage-title">
          <span className="team-name">{agent.name}</span>
          <span className="team-role">{agent.role}</span>
        </div>
        <span className={cx("team-stage-pill", tone)}>
          {tone === "is-running" && <IconLoader size={12} className="spin" />}
          {tone === "is-done" && <IconCheck size={12} />}
          {stageLabel(stage?.stage, stage?.round)}
        </span>
      </div>
      <div className="team-stage-body">
        {stage?.text ? (
          <Markdown text={stage.text} className="team-output" />
        ) : (
          <span className="team-placeholder">— 尚无输出 —</span>
        )}
      </div>
    </div>
  );
}

export function TeamView({ data, workflow, running, answer = "", onStartTeam }: TeamViewProps) {
  const roster = workflow?.agents ?? [];
  const completed = data
    ? roster.filter((agent) => data.stages[agent.id]?.stage === "done").length
    : 0;
  const touched = data
    ? roster.filter((agent) => Boolean(data.stages[agent.id]?.stage)).length
    : 0;
  const directAnswer = Boolean(data) && touched === 0 && Boolean(answer) && !running;
  if (!workflow) {
    return (
      <div className="panel-view">
        <div className="panel-empty">
          <span className="panel-empty-icon"><IconWorkflow size={28} /></span>
          <h2>未配置团队工作流</h2>
          <p>在 workflows.json 中定义角色和流程后,这里会展示各阶段的实时进展。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel-view team-view">
      <div className="panel-head">
        <div className="panel-head-copy">
          <div className="panel-eyebrow">
            <IconWorkflow size={15} />
            <span>团队工作流</span>
          </div>
          <h2>{workflow.name}</h2>
          <p>{workflow.description}</p>
        </div>
        <div className="panel-stats">
          <span><IconUsers size={14} /> {workflow.agents.length} 个角色</span>
          <span>{workflow.type === "pipeline" ? "流水线" : "评审门禁"}</span>
          {workflow.type !== "pipeline" && <span>最多 {workflow.maxRounds} 轮</span>}
        </div>
      </div>

      {!data ? (
        <div className="panel-empty-card">
          <div className="panel-empty-copy">
            <span className="panel-empty-icon"><IconSparkles size={24} /></span>
            <div>
              <h3>让多个角色协同完成一个任务</h3>
              <p>开启团队模式后,平台会按顺序把任务交给每个角色,并把上一阶段的结论和产物传给下一阶段。</p>
            </div>
          </div>
          <div className="workflow-roles">
            {workflow.agents.map((agent, index) => (
              <div className="workflow-role" key={agent.id}>
                <span className="role-emoji">{agent.emoji}</span>
                <span className="role-name">{agent.name}</span>
                {index < workflow.agents.length - 1 && <IconChevronRight size={14} className="role-arrow" />}
              </div>
            ))}
          </div>
          <button type="button" className="primary-btn" onClick={onStartTeam}>
            <IconWorkflow size={15} />
            用团队模式开始
          </button>
        </div>
      ) : (
        <>
          <div className="team-banner">
            <span className={cx("team-banner-icon", running && "is-running")}>
              {running ? <IconLoader size={16} className="spin" /> : <IconCheck size={16} />}
            </span>
            <div>
              <div className="team-banner-title">
                {running
                  ? "工作流运行中"
                  : directAnswer
                    ? "本轮由 Lead 直接回答"
                    : "工作流已完成"}
              </div>
              <div className="team-banner-sub">
                {directAnswer
                  ? "问题被路由为普通问答,未进入角色流水线"
                  : workflow.type === "pipeline"
                    ? "按角色顺序执行,阶段输出会传递给下一阶段"
                    : "coder 与 reviewer 的质量门禁,打回后自动修复"}
              </div>
            </div>
            <span className="team-banner-count">{directAnswer ? "Lead" : touched === 0 ? "—" : `${completed}/${workflow.agents.length}`}</span>
          </div>

          {directAnswer && (
            <div className="panel-card team-answer">
              <div className="panel-card-title">
                <IconSparkles size={15} />
                本轮输出
              </div>
              <Markdown text={answer} className="team-output" />
            </div>
          )}

          <div className="team-stages">
            {workflow.agents.map((agent, index) => (
              <div className="team-stage-wrap" key={agent.id}>
                <StageCard agent={agent} data={data} />
                {index < workflow.agents.length - 1 && <span className="team-connector" />}
              </div>
            ))}
          </div>

          {!directAnswer && answer && !running && (
            <div className="panel-card team-answer">
              <div className="panel-card-title">
                <IconSparkles size={15} />
                本轮输出
              </div>
              <Markdown text={answer} className="team-output" />
            </div>
          )}

          {data.timeline.length > 0 && (
            <div className="panel-card">
              <div className="panel-card-title">
                <IconAlert size={15} />
                审查时间线
              </div>
              <div className="timeline-list">
                {data.timeline.map((item, index) => (
                  <div className={cx("timeline-item", item.verdict === "APPROVE" ? "is-ok" : "is-bad")} key={index}>
                    <span className="timeline-dot" />
                    <span className="timeline-round">第 {item.round} 轮</span>
                    <span>{item.verdict === "APPROVE" ? "Reviewer 通过" : "Reviewer 打回"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
