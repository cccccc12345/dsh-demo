import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, streamTurn } from "./api";
import { ApprovalBar } from "./components/ApprovalBar";
import { BrandLockup } from "./components/Brand";
import { CommandPalette } from "./components/CommandPalette";
import { Composer } from "./components/Composer";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Conversation } from "./components/Conversation";
import { MainHeader } from "./components/MainHeader";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { TeamView } from "./components/TeamView";
import { Toast, type ToastState } from "./components/Toast";
import { TrajectoryView } from "./components/TrajectoryView";
import { Welcome } from "./components/Welcome";
import { IconAlert, IconRefresh, IconSparkles, IconX } from "./components/Icons";
import { useTheme } from "./lib/theme";
import {
  cx,
  downloadText,
  formatDateTime,
  formatDurationShort,
  safeFilename,
} from "./lib/ui";
import type {
  AgentSpecInfo,
  Block,
  ChatSummary,
  ChildGroup,
  ChildLine,
  ConfigInfo,
  FeedbackValue,
  PendingApproval,
  TeamPanel,
  TrajectoryEvent,
  TranscriptEntry,
  TurnEvent,
  TurnMeta,
  ViewTab,
} from "./types";

const TRAJECTORY_KEY = "agentbox-trajectory:";
const TRAJECTORY_LIMIT = 500;
const LAST_CHAT_KEY = "agentbox-last-chat";
const PINNED_KEY = "agentbox-pinned";
const SIDEBAR_KEY = "agentbox-sidebar-collapsed";

const TRAJECTORY_SKIP = new Set([
  "assistant_delta",
  "assistant_stream_start",
  "assistant_stream_end",
  "chat_title",
]);

interface TurnState {
  blocks: Block[];
  children: ChildGroup[];
  meta: TurnMeta | null;
}

const EMPTY_TURN: TurnState = { blocks: [], children: [], meta: null };

interface ConfirmState {
  kind: "delete" | "stop";
  chatId?: string;
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 存储被禁用不影响主流程 */
  }
}

function readPinned(): string[] {
  const raw = readStored(PINNED_KEY);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function loadTrajectory(chatId: string): TrajectoryEvent[] {
  try {
    const raw = sessionStorage.getItem(TRAJECTORY_KEY + chatId);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TrajectoryEvent[]) : [];
  } catch {
    return [];
  }
}

function saveTrajectory(chatId: string, events: TrajectoryEvent[]): void {
  try {
    sessionStorage.setItem(TRAJECTORY_KEY + chatId, JSON.stringify(events));
  } catch {
    /* 存储满了不影响主流程 */
  }
}

function agentView(agents: AgentSpecInfo[], id?: string) {
  const found = id ? agents.find((agent) => agent.id === id) : undefined;
  return {
    emoji: found?.emoji ?? "🤖",
    name: found?.name ?? id ?? "Agent",
  };
}

function phaseStageLabel(stage: string | undefined, round: number | undefined): string {
  if (stage === "start") return "运行中";
  if (stage === "fix") return `第 ${round ?? 0} 轮修复`;
  if (stage === "review") return "审查中";
  if (stage === "done") return "已完成";
  return "处理中";
}

function markAllStagesDone(panel: TeamPanel | null): TeamPanel | null {
  if (!panel) return panel;
  const stages = Object.fromEntries(
    Object.entries(panel.stages).map(([id, stage]) => [id, { ...stage, stage: "done" }]),
  );
  return { ...panel, stages };
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}

interface ReduceCtx {
  setStatus: (status: string) => void;
  onTeamPanel: (updater: (panel: TeamPanel | null) => TeamPanel | null) => void;
  agents: AgentSpecInfo[];
}

function appendChildLine(children: ChildGroup[], line: ChildLine): ChildGroup[] {
  const next = [...children];
  const openIndex = findLastIndex(next, (child) => child.status === undefined);
  const target = openIndex >= 0 ? openIndex : next.length - 1;
  if (target < 0) return [{ childId: "child-0", lines: [line], open: true }];
  next[target] = { ...next[target], lines: [...next[target].lines, line] };
  return next;
}

function attachChildResult(
  children: ChildGroup[],
  result: { text: string; isError: boolean },
  callId?: string,
): ChildGroup[] {
  const next = [...children];
  for (let i = next.length - 1; i >= 0; i--) {
    const child = next[i];
    const lineIndex = findLastIndex(
      child.lines,
      (line) => line.kind === "tool" && Boolean(callId) && line.callId === callId,
    );
    if (lineIndex >= 0) {
      const lines = [...child.lines];
      lines[lineIndex] = { ...lines[lineIndex], result };
      next[i] = { ...child, lines };
      return next;
    }
  }
  return appendChildLine(next, {
    kind: "tool",
    text: (result.text || "").slice(0, 200),
    callId,
    result,
  });
}

function reduceTurn(prev: TurnState, event: TurnEvent, ctx: ReduceCtx): TurnState {
  const isChild = event.scope === "child";
  let blocks = prev.blocks;
  let children = prev.children;
  let meta = prev.meta;

  const patchMeta = (patch: Partial<TurnMeta>) => {
    meta = { ...(meta ?? {}), ...patch };
  };

  switch (event.type) {
    case "user_echo":
      blocks = [...blocks, { kind: "user", text: event.text }];
      break;

    case "turn_start":
      if (!isChild) {
        ctx.setStatus(`Turn ${event.turn ?? ""} 进行中…`);
        patchMeta({ startedAt: meta?.startedAt ?? Date.now() });
      }
      break;

    case "step_start":
      if (!isChild) ctx.setStatus(`Turn ${event.turn ?? ""} · Step ${event.step ?? ""} …`);
      break;

    case "usage":
      if (event.usage) patchMeta({ usage: event.usage });
      break;

    case "tool_call": {
      const block: Block = {
        kind: "tool",
        name: event.name || "tool",
        detail: event.detail || "",
        callId: event.callId || "",
        agent: event.agent,
        scope: event.scope,
      };
      if (isChild) {
        children = appendChildLine(children, {
          kind: "tool",
          text: `${event.name || "tool"} ${event.detail || ""}`.slice(0, 160),
          callId: event.callId,
        });
      } else {
        blocks = [...blocks, block];
      }
      break;
    }

    case "tool_result": {
      const result = { text: event.text || "", isError: Boolean(event.isError) };
      if (isChild) {
        children = attachChildResult(children, result, event.callId);
        break;
      }
      let matched = false;
      blocks = blocks.map((block) => {
        if (block.kind === "tool" && event.callId && block.callId === event.callId) {
          matched = true;
          return { ...block, result };
        }
        return block;
      });
      if (!matched) {
        blocks = [
          ...blocks,
          { kind: "tool", name: "tool", detail: "", callId: event.callId || "", result },
        ];
      }
      break;
    }

    case "assistant_stream_start": {
      if (isChild) break;
      if (!blocks.some((block) => block.kind === "message" && block.streamId === event.streamId)) {
        blocks = [
          ...blocks,
          {
            kind: "message",
            text: "",
            streamId: event.streamId,
            agent: event.agent,
            scope: event.scope,
          },
        ];
      }
      break;
    }

    case "assistant_delta": {
      if (isChild) break;
      const index = findLastIndex(
        blocks,
        (block) => block.kind === "message" && block.streamId === event.streamId,
      );
      if (index >= 0) {
        const current = blocks[index];
        if (current.kind === "message") {
          blocks = blocks.map((block, i) =>
            i === index ? { ...current, text: `${current.text ?? ""}${event.text ?? ""}` } : block,
          );
        }
      } else {
        blocks = [
          ...blocks,
          {
            kind: "message",
            text: event.text ?? "",
            streamId: event.streamId,
            agent: event.agent,
            scope: event.scope,
          },
        ];
      }
      break;
    }

    case "assistant_stream_end": {
      if (isChild) break;
      const index = findLastIndex(
        blocks,
        (block) => block.kind === "message" && block.streamId === event.streamId,
      );
      if (index >= 0) {
        const current = blocks[index];
        if (current.kind === "message" && !current.text) {
          blocks = blocks.filter((_, i) => i !== index);
        } else {
          blocks = blocks.map((block, i) =>
            i === index && block.kind === "message" ? { ...block, streamId: undefined } : block,
          );
        }
      }
      break;
    }

    case "message": {
      if (isChild) {
        const text = String(event.text || "");
        if (text) {
          children = appendChildLine(children, {
            kind: "message",
            text: text.length > 200 ? `${text.slice(0, 200)}…` : text,
          });
        }
        if (event.reasoning) {
          const reasoning = String(event.reasoning).replace(/\s+/g, " ").trim();
          if (reasoning) {
            children = appendChildLine(children, {
              kind: "reasoning",
              text: reasoning.slice(0, 220),
            });
          }
        }
        break;
      }

      if (event.reasoning) {
        const reasoning = String(event.reasoning).replace(/\s+/g, " ").trim();
        if (reasoning) {
          const last = blocks[blocks.length - 1];
          if (last?.kind === "reasoning") {
            blocks = [
              ...blocks.slice(0, -1),
              { ...last, text: `${last.text}\n${reasoning}`.slice(0, 2000) },
            ];
          } else {
            blocks = [
              ...blocks,
              {
                kind: "reasoning",
                text: reasoning.slice(0, 1200),
                agent: event.agent,
                scope: event.scope,
              },
            ];
          }
        }
      }

      const messageText = event.text;
      if (!messageText) break;

      const streamIndex = findLastIndex(
        blocks,
        (block) =>
          block.kind === "message" &&
          block.streamId !== undefined &&
          block.agent === event.agent &&
          block.scope === event.scope,
      );
      if (streamIndex >= 0) {
        blocks = blocks.map((block, i) =>
          i === streamIndex ? { kind: "message", text: messageText, agent: event.agent, scope: event.scope } : block,
        );
      } else if (event.agent) {
        const index = blocks.findIndex(
          (block) => block.kind === "message" && block.agent === event.agent,
        );
        if (index >= 0) {
          blocks = blocks.map((block, i) => (i === index ? { ...block, text: messageText } : block));
        } else {
          blocks = [...blocks, { kind: "message", text: messageText, agent: event.agent }];
        }
      } else {
        const index = blocks.findIndex(
          (block) => block.kind === "message" && !block.agent,
        );
        if (index >= 0) {
          blocks = blocks.map((block, i) => (i === index ? { ...block, text: messageText } : block));
        } else {
          blocks = [...blocks, { kind: "message", text: messageText }];
        }
      }

      if (event.agent) {
        const agentId = event.agent;
        ctx.onTeamPanel((panel) => {
          const base = panel ?? { stages: {}, timeline: [] };
          const previous = base.stages[agentId] ?? {};
          return {
            ...base,
            stages: { ...base.stages, [agentId]: { ...previous, text: messageText } },
          };
        });
      }
      break;
    }

    case "reasoning": {
      const text = String(event.text || "").replace(/\s+/g, " ").trim();
      if (!text) break;
      if (isChild) {
        children = appendChildLine(children, { kind: "reasoning", text: text.slice(0, 220) });
        break;
      }
      const last = blocks[blocks.length - 1];
      if (last?.kind === "reasoning") {
        blocks = [
          ...blocks.slice(0, -1),
          { ...last, text: `${last.text}\n${text}`.slice(0, 2000) },
        ];
      } else {
        blocks = [...blocks, { kind: "reasoning", text: text.slice(0, 1200), scope: event.scope, agent: event.agent }];
      }
      break;
    }

    case "phase": {
      blocks = [
        ...blocks,
        { kind: "phase", agent: event.agent, stage: event.stage, round: event.round },
      ];
      const view = agentView(ctx.agents, event.agent);
      ctx.setStatus(`${view.emoji} ${view.name} · ${phaseStageLabel(event.stage, event.round)}…`);
      if (event.agent) {
        const agentId = event.agent;
        ctx.onTeamPanel((panel) => {
          const base = panel ?? { stages: {}, timeline: [] };
          const previous = base.stages[agentId] ?? {};
          return {
            ...base,
            stages: {
              ...base.stages,
              [agentId]: { ...previous, stage: event.stage, round: event.round },
            },
          };
        });
      }
      break;
    }

    case "verdict": {
      blocks = [
        ...blocks,
        { kind: "verdict", verdict: event.verdict, round: event.round },
      ];
      ctx.setStatus(
        event.verdict === "APPROVE" ? "Reviewer 通过" : `Reviewer 打回(第 ${event.round ?? 0} 轮)`,
      );
      ctx.onTeamPanel((panel) => {
        const base = panel ?? { stages: {}, timeline: [] };
        const stages = { ...base.stages };
        if (stages.reviewer) stages.reviewer = { ...stages.reviewer, stage: "done" };
        if (event.verdict !== "NEEDS_CHANGES" && stages.coder) {
          stages.coder = { ...stages.coder, stage: "done" };
        }
        return {
          ...base,
          stages,
          timeline: [...base.timeline, { verdict: event.verdict || "", round: event.round ?? 0 }],
        };
      });
      break;
    }

    case "agent_spawn": {
      const childId = event.child || `child-${children.length}`;
      const existing = children.findIndex((child) => child.childId === childId);
      if (existing >= 0) {
        children = children.map((child, index) =>
          index === existing ? { ...child, status: undefined, open: true } : child,
        );
      } else {
        children = [...children, { childId, lines: [], open: true }];
      }
      ctx.setStatus("子代理已启动");
      break;
    }

    case "agent_done": {
      children = children.map((child) =>
        child.childId === event.child
          ? {
              ...child,
              status: event.status || event.stop || "完成",
              lines: event.summary
                ? [...child.lines, { kind: "message", text: event.summary }]
                : child.lines,
            }
          : child,
      );
      ctx.setStatus("子代理结束");
      break;
    }

    case "error": {
      blocks = [...blocks, { kind: "error", text: event.message || "模型请求失败" }];
      patchMeta({ failed: true, endedAt: Date.now() });
      ctx.setStatus("");
      break;
    }

    case "end": {
      patchMeta({ endedAt: Date.now(), finishReason: event.finish_reason });
      if (event.finish_reason === "stopped") {
        blocks = blocks.filter((block) => !(block.kind === "message" && !block.text));
        blocks = [...blocks, { kind: "note", text: "已停止全部任务" }];
      } else {
        const hasMessage = blocks.some((block) => block.kind === "message" && block.text);
        if (event.response && !hasMessage) {
          blocks = [...blocks, { kind: "message", text: event.response }];
        } else if (!hasMessage) {
          blocks = [...blocks, { kind: "note", text: "本轮没有文本回复,详见会话记录" }];
        }
      }
      ctx.onTeamPanel(markAllStagesDone);
      ctx.setStatus("");
      break;
    }

    default:
      break;
  }

  return { blocks, children, meta };
}

export default function App() {
  const { mode: themeMode, theme, setMode: setThemeMode, toggle: toggleTheme } = useTheme();
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [turn, setTurn] = useState<TurnState>(EMPTY_TURN);
  const [trajectory, setTrajectory] = useState<TrajectoryEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [team, setTeam] = useState<TeamPanel | null>(null);
  const [teamMode, setTeamMode] = useState(false);
  const [view, setView] = useState<ViewTab>("chat");
  const [notice, setNotice] = useState<ToastState | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readStored(SIDEBAR_KEY) === "1");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [pinned, setPinned] = useState<string[]>(readPinned);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [feedback, setFeedback] = useState<Record<string, FeedbackValue>>({});
  const [focusSignal, setFocusSignal] = useState(0);
  const [loadingChat, setLoadingChat] = useState(false);
  const [mockDismissed, setMockDismissed] = useState(false);
  const [now, setNow] = useState(Date.now());

  const runningRef = useRef(false);
  const activeRef = useRef<string | null>(null);
  const chatsRef = useRef<ChatSummary[]>([]);
  const trajectoryRef = useRef<Record<string, TrajectoryEvent[]>>({});
  const configRef = useRef<ConfigInfo | null>(null);
  const didInitRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);

  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    activeRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  useEffect(() => {
    try {
      localStorage.setItem(PINNED_KEY, JSON.stringify(pinned));
    } catch {
      /* ignore */
    }
  }, [pinned]);

  useEffect(() => {
    if (activeId) writeStored(LAST_CHAT_KEY, activeId);
  }, [activeId]);

  useEffect(() => {
    const active = chats.find((chat) => chat.id === activeId);
    document.title = active
      ? `${active.title || "新会话"} · AgentBox`
      : "AgentBox · DeepSeek Harness";
  }, [activeId, chats]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const showToast = useCallback(
    (text: string, kind: "info" | "success" | "error" = "info") => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      const id = Date.now();
      setNotice({ id, kind, text });
      toastTimerRef.current = window.setTimeout(() => {
        setNotice(null);
        toastTimerRef.current = null;
      }, 3600);
    },
    [],
  );

  const updateSidebarCollapsed = useCallback((next: boolean) => {
    setSidebarCollapsed(next);
    writeStored(SIDEBAR_KEY, next ? "1" : "0");
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((previous) => {
      const next = !previous;
      writeStored(SIDEBAR_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const selectChat = useCallback(
    async (chatId: string) => {
      if (runningRef.current && chatId !== activeRef.current) {
        showToast("当前会话运行中,完成后才能切换", "error");
        return;
      }
      if (chatId === activeRef.current) {
        setView("chat");
        setMobileOpen(false);
        return;
      }
      setActiveId(chatId);
      activeRef.current = chatId;
      setView("chat");
      setMobileOpen(false);
      setTeam(null);
      setFeedback({});
      setStatus("");
      setLoadingChat(true);
      setEntries([]);
      setTurn(EMPTY_TURN);
      const stored = trajectoryRef.current[chatId] ?? loadTrajectory(chatId);
      trajectoryRef.current[chatId] = stored;
      setTrajectory(stored);
      try {
        const detail = await api.chat(chatId);
        setEntries(detail.transcript || []);
        if (detail.title) {
          setChats((previous) =>
            previous.map((chat) => (chat.id === chatId ? { ...chat, title: detail.title } : chat)),
          );
        }
      } catch (error) {
        showToast(`加载会话失败:${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        setLoadingChat(false);
      }
    },
    [showToast],
  );

  const loadAll = useCallback(async () => {
    setConnError(null);
    try {
      const [configInfo, list] = await Promise.all([api.config(), api.chats()]);
      setConfig(configInfo);
      setChats(list);
      const storedId = readStored(LAST_CHAT_KEY);
      const target = list.find((chat) => chat.id === storedId) ?? list[0];
      if (target) {
        await selectChat(target.id);
      } else {
        setActiveId(null);
        activeRef.current = null;
        setEntries([]);
        setTurn(EMPTY_TURN);
        setTrajectory([]);
        setView("chat");
      }
    } catch (error) {
      setConnError(error instanceof Error ? error.message : String(error));
    }
  }, [selectChat]);

  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!config?.approval?.enabled) return;
    let stopped = false;
    const refresh = async () => {
      try {
        const list = await api.approvals();
        if (stopped) return;
        setApprovals(
          list.map((approval) => ({
            ...approval,
            timeoutSeconds: approval.timeoutSeconds ?? config.approval?.timeoutSeconds,
          })),
        );
      } catch {
        /* 轮询失败保持现有审批条 */
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [config?.approval?.enabled, config?.approval?.timeoutSeconds]);

  const createChat = useCallback(async () => {
    if (runningRef.current) {
      showToast("当前还有任务在运行,请先停止或等待完成", "error");
      return;
    }
    try {
      const chat = await api.createChat();
      setChats((previous) => [chat, ...previous]);
      setActiveId(chat.id);
      activeRef.current = chat.id;
      setEntries([]);
      setTurn(EMPTY_TURN);
      setTeam(null);
      setTrajectory([]);
      trajectoryRef.current[chat.id] = [];
      setView("chat");
      setFeedback({});
      setStatus("");
      setMobileOpen(false);
      setFocusSignal((value) => value + 1);
    } catch (error) {
      showToast(`新建会话失败:${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }, [showToast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSettingsOpen(false);
        setPaletteOpen((open) => !open);
      } else if (modifier && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (!runningRef.current) void createChat();
      } else if (modifier && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidebar();
      } else if (modifier && event.key === ",") {
        event.preventDefault();
        setPaletteOpen(false);
        setSettingsOpen(true);
      } else if (event.key === "Escape") {
        setMobileOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createChat, toggleSidebar]);

  const renameChat = useCallback(
    async (chatId: string, title: string) => {
      try {
        const updated = await api.renameChat(chatId, title);
        setChats((previous) =>
          previous.map((chat) => (chat.id === chatId ? { ...chat, title: updated.title } : chat)),
        );
      } catch (error) {
        showToast(`重命名失败:${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
    [showToast],
  );

  const performDeleteChat = useCallback(
    async (chatId: string) => {
      try {
        await api.removeChat(chatId);
        const remaining = chatsRef.current.filter((chat) => chat.id !== chatId);
        setChats(remaining);
        delete trajectoryRef.current[chatId];
        try {
          sessionStorage.removeItem(TRAJECTORY_KEY + chatId);
        } catch {
          /* ignore */
        }
        setPinned((previous) => previous.filter((id) => id !== chatId));
        if (activeRef.current === chatId) {
          activeRef.current = null;
          setActiveId(null);
          setEntries([]);
          setTurn(EMPTY_TURN);
          setTeam(null);
          setTrajectory([]);
          setView("chat");
          const next = remaining[0];
          if (next) void selectChat(next.id);
        }
        showToast("会话已删除", "success");
      } catch (error) {
        showToast(
          error instanceof ApiError && error.status === 409
            ? "会话正在运行,无法删除"
            : `删除失败:${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      } finally {
        setConfirm(null);
      }
    },
    [selectChat, showToast],
  );

  const requestDeleteChat = useCallback(
    (chatId: string) => {
      if (runningRef.current && chatId === activeRef.current) {
        showToast("会话正在运行,无法删除", "error");
        return;
      }
      const chat = chatsRef.current.find((item) => item.id === chatId);
      setConfirm({
        kind: "delete",
        chatId,
        title: "删除会话",
        message: `确定删除「${chat?.title || "新会话"}」吗?此操作不可撤销。`,
        confirmLabel: "删除",
        danger: true,
      });
    },
    [showToast],
  );

  const performStopAll = useCallback(async () => {
    setConfirm(null);
    setStatus("正在停止全部任务…");
    try {
      const result = await api.stopAll();
      setApprovals([]);
      showToast(result.message || "全部任务已停止", "success");
    } catch (error) {
      setStatus("");
      showToast(`停止失败:${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }, [showToast]);

  const requestStopAll = useCallback(() => {
    if (!runningRef.current && approvals.length === 0) {
      showToast("当前没有运行中的任务");
      return;
    }
    setConfirm({
      kind: "stop",
      title: "停止全部任务",
      message: "会硬中断共享 runtime,所有正在运行的会话会收到停止事件。下一条消息会自动重启。",
      confirmLabel: "停止全部",
      danger: true,
    });
  }, [approvals.length, showToast]);

  const sendTurn = useCallback(
    async (chatId: string, text: string, teamRequested: boolean) => {
      if (runningRef.current) {
        showToast("上一条还在处理中");
        return;
      }
      const chat = chatsRef.current.find((item) => item.id === chatId);
      if (chat && (!chat.title || chat.title === "新会话")) {
        setChats((previous) =>
          previous.map((item) =>
            item.id === chatId ? { ...item, title: text.slice(0, 18) } : item,
          ),
        );
      }

      runningRef.current = true;
      setRunning(true);
      setView("chat");
      setStatus(teamRequested ? "团队工作流启动中…" : "Agent 启动中…");
      setTurn({ blocks: [], children: [], meta: { startedAt: Date.now() } });
      if (teamRequested) {
        setTeam({ stages: {}, timeline: [] });
      }
      setFeedback({});
      setNow(Date.now());

      let titleSeen = false;
      let failed = false;
      let failureText = "";

      const record = (event: TurnEvent) => {
        if (TRAJECTORY_SKIP.has(event.type)) return;
        const entry: TrajectoryEvent = { ...event, ts: Date.now() };
        const current = trajectoryRef.current[chatId] ?? [];
        const next = [...current, entry].slice(-TRAJECTORY_LIMIT);
        trajectoryRef.current[chatId] = next;
        saveTrajectory(chatId, next);
        if (activeRef.current === chatId) setTrajectory(next);
      };

      const apply = (event: TurnEvent) => {
        record(event);
        if (event.type === "chat_title" && event.title && !titleSeen) {
          titleSeen = true;
          setChats((previous) =>
            previous.map((item) => (item.id === chatId ? { ...item, title: event.title! } : item)),
          );
        }
        if (event.type === "approval_request" && event.approvalId) {
          setApprovals((previous) => [
            ...previous.filter((approval) => approval.id !== event.approvalId),
            {
              id: event.approvalId!,
              chatId: event.chatId ?? chatId,
              toolName: event.toolName || "tool",
              callId: event.callId,
              reason: event.reason,
              timeoutSeconds: event.timeoutSeconds,
            },
          ]);
          setStatus("等待人工审批…");
          return;
        }
        if (event.type === "approval_resolved" && event.approvalId) {
          setApprovals((previous) =>
            previous.filter((approval) => approval.id !== event.approvalId),
          );
          if (runningRef.current) setStatus("审批已处理,继续执行…");
          return;
        }
        if (event.type === "end") {
          setApprovals((previous) => previous.filter((approval) => approval.chatId !== chatId));
        }
        if (event.type === "error") {
          failed = true;
          failureText = event.message || "模型请求失败";
        }
        setTurn((previous) =>
          reduceTurn(previous, event, {
            setStatus,
            onTeamPanel: setTeam,
            agents: configRef.current?.workflow?.agents ?? [],
          }),
        );
      };

      try {
        await streamTurn(chatId, text, teamRequested, apply);
      } catch (error) {
        failed = true;
        failureText = error instanceof Error ? error.message : String(error);
        if (error instanceof ApiError && error.status === 409) {
          showToast("上一条消息还在处理中", "error");
        } else {
          showToast(`请求失败:${failureText}`, "error");
        }
      } finally {
        runningRef.current = false;
        setRunning(false);
        setStatus("");
        setApprovals((previous) => previous.filter((approval) => approval.chatId !== chatId));
        try {
          const list = await api.chats();
          setChats(list);
          if (activeRef.current === chatId) {
            const fresh = await api.chat(chatId);
            const nextEntries = fresh.transcript || [];
            const alreadyNoted =
              failureText.length > 0 &&
              nextEntries.some(
                (entry) => entry.role === "system" && entry.text.includes(failureText),
              );
            setEntries(
              failed && !alreadyNoted
                ? [...nextEntries, { role: "system", text: `⚠️ ${failureText}`, ts: Date.now() }]
                : nextEntries,
            );
            setTurn(EMPTY_TURN);
          }
        } catch {
          /* 刷新失败不影响主流程 */
        }
      }
    },
    [showToast],
  );

  const handleSend = useCallback(
    async (text: string, teamRequested: boolean) => {
      if (runningRef.current) {
        showToast("上一条还在处理中");
        return;
      }
      let chatId = activeRef.current;
      if (!chatId) {
        try {
          const chat = await api.createChat();
          chatId = chat.id;
          setChats((previous) => [chat, ...previous]);
          setActiveId(chat.id);
          activeRef.current = chat.id;
          setEntries([]);
          setTurn(EMPTY_TURN);
          setTeam(null);
          setView("chat");
        } catch (error) {
          showToast(`新建会话失败:${error instanceof Error ? error.message : String(error)}`, "error");
          return;
        }
      }
      await sendTurn(chatId, text, teamRequested);
    },
    [sendTurn, showToast],
  );

  const decideApproval = useCallback(
    async (approvalId: string, decision: "approve" | "reject") => {
      try {
        const result = await api.resolveApproval(approvalId, decision);
        setApprovals((previous) => previous.filter((approval) => approval.id !== approvalId));
        if (result.outcome === "allowed-once") {
          showToast("已批准本次工具调用", "success");
        } else if (result.outcome === "rejected") {
          showToast("已拒绝本次工具调用", "success");
        } else {
          showToast(`审批未生效:${result.outcome}`, "error");
        }
      } catch (error) {
        showToast(`审批提交失败:${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
    [showToast],
  );

  const exportChat = useCallback(
    async (chatId: string | null) => {
      if (!chatId) {
        showToast("当前没有可导出的会话");
        return;
      }
      try {
        let transcript = activeRef.current === chatId ? entries : [];
        let title = chatsRef.current.find((chat) => chat.id === chatId)?.title || "会话";
        if (transcript.length === 0) {
          const detail = await api.chat(chatId);
          transcript = detail.transcript || [];
          title = detail.title || title;
        }
        if (transcript.length === 0) {
          showToast("会话还没有内容");
          return;
        }
        const lines = [
          `# ${title}`,
          "",
          `> 工作区:${configRef.current?.workspace || ""}`,
          `> 模型:${configRef.current?.model || ""}`,
          `> 导出时间:${formatDateTime(Date.now())}`,
          "",
        ];
        for (const entry of transcript) {
          if (entry.role === "user") {
            lines.push("## 你", "", entry.text, "");
          } else if (entry.role === "assistant") {
            const agent = agentView(configRef.current?.workflow?.agents ?? [], entry.agent);
            lines.push(`## ${entry.agent ? agent.name : "Agent"}`, "", entry.text, "");
          } else {
            lines.push(`> ${entry.text}`, "");
          }
        }
        downloadText(`${safeFilename(title)}.md`, lines.join("\n"));
        showToast("会话已导出", "success");
      } catch (error) {
        showToast(`导出失败:${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
    [entries, showToast],
  );

  const togglePin = useCallback((chatId: string) => {
    setPinned((previous) =>
      previous.includes(chatId)
        ? previous.filter((id) => id !== chatId)
        : [...previous, chatId],
    );
  }, []);

  const onFeedback = useCallback((key: string, value: FeedbackValue | undefined) => {
    setFeedback((previous) => {
      const next = { ...previous };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  }, []);

  const openSettings = useCallback(() => {
    setPaletteOpen(false);
    setSettingsOpen(true);
  }, []);

  const openPalette = useCallback(() => {
    setSettingsOpen(false);
    setPaletteOpen(true);
  }, []);

  const openApprovals = useCallback(() => {
    setView("chat");
    const pending = approvals[0];
    if (pending?.chatId && pending.chatId !== activeRef.current) {
      if (runningRef.current) showToast("当前会话运行中,审批条会在完成前保持可见");
      else void selectChat(pending.chatId);
    }
  }, [approvals, selectChat, showToast]);

  const startTeamFromView = useCallback(() => {
    setTeamMode(true);
    setView("chat");
    setFocusSignal((value) => value + 1);
    showToast("已切换到团队工作流,描述任务后发送");
  }, [showToast]);

  const messageBlock = [...turn.blocks]
    .reverse()
    .find((block): block is Extract<Block, { kind: "message" }> => block.kind === "message" && Boolean(block.text));
  const latestAnswer =
    messageBlock?.text ||
    [...entries].reverse().find((entry) => entry.role === "assistant" && entry.text)?.text ||
    "";

  const active = chats.find((chat) => chat.id === activeId) ?? null;
  const hasContent =
    entries.length > 0 ||
    turn.blocks.length > 0 ||
    turn.children.length > 0 ||
    (active?.messageCount ?? 0) > 0;
  const isEmpty = view === "chat" && !running && !hasContent;
  const hasChat = Boolean(active);
  const standalone = view !== "chat" && !hasChat;
  const elapsedMs = turn.meta?.startedAt
    ? (turn.meta.endedAt ?? now) - turn.meta.startedAt
    : 0;
  const headerTitle =
    view === "chat"
      ? active?.title || "新会话"
      : active
        ? active.title || "新会话"
        : view === "team"
          ? "团队工作流"
          : "运行轨迹";

  if (!config && !connError) {
    return (
      <div className="boot-screen">
        <BrandLockup size={32} />
        <span className="boot-spinner" />
        <p>正在加载工作台…</p>
      </div>
    );
  }

  if (!config && connError) {
    return (
      <div className="fatal-screen">
        <BrandLockup size={32} />
        <div className="fatal-card">
          <span className="fatal-icon"><IconAlert size={22} /></span>
          <h1>无法连接后端</h1>
          <p>{connError}</p>
          <button type="button" className="primary-btn" onClick={() => void loadAll()}>
            <IconRefresh size={15} />
            重试
          </button>
          <p className="fatal-hint">确认 uvicorn 正在 127.0.0.1:8765 运行</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cx("app-shell", sidebarCollapsed && "is-sidebar-collapsed")}>
      {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />}
      <Sidebar
        chats={chats}
        activeId={activeId}
        runningChatId={running ? activeId : null}
        config={config}
        collapsed={sidebarCollapsed}
        mobileOpen={mobileOpen}
        approvalsCount={approvals.length}
        pinned={pinned}
        running={running}
        theme={theme}
        onSelectChat={(id) => void selectChat(id)}
        onCreateChat={() => void createChat()}
        onDeleteChat={requestDeleteChat}
        onRenameChat={(id, title) => void renameChat(id, title)}
        onTogglePin={togglePin}
        onToggleCollapsed={toggleSidebar}
        onCloseMobile={() => setMobileOpen(false)}
        onOpenSettings={openSettings}
        onOpenTeam={() => {
          setView("team");
          setMobileOpen(false);
        }}
        onOpenTrajectory={() => {
          setView("trajectory");
          setMobileOpen(false);
        }}
        onOpenApprovals={openApprovals}
        onOpenPalette={openPalette}
        onExportChat={(id) => void exportChat(id)}
        onToggleTheme={toggleTheme}
        onStopAll={requestStopAll}
      />

      <main className={cx("main", isEmpty && "is-empty")}>
        <MainHeader
          title={headerTitle}
          empty={isEmpty}
          standalone={standalone}
          hasChat={hasChat}
          view={view}
          running={running}
          status={status}
          elapsedLabel={elapsedMs > 0 ? formatDurationShort(elapsedMs) : ""}
          connected={Boolean(config) && !connError}
          mock={Boolean(config?.mock)}
          teamCount={config?.workflow?.agents.length ?? 0}
          approvalsCount={approvals.length}
          theme={theme}
          onChangeView={setView}
          onOpenSidebar={() => setMobileOpen(true)}
          onNewChat={() => void createChat()}
          onStopAll={requestStopAll}
          onOpenSettings={openSettings}
          onOpenPalette={openPalette}
          onOpenApprovals={openApprovals}
          onExport={() => void exportChat(activeId)}
          onDelete={() => {
            if (activeId) requestDeleteChat(activeId);
          }}
          onToggleTheme={toggleTheme}
          onBack={() => setView("chat")}
        />

        {config?.mock && !mockDismissed && (
          <div className="mock-banner">
            <span className="mock-banner-icon"><IconSparkles size={15} /></span>
            <span>
              Mock 模式:未检测到有效 API Key,当前使用本地剧本回放。
            </span>
            <button type="button" className="mock-banner-link" onClick={openSettings}>
              查看配置
            </button>
            <button
              type="button"
              className="mock-banner-close"
              onClick={() => setMockDismissed(true)}
              aria-label="关闭提示"
            >
              <IconX size={13} />
            </button>
          </div>
        )}

        {approvals.length > 0 && (
          <ApprovalBar approvals={approvals} onDecide={(id, decision) => void decideApproval(id, decision)} />
        )}

        {view === "chat" ? (
          isEmpty ? (
            <div className="empty-layout">
              <Welcome mock={Boolean(config?.mock)} />
              <Composer
                variant="hero"
                disabled={!config}
                running={running}
                team={teamMode}
                workflow={config?.workflow ?? null}
                model={config?.model || "—"}
                provider={config?.provider || "—"}
                streaming={config?.streaming}
                mock={Boolean(config?.mock)}
                workspace={config?.workspace || ""}
                onSubmit={(text, teamRequested) => void handleSend(text, teamRequested)}
                onTeamChange={setTeamMode}
                onStop={requestStopAll}
                onOpenSettings={openSettings}
                onNewChat={() => void createChat()}
                onExport={() => void exportChat(activeId)}
                focusSignal={focusSignal}
              />
            </div>
          ) : (
            <>
              {loadingChat && entries.length === 0 ? (
                <div className="chat-loading">
                  <span className="boot-spinner is-small" />
                  <span>正在加载会话…</span>
                </div>
              ) : (
                <Conversation
                  entries={entries}
                  blocks={turn.blocks}
                  childGroups={turn.children}
                  agents={config?.workflow?.agents ?? []}
                  running={running}
                  status={status}
                  meta={turn.meta}
                  elapsedMs={elapsedMs}
                  feedback={feedback}
                  onFeedback={onFeedback}
                  onNotify={showToast}
                  onExport={() => void exportChat(activeId)}
                />
              )}
              <Composer
                variant="dock"
                disabled={!config}
                running={running}
                team={teamMode}
                workflow={config?.workflow ?? null}
                model={config?.model || "—"}
                provider={config?.provider || "—"}
                streaming={config?.streaming}
                mock={Boolean(config?.mock)}
                workspace={config?.workspace || ""}
                onSubmit={(text, teamRequested) => void handleSend(text, teamRequested)}
                onTeamChange={setTeamMode}
                onStop={requestStopAll}
                onOpenSettings={openSettings}
                onNewChat={() => void createChat()}
                onExport={() => void exportChat(activeId)}
                focusSignal={focusSignal}
              />
            </>
          )
        ) : view === "team" ? (
          <TeamView
            data={team}
            workflow={config?.workflow ?? null}
            running={running}
            answer={latestAnswer}
            onStartTeam={startTeamFromView}
          />
        ) : (
          <TrajectoryView
            events={trajectory}
            agents={config?.workflow?.agents ?? []}
            running={running}
          />
        )}
      </main>

      <SettingsDialog
        open={settingsOpen}
        config={config}
        themeMode={themeMode}
        sidebarCollapsed={sidebarCollapsed}
        running={running}
        onClose={() => setSettingsOpen(false)}
        onThemeMode={setThemeMode}
        onSidebarCollapsed={updateSidebarCollapsed}
        onStopAll={requestStopAll}
        onNotify={showToast}
      />

      <CommandPalette
        open={paletteOpen}
        running={running}
        hasChat={hasChat}
        theme={theme}
        onClose={() => setPaletteOpen(false)}
        onNewChat={() => void createChat()}
        onOpenSettings={openSettings}
        onToggleTheme={toggleTheme}
        onOpenChat={() => setView("chat")}
        onOpenTeam={() => setView("team")}
        onOpenTrajectory={() => setView("trajectory")}
        onStopAll={requestStopAll}
        onExport={() => void exportChat(activeId)}
        onToggleSidebar={toggleSidebar}
      />

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title ?? ""}
        message={confirm?.message ?? ""}
        confirmLabel={confirm?.confirmLabel}
        danger={confirm?.danger}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === "delete" && confirm.chatId) {
            void performDeleteChat(confirm.chatId);
          } else {
            void performStopAll();
          }
        }}
      />

      <Toast toast={notice} onClose={() => setNotice(null)} />
    </div>
  );
}
