import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSpecInfo, TrajectoryEvent } from "../types";
import { cx, formatClock, formatDurationShort, formatTokens } from "../lib/ui";
import { IconFilter, IconRoute } from "./Icons";

type Filter = "all" | "tools" | "messages" | "approvals";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "messages", label: "消息" },
  { id: "tools", label: "工具" },
  { id: "approvals", label: "审批" },
];

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

function agentName(agents: AgentSpecInfo[], id?: string): string {
  return id ? agents.find((agent) => agent.id === id)?.name ?? id : "Assistant";
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
        rows.push({ key, ts: event.ts, icon: "👤", label: "用户消息", text: event.text, tone: "user" });
        break;
      case "turn_start":
        turnStart = event.ts;
        rows.push({ key, ts: event.ts, icon: "↻", label: `Turn ${event.turn ?? ""}`, tone: "turn" });
        break;
      case "step_start":
        stepStart = event.ts;
        rows.push({ key, ts: event.ts, icon: "▸", label: `Step ${event.step ?? ""}`, tone: "step", indent: 1 });
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
          icon: "⌘",
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
          icon: event.isError ? "!" : "✓",
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
          icon: "✎",
          label: agentName(agents, event.agent),
          text: event.text,
          tone: "assistant",
          indent: event.scope === "child" ? 2 : 1,
        });
        if (event.reasoning) {
          rows.push({
            key: `${key}-reasoning`,
            ts: event.ts,
            icon: "✦",
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
          icon: "✦",
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
          icon: "◆",
          label: `${agentName(agents, event.agent)} · ${phaseText(event.stage, event.round)}`,
          tone: "phase",
        });
        break;
      case "verdict":
        rows.push({
          key,
          ts: event.ts,
          icon: event.verdict === "APPROVE" ? "✓" : "↺",
          label: `Reviewer ${event.verdict === "APPROVE" ? "通过" : "打回"} · 第 ${event.round ?? 0} 轮`,
          tone: event.verdict === "APPROVE" ? "approve" : "reject",
        });
        break;
      case "agent_spawn":
        rows.push({ key, ts: event.ts, icon: "🤖", label: "Subagent 启动", detail: event.child, tone: "child" });
        break;
      case "agent_done":
        rows.push({
          key,
          ts: event.ts,
          icon: "◼",
          label: "Subagent 结束",
          detail: [event.status, event.stop, event.summary].filter(Boolean).join(" · "),
          tone: "child",
        });
        break;
      case "approval_request":
        rows.push({
          key,
          ts: event.ts,
          icon: "🛡",
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
          icon: event.outcome === "allowed-once" ? "✓" : "⛔",
          label: `审批结果 · ${event.outcome || "unknown"}`,
          tone: event.outcome === "allowed-once" ? "approve" : "reject",
          indent: 2,
        });
        break;
      case "error":
        rows.push({ key, ts: event.ts, icon: "!", label: "Error", text: event.message, tone: "error" });
        break;
      case "usage": {
        const usage = event.usage;
        rows.push({
          key,
          ts: event.ts,
          icon: "#",
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
          icon: event.finish_reason === "stopped" ? "■" : "◼",
          label: `结束 · ${event.finish_reason || "completed"}`,
          tone: event.finish_reason === "stopped" ? "stop" : "end",
          durationMs: turnStart > 0 ? event.ts - turnStart : undefined,
        });
        break;
      default:
        break;
    }
  });
  return rows;
}

function matches(row: Row, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "tools") return row.tone === "tool" || row.tone === "result";
  if (filter === "messages") return row.tone === "assistant" || row.tone === "user" || row.tone === "reasoning";
  return row.tone === "approval" || row.label.includes("审批");
}

export function TrajectoryView({
  events,
  agents,
  running,
}: {
  events: TrajectoryEvent[];
  agents: AgentSpecInfo[];
  running: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const ref = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => buildRows(events, agents), [events, agents]);
  const visible = rows.filter((row) => matches(row, filter));
  const turns = events.filter((event) => event.type === "turn_start").length;
  const steps = events.filter((event) => event.type === "step_start").length;
  const tools = events.filter((event) => event.type === "tool_call").length;
  const outputTokens = events.reduce((sum, event) => sum + (event.usage?.outputTokens ?? 0), 0);
  const totalMs = events.length > 1 ? events[events.length - 1].ts - events[0].ts : 0;

  useEffect(() => {
    const el = ref.current;
    if (el && running) el.scrollTop = el.scrollHeight;
  }, [events.length, running]);

  return (
    <div className="panel-view trajectory-view">
      <div className="panel-head">
        <div className="panel-head-copy">
          <div className="panel-eyebrow">
            <IconRoute size={15} />
            <span>运行轨迹</span>
          </div>
          <h2>Turn · Step · Tool 时间线</h2>
          <p>按时间顺序记录当前会话的每一步执行细节,包含推理、工具调用和人工审批。</p>
        </div>
        <div className="panel-stats">
          <span>{turns} turns</span>
          <span>{steps} steps</span>
          <span>{tools} tools</span>
          {outputTokens > 0 && <span>{formatTokens(outputTokens)} tok</span>}
          {totalMs > 0 && <span>{formatDurationShort(totalMs)}</span>}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="panel-empty">
          <span className="panel-empty-icon"><IconRoute size={28} /></span>
          <h2>还没有轨迹</h2>
          <p>发送一条消息后,这里会按 turn / step / tool / assistant 记录完整执行过程。</p>
        </div>
      ) : (
        <>
          <div className="filter-row" role="tablist" aria-label="轨迹筛选">
            <IconFilter size={14} />
            {FILTERS.map((item) => (
              <button
                type="button"
                key={item.id}
                role="tab"
                aria-selected={filter === item.id}
                className={cx("filter-chip", filter === item.id && "is-active")}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
                <span className="filter-count">
                  {item.id === "all" ? rows.length : rows.filter((row) => matches(row, item.id)).length}
                </span>
              </button>
            ))}
          </div>

          <div className="traj-scroll" ref={ref}>
            <div className="traj-list">
              {visible.map((row) => (
                <div className={cx("traj-row", row.tone && `is-${row.tone}`)} key={row.key}>
                  <span className="traj-marker">
                    <span className="traj-dot">{row.icon}</span>
                  </span>
                  <div className="traj-body" style={{ marginLeft: (row.indent ?? 0) * 14 }}>
                    <div className="traj-head">
                      <span className="traj-label">{row.label}</span>
                      <span className="traj-time">
                        {formatClock(row.ts)}
                        {row.durationMs !== undefined ? ` · ${formatDurationShort(row.durationMs)}` : ""}
                      </span>
                    </div>
                    {row.detail && <div className="traj-detail">{row.detail}</div>}
                    {row.text && <div className="traj-text">{row.text}</div>}
                  </div>
                </div>
              ))}
              {visible.length === 0 && <div className="traj-empty">这个筛选下没有记录</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
