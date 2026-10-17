import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, streamTurn } from "./api";
import { ApprovalBar } from "./components/ApprovalBar";
import { Composer, type ComposerProps } from "./components/Composer";
import { Flow } from "./components/Flow";
import { Rail } from "./components/Rail";
import { TeamDock } from "./components/TeamDock";
import { TopBar } from "./components/TopBar";
import { TrajectoryDock } from "./components/TrajectoryDock";
import { useTheme } from "./lib/theme";
import type { Block, ChatSummary, ChildGroup, ConfigInfo, PendingApproval, TeamPanel, TrajectoryEvent, TranscriptEntry, TurnEvent } from "./types";

const AGENT_LABEL = { coder: "👨‍💻 Coder", reviewer: "🔍 Reviewer" } as const;

interface TurnState {
  blocks: Block[];
  children: ChildGroup[];
}

const EMPTY_TURN: TurnState = { blocks: [], children: [] };

const TRAJECTORY_KEY = "agentbox-trajectory:";
const TRAJECTORY_LIMIT = 500;
const TRAJECTORY_SKIP = new Set([
  "assistant_delta",
  "assistant_stream_start",
  "assistant_stream_end",
  "chat_title",
  "done",
]);

function loadTrajectory(chatId: string): TrajectoryEvent[] {
  try {
    const raw = sessionStorage.getItem(TRAJECTORY_KEY + chatId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TrajectoryEvent[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveTrajectory(chatId: string, events: TrajectoryEvent[]): void {
  try {
    sessionStorage.setItem(TRAJECTORY_KEY + chatId, JSON.stringify(events));
  } catch {
    // 存储满了也不影响主流程。
  }
}

function phaseStageLabel(stage: string | undefined, round: number | undefined): string {
  return stage === "start"
    ? "开始编码"
    : stage === "fix"
      ? `第 ${round} 轮修复`
      : "审查中";
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}

interface ReduceCtx {
  setStatus: (s: string) => void;
  onTeamPanel: (fn: (p: TeamPanel | null) => TeamPanel | null) => void;
  openDock: () => void;
}

function reduceTurn(prev: TurnState, ev: TurnEvent, ctx: ReduceCtx): TurnState {
  const isChild = ev.scope === "child";
  const blocks = [...prev.blocks];
  let children = prev.children;

  switch (ev.type) {
    case "user_echo":
      blocks.push({ kind: "user", text: ev.text });
      break;

    case "turn_start":
      if (!isChild) ctx.setStatus(`Turn ${ev.turn} 进行中…`);
      break;

    case "step_start":
      if (!isChild) ctx.setStatus(`Turn ${ev.turn} · Step ${ev.step} …`);
      break;

    case "tool_call": {
      const block: Block = {
        kind: "tool",
        name: ev.name || "tool",
        detail: ev.detail || "",
        callId: ev.callId || "",
        agent: ev.agent,
        scope: ev.scope,
      };
      if (isChild) {
        for (const child of children) {
          if (child.status === undefined) {
            child.lines.push({ kind: "tool", text: `${ev.name || "tool"} ${ev.detail || ""}`.slice(0, 120), callId: ev.callId });
            break;
          }
        }
      } else {
        blocks.push(block);
      }
      break;
    }

    case "tool_result": {
      const result = { text: ev.text || "", isError: Boolean(ev.isError) };
      attach: {
        if (isChild) {
          for (let i = children.length - 1; i >= 0; i--) {
            const child = children[i];
            const line = [...child.lines].reverse().find((l) => l.kind === "tool" && l.callId === ev.callId);
            if (line) {
              line.result = result;
              break attach;
            }
            if (child.status !== undefined && child !== children[children.length - 1]) continue;
          }
          children[children.length - 1]?.lines.push({
            kind: "tool",
            text: (ev.text || "").slice(0, 160),
            result,
          });
          break attach;
        }
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (b.kind === "tool" && b.callId && b.callId === ev.callId) {
            blocks[i] = { ...b, result };
            break attach;
          }
        }
        blocks.push({ kind: "tool", name: "tool", detail: "", callId: ev.callId || "", result });
      }
      break;
    }

    case "assistant_stream_start": {
      if (isChild) break;
      if (
        !blocks.some(
          (b) => b.kind === "message" && b.streamId !== undefined && b.streamId === ev.streamId,
        )
      ) {
        blocks.push({
          kind: "message",
          text: "",
          streamId: ev.streamId,
          agent: ev.agent,
          scope: ev.scope,
        });
      }
      break;
    }

    case "assistant_delta": {
      if (isChild) break;
      const idx = findLastIndex(
        blocks,
        (b) => b.kind === "message" && b.streamId !== undefined && b.streamId === ev.streamId,
      );
      if (idx >= 0) {
        const cur = blocks[idx];
        if (cur.kind === "message") {
          blocks[idx] = { ...cur, text: (cur.text ?? "") + (ev.text ?? "") };
        }
      } else {
        blocks.push({
          kind: "message",
          text: ev.text ?? "",
          streamId: ev.streamId,
          agent: ev.agent,
          scope: ev.scope,
        });
      }
      break;
    }

    case "assistant_stream_end": {
      if (isChild) break;
      const idx = findLastIndex(
        blocks,
        (b) => b.kind === "message" && b.streamId !== undefined && b.streamId === ev.streamId,
      );
      if (idx >= 0) {
        const cur = blocks[idx];
        if (cur.kind === "message" && !cur.text) blocks.splice(idx, 1);
      }
      break;
    }

    case "message": {
      if (isChild) {
        children = [...children];
        let group = [...children].find((c) => c.status === undefined);
        if (!group) {
          group = { childId: `child-${children.length}`, lines: [], open: true };
          children.push(group);
        }
        group = { ...group, lines: [...group.lines] };
        children[children.length - 1] = group;
        const text = String(ev.text || "");
        if (text) {
          group.lines.push({ kind: "message", text: text.length > 160 ? text.slice(0, 160) + "…" : text });
        }
        if (ev.reasoning) {
          const r = String(ev.reasoning).replace(/\s+/g, " ").trim();
          if (r) {
            const last = group.lines[group.lines.length - 1];
            if (last?.kind === "reasoning") last.text = (last.text + "\n" + r).slice(0, 300);
            else group.lines.push({ kind: "reasoning", text: r.slice(0, 220) });
          }
        }
        break;
      }
      const streamIdx = findLastIndex(
        blocks,
        (b) =>
          b.kind === "message" &&
          b.streamId !== undefined &&
          b.agent === ev.agent &&
          b.scope === ev.scope,
      );
      if (streamIdx >= 0) {
        const cur = blocks[streamIdx];
        const text = ev.text ?? (cur.kind === "message" ? cur.text : "");
        blocks[streamIdx] = {
          kind: "message",
          text,
          agent: ev.agent,
          scope: ev.scope,
        };
        if (ev.agent) {
          ctx.onTeamPanel((p) => ({
            ...(p ?? { timeline: [] }),
            [ev.agent === "coder" ? "coderText" : "reviewerText"]: text,
          }));
        }
      } else if (ev.agent) {
        const idx = blocks.findIndex((b) => b.kind === "message" && b.agent === ev.agent);
        if (idx >= 0) {
          const cur = blocks[idx];
          if (cur.kind === "message") blocks[idx] = { ...cur, text: ev.text ?? "" };
        } else blocks.push({ kind: "message", text: ev.text ?? "", agent: ev.agent });
        ctx.onTeamPanel((p) => ({
          ...(p ?? { timeline: [] }),
          [ev.agent === "coder" ? "coderText" : "reviewerText"]: ev.text ?? "",
        }));
      } else {
        const idx = blocks.findIndex((b) => b.kind === "message" && !b.agent);
        if (idx >= 0) {
          const cur = blocks[idx];
          if (cur.kind === "message") blocks[idx] = { ...cur, text: ev.text ?? "" };
        } else blocks.push({ kind: "message", text: ev.text ?? "" });
      }
      if (ev.reasoning) {
        const r = String(ev.reasoning).replace(/\s+/g, " ").trim();
        if (r) {
          const last = blocks[blocks.length - 1];
          if (last?.kind === "reasoning") last.text = (last.text + "\n" + r).slice(0, 400);
          else blocks.push({ kind: "reasoning", text: r.slice(0, 300) });
        }
      }
      break;
    }

    case "reasoning": {
      const text = String(ev.text || "").replace(/\s+/g, " ").trim();
      if (!text) break;
      const last = blocks[blocks.length - 1];
      if (last?.kind === "reasoning") last.text = (last.text + "\n" + text).slice(0, 600);
      else blocks.push({ kind: "reasoning", text: text.slice(0, 320), scope: ev.scope, agent: ev.agent });
      break;
    }

    case "phase": {
      blocks.push({ kind: "phase", agent: ev.agent, stage: ev.stage, round: ev.round });
      ctx.setStatus(`${AGENT_LABEL[ev.agent || "coder"]} ${phaseStageLabel(ev.stage, ev.round)}…`);
      ctx.openDock();
      ctx.onTeamPanel((p) => ({
        ...(p ?? { timeline: [] }),
        [ev.agent === "reviewer" ? "reviewerStage" : "coderStage"]: ev.stage,
        [ev.agent === "reviewer" ? "reviewerRound" : "coderRound"]: ev.round,
      }));
      break;
    }

    case "verdict": {
      blocks.push({ kind: "verdict", verdict: ev.verdict, round: ev.round });
      ctx.setStatus(ev.verdict === "APPROVE" ? "✅ Reviewer 通过" : `🔁 Reviewer 打回(第 ${ev.round} 轮)`);
      ctx.onTeamPanel((p) => ({
        ...(p ?? { timeline: [] }),
        reviewerStage: "done",
        timeline: [...(p?.timeline ?? []), { verdict: ev.verdict || "", round: ev.round ?? 0 }],
        [ev.verdict === "NEEDS_CHANGES" ? "coderStage" : "coderStage"]: ev.verdict === "NEEDS_CHANGES" ? undefined : "done",
      }));
      break;
    }

    case "agent_spawn":
      children = [...children, { childId: ev.child || `child-${children.length}`, lines: [], open: true }];
      ctx.setStatus("🤖 子代理已启动");
      break;

    case "agent_done":
      children = children.map((c) =>
        c.childId === ev.child
          ? {
              ...c,
              status: `${ev.status || ev.stop || "完成"}`,
              lines: ev.summary ? [...c.lines, { kind: "message", text: ev.summary }] : c.lines,
            }
          : c,
      );
      ctx.setStatus("🏁 子代理结束");
      break;

    case "chat_title":
      break; // 标题更新在回调里做

    case "error":
      blocks.push({ kind: "error", text: ev.message || "模型请求失败" });
      ctx.setStatus("");
      break;

    case "end": {
      if (ev.finish_reason === "stopped") {
        // runtime 被硬中断时不会有 assistant_stream_end/最终 message;
        // 清掉空的流式占位块,给用户一个明确的停止提示。
        for (let i = blocks.length - 1; i >= 0; i--) {
          const block = blocks[i];
          if (block.kind === "message" && !block.text) blocks.splice(i, 1);
        }
        blocks.push({ kind: "note", text: "⏹️ 已停止全部任务" });
        ctx.onTeamPanel((p) => (p ? { ...p, coderStage: "done", reviewerStage: "done" } : p));
        break;
      }
      const hasMain = blocks.some((b) => b.kind === "message" && !b.agent);
      if (ev.response) {
        if (!hasMain) blocks.push({ kind: "message", text: ev.response });
      } else {
        const emptyIdx = blocks.findIndex((b) => b.kind === "message" && !b.agent && !b.text);
        if (emptyIdx >= 0) blocks[emptyIdx] = { kind: "note", text: "(本轮没有文本回复,详见会话记录)" };
        else if (!hasMain) blocks.push({ kind: "note", text: "(本轮没有文本回复,详见会话记录)" });
      }
      ctx.onTeamPanel((p) => (p ? { ...p, coderStage: p.coderStage === "done" ? p.coderStage : "done", reviewerStage: p.reviewerStage === "done" ? p.reviewerStage : "done" } : p));
      break;
    }
  }

  return { blocks, children };
}

export default function App() {
  const { theme, toggle } = useTheme();
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [turn, setTurn] = useState<TurnState>(EMPTY_TURN);
  const [trajectory, setTrajectory] = useState<TrajectoryEvent[]>([]);
  const trajectoryRef = useRef<Record<string, TrajectoryEvent[]>>({});
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [team, setTeam] = useState<ComposerProps["team"]>(null);
  const [dockOpen, setDockOpen] = useState(false);
  const [dockTab, setDockTab] = useState<"team" | "trajectory">("team");
  const [notice, setNotice] = useState<{ kind: "err" | "info"; text: string } | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);

  const runningRef = useRef(false);
  const activeRef = useRef<string | null>(null);

  const active = chats.find((c) => c.id === activeId) ?? null;

  const showToast = useCallback((text: string, kind: "err" | "info" = "err") => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice(null), 4000);
  }, []);

  /* ---- 初始化 ---- */
  useEffect(() => {
    void (async () => {
      try {
        const cfg = await api.config();
        setConfig(cfg);
        const list = await api.chats();
        setChats(list);
        if (list.length > 0) void selectChat(list[0].id);
      } catch (e) {
        setConnError(`无法连接后端:${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectChat = useCallback(
    async (id: string) => {
      if (runningRef.current) return;
      setActiveId(id);
      activeRef.current = id;
      setTurn(EMPTY_TURN);
      const storedTrajectory = trajectoryRef.current[id] ?? loadTrajectory(id);
      trajectoryRef.current[id] = storedTrajectory;
      setTrajectory(storedTrajectory);
      try {
        const data = await api.chat(id);
        setEntries(data.transcript || []);
        if (data.title) setChats((prev) => prev.map((c) => (c.id === id ? { ...c, title: data.title } : c)));
        document.title = `${data.title || "新会话"} · AgentBox`;
      } catch (e) {
        showToast(`加载会话失败:${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [showToast],
  );

  const createChat = useCallback(
    async (firstText?: string, teamReq = false) => {
      const chat = await api.createChat();
      setChats((prev) => [{ ...chat, title: firstText ? firstText.slice(0, 18) : chat.title }, ...prev]);
      setActiveId(chat.id);
      activeRef.current = chat.id;
      setEntries([]);
      setTurn(EMPTY_TURN);
      trajectoryRef.current[chat.id] = [];
      setTrajectory([]);
      void sendTurn(chat.id, firstText ?? "", teamReq); // eslint-disable-line @typescript-eslint/no-floating-promises
    },
    // sendTurn 在下方声明,使用函数提升不适用;存在前向依赖,这里以 ref 传递
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const removeChat = useCallback(
    async (id: string) => {
      try {
        await api.removeChat(id);
        if (activeRef.current === id) {
          setActiveId(null);
          activeRef.current = null;
          setEntries([]);
          setTurn(EMPTY_TURN);
          setTrajectory([]);
        }
        delete trajectoryRef.current[id];
        try {
          sessionStorage.removeItem(TRAJECTORY_KEY + id);
        } catch {
          /* ignore */
        }
        setChats((prev) => prev.filter((c) => c.id !== id));
      } catch (e) {
        showToast(e instanceof ApiError && e.status === 409 ? "会话正在运行,无法删除" : `删除失败:${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [showToast],
  );

  const sendTurn = useCallback(
    async (chatId: string, text: string, teamReq: boolean) => {
      if (runningRef.current) {
        showToast("上一条还在处理中");
        return;
      }
      const chat = chats.find((c) => c.id === chatId);
      // 新建会话后立刻发首条消息时,chats 闭包里还没有这个 chat;
      // 不能因此直接 return,否则会创建会话但消息永远不发送。
      if (chat && (chat.title === "新会话" || !chat.title)) {
        setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, title: text.slice(0, 18) } : c)));
      }

      runningRef.current = true;
      setRunning(true);
      setStatus("Agent 启动中…");
      if (teamReq) {
        setTeam({ timeline: [] });
        setDockTab("team");
        setDockOpen(true);
      }

      let titleSeen = false;
      const record = (ev: TurnEvent) => {
        if (TRAJECTORY_SKIP.has(ev.type)) return;
        const entry: TrajectoryEvent = { ...ev, ts: Date.now() };
        const current = trajectoryRef.current[chatId] ?? [];
        const next = [...current, entry].slice(-TRAJECTORY_LIMIT);
        trajectoryRef.current[chatId] = next;
        saveTrajectory(chatId, next);
        if (activeRef.current === chatId) setTrajectory(next);
      };
      const apply = (ev: TurnEvent) => {
        record(ev);
        if (ev.type === "chat_title" && ev.title && !titleSeen) {
          titleSeen = true;
          setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, title: ev.title! } : c)));
          document.title = `${ev.title} · AgentBox`;
        }
        if (ev.type === "approval_request" && ev.approvalId) {
          setApprovals((prev) => [
            ...prev.filter((approval) => approval.id !== ev.approvalId),
            {
              id: ev.approvalId!,
              chatId: ev.chatId,
              toolName: ev.toolName || "tool",
              callId: ev.callId,
              reason: ev.reason,
              timeoutSeconds: ev.timeoutSeconds,
            },
          ]);
          setStatus("⏸ 等待人工审批…");
          return;
        }
        if (ev.type === "approval_resolved" && ev.approvalId) {
          setApprovals((prev) => prev.filter((approval) => approval.id !== ev.approvalId));
          if (runningRef.current) setStatus("审批已处理,继续执行…");
          return;
        }
        if (ev.type === "end") {
          setApprovals((prev) => prev.filter((approval) => approval.chatId !== chatId));
        }
        setTurn((prev) =>
          reduceTurn(prev, ev, {
            setStatus,
            onTeamPanel: setTeam,
            openDock: () => setDockOpen(true),
          }),
        );
      };

      try {
        await streamTurn(chatId, text, teamReq, apply);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) showToast("上一条消息还在处理中");
        else setTurn((prev) => ({ ...prev, blocks: [...prev.blocks, { kind: "error", text: e instanceof Error ? e.message : String(e) }] }));
      } finally {
        runningRef.current = false;
        setRunning(false);
        setStatus("");
        setApprovals((prev) => prev.filter((approval) => approval.chatId !== chatId));
        try {
          const list = await api.chats();
          setChats(list);
          if (activeRef.current === chatId) {
            const fresh = await api.chat(chatId);
            setEntries(fresh.transcript || []);
            setTurn(EMPTY_TURN);
          }
        } catch {
          /* 刷新失败不影响主流程,静默即可 */
        }
      }
    },
    [chats, showToast],
  );

  const handleSend = useCallback(
    (text: string, teamReq: boolean) => {
      if (activeId) void sendTurn(activeId, text, teamReq);
      else void createChat(text, teamReq);
    },
    [activeId, createChat, sendTurn],
  );

  const handleCreate = useCallback(() => {
    if (runningRef.current) return;
    void createChat();
  }, [createChat]);

  const toggleDock = useCallback(
    (tab: "team" | "trajectory") => {
      setDockTab(tab);
      setDockOpen((open) => (dockTab === tab ? !open : true));
    },
    [dockTab],
  );

  const stopAll = useCallback(async () => {
    setStatus("正在停止全部任务…");
    try {
      const res = await api.stopAll();
      setApprovals([]);
      showToast(res.message || "全部任务已停止");
    } catch (e) {
      setStatus("");
      showToast(`停止失败:${e instanceof Error ? e.message : String(e)}`);
    }
  }, [showToast]);

  const decideApproval = useCallback(
    async (approvalId: string, decision: "approve" | "reject") => {
      try {
        const res = await api.resolveApproval(approvalId, decision);
        setApprovals((prev) => prev.filter((approval) => approval.id !== approvalId));
        showToast(
          res.outcome === "allowed-once" ? "已批准本次工具调用" : "已拒绝本次工具调用",
          "info",
        );
      } catch (e) {
        showToast(`审批提交失败:${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [showToast],
  );

  const runningChatId = running && activeId ? activeId : null;

  return (
    <div className={`shell${dockOpen ? "" : " dock-hidden"}`}>
      <Rail
        chats={chats}
        runningChatId={runningChatId}
        activeId={activeId}
        config={config}
        disabled={running}
        onSelect={(id) => void selectChat(id)}
        onCreate={handleCreate}
        onDelete={(id) => void removeChat(id)}
        theme={theme}
        onToggleTheme={toggle}
      />
      <main className="main">
        <TopBar
          chat={active}
          status={status}
          running={running}
          streaming={config?.streaming}
          dockOpen={dockOpen}
          dockTab={dockTab}
          onToggleDock={toggleDock}
          onStopAll={() => void stopAll()}
          theme={theme}
          onToggleTheme={toggle}
        />
        {connError && <div className="err-box" style={{ margin: "10px 18px" }}>{connError}</div>}
        {config?.mock && (
          <div className="chip-row" style={{ margin: "10px 18px 0" }}>
            <span className="chip chip-mock">
              <span className="dot" />Mock 模式:.env 里 DEEPSEEK_API_KEY 还是占位符,本地剧本回放中
            </span>
            {config.startupError && <span className="chip">{config.startupError}</span>}
          </div>
        )}
        <Flow
          entries={entries}
          blocks={turn.blocks}
          childGroups={turn.children}
          running={running}
          emptyHint={
            config?.mock
              ? "服务运行在 Mock 模式,发送一条消息体验交互流程。"
              : active
                ? "给 agent 布置一个任务;工程师+审查员随时待命。"
                : "先在左侧新建一个会话,或点击＋开始。"
          }
        />
        <ApprovalBar approvals={approvals} onDecide={(id, decision) => void decideApproval(id, decision)} />
        <Composer disabled={!activeId && !connError && !config} running={running} onSubmit={handleSend} team={team} />
      </main>
      {dockTab === "team" ? (
        <TeamDock open={dockOpen} data={team} />
      ) : (
        <TrajectoryDock open={dockOpen} events={trajectory} />
      )}
      {notice && <div className="toast">{notice.text}</div>}
    </div>
  );
}
