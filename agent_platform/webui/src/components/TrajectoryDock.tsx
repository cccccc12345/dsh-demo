import { useEffect, useRef } from "react";
import type { AgentSpecInfo, TrajectoryEvent } from "../types";

interface TrajectoryDockProps {
  open: boolean;
  events: TrajectoryEvent[];
  agents: AgentSpecInfo[];
}

function agentName(agents: AgentSpecInfo[], id?: string): string {
  return id ? agents.find((agent) => agent.id === id)?.name ?? id : "Assistant";
}

interface Row {
  key: string;
  ts: number;
  icon: string;
  label: string;
  text?: string;
  detail?: string;
  tone?: string;
  indent?: number;
  durationMs?: number;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function phaseText(stage: string | undefined, round: number | undefined): string {
  if (stage === "start") return "开始";
  if (stage === "fix") return `第 ${round ?? 0} 轮修复`;
  if (stage === "review") return "审查中";
  if (stage === "done") return "已完成";
  return stage || "";
}

function buildRows(events: TrajectoryEvent[], agents: AgentSpecInfo[]): Row[] {
  const rows: Row[] = [];
  const calls = new Map<string, { ts: number; name: string }>();
  let turnStart = 0;
  let stepStart = 0;

  events.forEach((event, index) => {
    const key = `${event.type}-${event.ts}-${index}`;
    switch (event.type) {
      case "user_echo":
        rows.push({ key, ts: event.ts, icon: "👤", label: "USER", text: event.text, tone: "user" });
        break;
      case "turn_start":
        turnStart = event.ts;
        rows.push({ key, ts: event.ts, icon: "🔄", label: `Turn ${event.turn ?? ""}`, tone: "turn" });
        break;
      case "step_start":
        stepStart = event.ts;
        rows.push({
          key,
          ts: event.ts,
          icon: "▸",
          label: `Step ${event.step ?? ""}`,
          tone: "step",
          indent: 1,
        });
        break;
      case "step_end":
        rows.push({
          key,
          ts: event.ts,
          icon: "✓",
          label: `Step ${event.step ?? ""} 完成`,
          tone: "step",
          indent: 1,
          durationMs: stepStart > 0 ? event.ts - stepStart : undefined,
        });
        break;
      case "tool_call":
        calls.set(event.callId || key, { ts: event.ts, name: event.name || "tool" });
        rows.push({
          key,
          ts: event.ts,
          icon: "🛠",
          label: event.name || "tool",
          detail: event.detail,
          tone: "tool",
          indent: 2,
        });
        break;
      case "tool_result": {
        const call = calls.get(event.callId || "");
        rows.push({
          key,
          ts: event.ts,
          icon: event.isError ? "⚠️" : "✓",
          label: `${call?.name || "tool"} 结果`,
          text: event.text,
          tone: event.isError ? "error" : "result",
          indent: 2,
          durationMs: call ? event.ts - call.ts : undefined,
        });
        break;
      }
      case "message":
        rows.push({
          key,
          ts: event.ts,
          icon: "💬",
          label: agentName(agents, event.agent),
          text: event.text,
          tone: "assistant",
          indent: event.scope === "child" ? 2 : 1,
        });
        if (event.reasoning) {
          rows.push({
            key: `${key}-reasoning`,
            ts: event.ts,
            icon: "💭",
            label: "Reasoning",
            text: event.reasoning,
            tone: "reasoning",
            indent: event.scope === "child" ? 2 : 1,
          });
        }
        break;
      case "reasoning":
        rows.push({
          key,
          ts: event.ts,
          icon: "💭",
          label: "Reasoning",
          text: event.text,
          tone: "reasoning",
          indent: event.scope === "child" ? 2 : 1,
        });
        break;
      case "phase":
        rows.push({
          key,
          ts: event.ts,
          icon: "🧩",
          label: `${agentName(agents, event.agent)} · ${phaseText(event.stage, event.round)}`,
          tone: "phase",
        });
        break;
      case "verdict":
        rows.push({
          key,
          ts: event.ts,
          icon: event.verdict === "APPROVE" ? "✅" : "🔁",
          label: `Reviewer ${event.verdict === "APPROVE" ? "通过" : "打回"} · 第 ${event.round ?? 0} 轮`,
          tone: event.verdict === "APPROVE" ? "approve" : "reject",
        });
        break;
      case "agent_spawn":
        rows.push({
          key,
          ts: event.ts,
          icon: "🤖",
          label: "Subagent 启动",
          detail: event.child,
          tone: "child",
        });
        break;
      case "agent_done":
        rows.push({
          key,
          ts: event.ts,
          icon: "🏁",
          label: "Subagent 结束",
          detail: [event.status, event.stop, event.summary].filter(Boolean).join(" · "),
          tone: "child",
        });
        break;
      case "approval_request":
        rows.push({
          key,
          ts: event.ts,
          icon: "🛡️",
          label: `审批请求 · ${event.toolName || "tool"}`,
          text: event.reason,
          tone: "approval",
          indent: 2,
        });
        break;
      case "approval_resolved":
        rows.push({
          key,
          ts: event.ts,
          icon: event.outcome === "allowed-once" ? "✅" : "⛔",
          label: `审批结果 · ${event.outcome || "unknown"}`,
          tone: event.outcome === "allowed-once" ? "approve" : "reject",
          indent: 2,
        });
        break;
      case "error":
        rows.push({
          key,
          ts: event.ts,
          icon: "⚠️",
          label: "Error",
          text: event.message,
          tone: "error",
        });
        break;
      case "usage": {
        const usage = event.usage;
        rows.push({
          key,
          ts: event.ts,
          icon: "🔢",
          label: "Usage",
          text: usage
            ? `input ${usage.inputTokens ?? 0} · output ${usage.outputTokens ?? 0} · cached ${usage.cacheReadTokens ?? 0}`
            : undefined,
          tone: "usage",
        });
        break;
      }
      case "end":
        rows.push({
          key,
          ts: event.ts,
          icon: event.finish_reason === "stopped" ? "⏹" : "🏁",
          label: `结束 · ${event.finish_reason || "completed"}`,
          tone: event.finish_reason === "stopped" ? "stop" : "end",
          durationMs: turnStart > 0 ? event.ts - turnStart : undefined,
        });
        break;
    }
  });
  return rows;
}

export function TrajectoryDock({ open, events, agents }: TrajectoryDockProps) {
  const ref = useRef<HTMLElement>(null);
  const rows = buildRows(events, agents);
  const turns = events.filter((e) => e.type === "turn_start").length;
  const steps = events.filter((e) => e.type === "step_start").length;
  const tools = events.filter((e) => e.type === "tool_call").length;
  const outputTokens = events.reduce((sum, e) => sum + (e.usage?.outputTokens ?? 0), 0);
  const totalMs = events.length > 1 ? events[events.length - 1].ts - events[0].ts : 0;

  useEffect(() => {
    const el = ref.current;
    if (open && el) el.scrollTop = el.scrollHeight;
  }, [open, events.length]);

  return (
    <aside className={`dock${open ? " open" : ""}`} ref={ref}>
      <div className="dock-title">🧭 轨迹</div>
      <div className="traj-summary">
        <span>{turns} turns</span>
        <span>{steps} steps</span>
        <span>{tools} tools</span>
        {outputTokens > 0 && <span>{outputTokens} tok</span>}
        {totalMs > 0 && <span>{fmtDuration(totalMs)}</span>}
      </div>
      {rows.length === 0 && (
        <div className="dock-empty">
          发送一条消息后,这里会按 turn / step / tool / assistant 记录轨迹。
        </div>
      )}
      <div className="traj-list">
        {rows.map((row) => (
          <div
            className={`traj-row${row.tone ? ` ${row.tone}` : ""}`}
            key={row.key}
            style={{ paddingLeft: 4 + (row.indent ?? 0) * 10 }}
          >
            <span className="traj-icon">{row.icon}</span>
            <div className="traj-main">
              <div className="traj-head">
                <span className="traj-label">{row.label}</span>
                <span className="traj-time">
                  {fmtTime(row.ts)}
                  {row.durationMs !== undefined ? ` · ${fmtDuration(row.durationMs)}` : ""}
                </span>
              </div>
              {row.detail && <div className="traj-detail">{row.detail}</div>}
              {row.text && <div className="traj-text">{row.text}</div>}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
