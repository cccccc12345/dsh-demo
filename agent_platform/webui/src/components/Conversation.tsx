import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type {
  AgentSpecInfo,
  Block,
  ChildGroup,
  FeedbackValue,
  TranscriptEntry,
  TurnMeta,
  UsageInfo,
} from "../types";
import { Markdown } from "./Markdown";
import {
  clampText,
  copyText,
  cx,
  formatDateTime,
  formatDuration,
  formatTokens,
} from "../lib/ui";
import {
  IconAlert,
  IconBot,
  IconCheck,
  IconCheckCircle,
  IconChevronDown,
  IconCopy,
  IconCpu,
  IconDownload,
  IconFilePen,
  IconFileText,
  IconFolder,
  IconGlobe,
  IconLoader,
  IconSparkles,
  IconSquare,
  IconTerminal,
  IconThumbsDown,
  IconThumbsUp,
  IconWorkflow,
} from "./Icons";

type Notify = (text: string, kind?: "info" | "success" | "error") => void;

interface ConversationProps {
  entries: TranscriptEntry[];
  blocks: Block[];
  childGroups: ChildGroup[];
  agents: AgentSpecInfo[];
  running: boolean;
  status: string;
  meta: TurnMeta | null;
  elapsedMs: number;
  feedback: Record<string, FeedbackValue>;
  onFeedback: (key: string, value: FeedbackValue | undefined) => void;
  onNotify: Notify;
  onExport: () => void;
}

function agentView(agents: AgentSpecInfo[], id?: string) {
  const found = id ? agents.find((agent) => agent.id === id) : undefined;
  return {
    id: id ?? "",
    emoji: found?.emoji ?? "🤖",
    name: found?.name ?? id ?? "Agent",
    role: found?.role ?? "",
  };
}

function AgentChip({ agent }: { agent: ReturnType<typeof agentView> }) {
  return (
    <div className="agent-chip" title={agent.role}>
      <span className="agent-chip-avatar">{agent.emoji}</span>
      <span className="agent-chip-name">{agent.name}</span>
    </div>
  );
}

function usageTotal(usage?: UsageInfo): number {
  if (!usage) return 0;
  return usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

function usageCache(usage?: UsageInfo): string {
  const total = usageTotal(usage);
  const cached = usage?.cacheReadTokens ?? 0;
  if (total <= 0 || cached <= 0) return "";
  return `${Math.round((cached / total) * 100)}%`;
}

function parseObject(text?: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toolMeta(name?: string): { label: string; icon: ReactNode } {
  const n = (name || "tool").toLowerCase();
  if (/bash|shell|terminal|exec|command/.test(n)) return { label: "运行命令", icon: <IconTerminal size={15} /> };
  if (/read|cat|view_file|open_file/.test(n)) return { label: "读取文件", icon: <IconFileText size={15} /> };
  if (/write|create_file|save/.test(n)) return { label: "写入文件", icon: <IconFilePen size={15} /> };
  if (/edit|patch|replace/.test(n)) return { label: "编辑文件", icon: <IconFilePen size={15} /> };
  if (/glob|ls\b|list_dir|browse|folder/.test(n)) return { label: "浏览文件", icon: <IconFolder size={15} /> };
  if (/grep|search|rg\b/.test(n)) return { label: "搜索内容", icon: <IconFileText size={15} /> };
  if (/web_search|search_web/.test(n)) return { label: "搜索网络", icon: <IconGlobe size={15} /> };
  if (/fetch|http|browser/.test(n)) return { label: "读取网页", icon: <IconGlobe size={15} /> };
  if (/subagent|agent/.test(n)) return { label: "调用子代理", icon: <IconBot size={15} /> };
  if (/workflow/.test(n)) return { label: "运行工作流", icon: <IconWorkflow size={15} /> };
  return { label: name || "工具", icon: <IconSparkles size={15} /> };
}

function toolSummary(name: string | undefined, detail: string | undefined): string {
  const obj = parseObject(detail);
  if (obj) {
    for (const key of [
      "command",
      "cmd",
      "path",
      "file_path",
      "filePath",
      "query",
      "url",
      "pattern",
      "description",
      "prompt",
      "task",
    ]) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) return clampText(value, 90);
      if (Array.isArray(value)) return clampText(value.map(String).join(" "), 90);
    }
  }
  return clampText(detail || "", 90);
}

function prettyArguments(detail?: string): string {
  const obj = parseObject(detail);
  if (obj) return JSON.stringify(obj, null, 2);
  return detail || "";
}

function SummaryButton({
  tone,
  label,
  time,
  collapsed,
  status,
  onToggle,
}: {
  tone: "running" | "done" | "stopped" | "error";
  label: string;
  time?: string;
  collapsed: boolean;
  status?: string;
  onToggle: () => void;
}) {
  const icon =
    tone === "running" ? (
      <IconLoader size={14} className="spin" />
    ) : tone === "error" ? (
      <IconAlert size={14} />
    ) : tone === "stopped" ? (
      <IconSquare size={13} />
    ) : (
      <IconCheckCircle size={14} />
    );
  return (
    <button
      type="button"
      className={cx("turn-summary", `is-${tone}`)}
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={status || undefined}
    >
      <span className="summary-icon">{icon}</span>
      <span className="summary-label">{label}</span>
      {time && <span className="summary-time">{time}</span>}
      <IconChevronDown
        size={14}
        className={cx("summary-chevron", collapsed && "is-collapsed")}
      />
    </button>
  );
}

function MessageActions({
  text,
  ts,
  usage,
  feedback,
  feedbackKey,
  onFeedback,
  onNotify,
  onExport,
}: {
  text: string;
  ts: number;
  usage?: UsageInfo;
  feedback?: FeedbackValue;
  feedbackKey: string;
  onFeedback: (key: string, value: FeedbackValue | undefined) => void;
  onNotify: Notify;
  onExport: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const total = usageTotal(usage);
  const cache = usageCache(usage);

  const handleCopy = async () => {
    const ok = await copyText(text);
    if (!ok) {
      onNotify("复制失败", "error");
      return;
    }
    setCopied(true);
    onNotify("已复制回复", "success");
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="msg-actions">
      <button type="button" className="msg-action" onClick={handleCopy} title="复制回复" aria-label="复制回复">
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </button>
      <button
        type="button"
        className={cx("msg-action", feedback === "up" && "is-active")}
        title="有帮助"
        aria-label="有帮助"
        aria-pressed={feedback === "up"}
        onClick={() => onFeedback(feedbackKey, feedback === "up" ? undefined : "up")}
      >
        <IconThumbsUp size={14} />
      </button>
      <button
        type="button"
        className={cx("msg-action", feedback === "down" && "is-active")}
        title="需要改进"
        aria-label="需要改进"
        aria-pressed={feedback === "down"}
        onClick={() => onFeedback(feedbackKey, feedback === "down" ? undefined : "down")}
      >
        <IconThumbsDown size={14} />
      </button>
      <button type="button" className="msg-action" onClick={onExport} title="导出会话" aria-label="导出会话">
        <IconDownload size={14} />
      </button>
      {total > 0 && (
        <span className="msg-meta" title={cache ? `缓存命中 ${cache}` : undefined}>
          <IconCpu size={12} /> 用量 {formatTokens(total)} tok
          {cache && <span className="msg-cache"> · 缓存 {cache}</span>}
        </span>
      )}
      {ts > 0 && <span className="msg-time">{formatDateTime(ts)}</span>}
    </div>
  );
}

function UserMessage({
  text,
  ts,
  onNotify,
}: {
  text: string;
  ts: number;
  onNotify: Notify;
}) {
  const handleCopy = async () => {
    const ok = await copyText(text);
    onNotify(ok ? "已复制消息" : "复制失败", ok ? "success" : "error");
  };
  return (
    <div className="user-row">
      <div className="user-stack">
        <div className="user-bubble">{text}</div>
        <div className="user-meta">
          {ts > 0 && <span>{formatDateTime(ts)}</span>}
          <button type="button" onClick={handleCopy} title="复制消息" aria-label="复制消息">
            <IconCopy size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ReasoningRow({ text }: { text: string }) {
  return (
    <details className="reasoning-block">
      <summary>
        <IconSparkles size={14} />
        <span>思考过程</span>
        <IconChevronDown size={13} className="reasoning-chevron" />
      </summary>
      <div className="reasoning-body">{text}</div>
    </details>
  );
}

function ToolCard({
  block,
  onNotify,
}: {
  block: Extract<Block, { kind: "tool" }>;
  onNotify: Notify;
}) {
  const [open, setOpen] = useState(Boolean(block.result?.isError));
  const running = block.result === undefined;
  const meta = toolMeta(block.name);
  const summary = toolSummary(block.name, block.detail);

  useEffect(() => {
    if (block.result?.isError) setOpen(true);
  }, [block.result?.isError]);

  const copyOutput = async () => {
    const ok = await copyText(block.result?.text || "");
    onNotify(ok ? "已复制工具输出" : "复制失败", ok ? "success" : "error");
  };

  return (
    <div className={cx("tool-card", open && "is-open", block.result?.isError && "is-error")}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="tool-glyph">{meta.icon}</span>
        <span className="tool-title">{meta.label}</span>
        {summary && <span className="tool-detail">{summary}</span>}
        <span className={cx("tool-state", running && "is-running", block.result?.isError && "is-error")}>
          {running ? (
            <>
              <IconLoader size={12} className="spin" /> 运行中
            </>
          ) : block.result?.isError ? (
            <>
              <IconAlert size={12} /> 失败
            </>
          ) : (
            <>
              <IconCheck size={12} /> 完成
            </>
          )}
        </span>
        <IconChevronDown size={14} className={cx("tool-chevron", open && "is-open")} />
      </button>
      {open && (
        <div className="tool-body">
          {block.detail && (
            <div className="tool-section">
              <div className="tool-section-head">
                <span>参数</span>
                <button
                  type="button"
                  onClick={() => {
                    void copyText(block.detail || "").then((ok) =>
                      onNotify(ok ? "已复制参数" : "复制失败", ok ? "success" : "error"),
                    );
                  }}
                  title="复制参数"
                >
                  <IconCopy size={12} />
                </button>
              </div>
              <pre>{prettyArguments(block.detail)}</pre>
            </div>
          )}
          {block.result && (
            <div className="tool-section">
              <div className="tool-section-head">
                <span>输出</span>
                <button type="button" onClick={copyOutput} title="复制输出">
                  <IconCopy size={12} />
                </button>
              </div>
              <pre className={block.result.isError ? "is-error" : ""}>
                {block.result.text || "(无输出)"}
              </pre>
            </div>
          )}
          {running && !block.result && <div className="tool-waiting">等待工具返回…</div>}
        </div>
      )}
    </div>
  );
}

function PhaseRow({
  block,
  agents,
}: {
  block: Extract<Block, { kind: "phase" }>;
  agents: AgentSpecInfo[];
}) {
  const agent = agentView(agents, block.agent);
  const stage =
    block.stage === "start"
      ? "开始"
      : block.stage === "fix"
        ? `第 ${block.round ?? 0} 轮修复`
        : block.stage === "review"
          ? "审查中"
          : block.stage === "done"
            ? "已完成"
            : "处理中";
  return (
    <div className="phase-row">
      <span className="phase-avatar">{agent.emoji}</span>
      <span className="phase-name">{agent.name}</span>
      <span className="phase-stage">{stage}</span>
      <span className="phase-line" />
    </div>
  );
}

function VerdictChip({ block }: { block: Extract<Block, { kind: "verdict" }> }) {
  const ok = block.verdict === "APPROVE";
  return (
    <div className={cx("verdict-chip", ok ? "is-ok" : "is-bad")}>
      {ok ? <IconCheck size={14} /> : <IconAlert size={14} />}
      {ok ? "Reviewer 通过" : `Reviewer 打回 · 第 ${block.round ?? 0} 轮`}
    </div>
  );
}

function ChildCard({ child }: { child: ChildGroup }) {
  return (
    <details className="child-card" open={child.open}>
      <summary>
        <IconBot size={15} />
        <span>子代理</span>
        <code>{child.childId.slice(0, 8) || "child"}</code>
        <span className="child-status">{child.status || "运行中"}</span>
        <IconChevronDown size={14} className="child-chevron" />
      </summary>
      <div className="child-body">
        {child.lines.length === 0 && <div className="child-empty">等待子代理输出…</div>}
        {child.lines.map((line, index) => {
          if (line.kind === "tool") {
            return (
              <div className="child-line is-tool" key={index}>
                <IconTerminal size={13} />
                <span className="child-line-text">{line.text}</span>
                {line.result && (
                  <span className={cx("child-result", line.result.isError && "is-error")}>
                    {line.result.isError ? "失败" : "完成"}
                  </span>
                )}
              </div>
            );
          }
          if (line.kind === "reasoning") {
            return (
              <div className="child-line is-reasoning" key={index}>
                <IconSparkles size={13} />
                <span className="child-line-text">{line.text}</span>
              </div>
            );
          }
          return (
            <div className="child-line" key={index}>
              <span className="child-line-text">{line.text}</span>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function NoteRow({ text }: { text: string }) {
  const tone = text.startsWith("⚠️")
    ? " is-error"
    : text.includes("已停止")
      ? " is-warn"
      : "";
  return <div className={`note-row${tone}`}>{text}</div>;
}

interface HistoryUserItem {
  kind: "user";
  key: string;
  entry: TranscriptEntry;
}
interface HistoryAssistantItem {
  kind: "assistant";
  key: string;
  entries: TranscriptEntry[];
}
interface HistorySystemItem {
  kind: "system";
  key: string;
  entry: TranscriptEntry;
}
type HistoryItem = HistoryUserItem | HistoryAssistantItem | HistorySystemItem;

function groupHistory(entries: TranscriptEntry[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  let currentAssistant: HistoryAssistantItem | null = null;
  entries.forEach((entry, index) => {
    if (entry.role === "user") {
      currentAssistant = null;
      items.push({ kind: "user", key: `u${index}`, entry });
    } else if (entry.role === "assistant") {
      if (!currentAssistant) {
        currentAssistant = { kind: "assistant", key: `a${index}`, entries: [] };
        items.push(currentAssistant);
      }
      currentAssistant.entries.push(entry);
    } else {
      currentAssistant = null;
      items.push({ kind: "system", key: `s${index}`, entry });
    }
  });
  return items;
}

function AssistantGroup({
  item,
  agents,
  feedback,
  onFeedback,
  onNotify,
  onExport,
}: {
  item: HistoryAssistantItem;
  agents: AgentSpecInfo[];
  feedback: Record<string, FeedbackValue>;
  onFeedback: (key: string, value: FeedbackValue | undefined) => void;
  onNotify: Notify;
  onExport: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const text = item.entries.map((entry) => entry.text).filter(Boolean).join("\n\n");
  const last = item.entries[item.entries.length - 1];

  return (
    <div className="assistant-turn">
      <SummaryButton
        tone="done"
        label="已完成"
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
      />
      {!collapsed && (
        <div className="assistant-content">
          {item.entries.map((entry, index) => (
            <div className="assistant-entry" key={index}>
              {entry.agent && <AgentChip agent={agentView(agents, entry.agent)} />}
              <Markdown text={entry.text} className="assistant-text" />
            </div>
          ))}
        </div>
      )}
      <MessageActions
        text={text}
        ts={last?.ts ?? 0}
        feedback={feedback[item.key]}
        feedbackKey={item.key}
        onFeedback={onFeedback}
        onNotify={onNotify}
        onExport={onExport}
      />
    </div>
  );
}

function StreamGroup({
  blocks,
  childGroups,
  agents,
  running,
  status,
  meta,
  elapsedMs,
  feedback,
  onFeedback,
  onNotify,
  onExport,
}: {
  blocks: Block[];
  childGroups: ChildGroup[];
  agents: AgentSpecInfo[];
  running: boolean;
  status: string;
  meta: TurnMeta | null;
  elapsedMs: number;
  feedback: Record<string, FeedbackValue>;
  onFeedback: (key: string, value: FeedbackValue | undefined) => void;
  onNotify: Notify;
  onExport: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const content = blocks.filter((block) => block.kind !== "user");
  const text = content
    .filter((block): block is Extract<Block, { kind: "message" }> => block.kind === "message")
    .map((block) => block.text || "")
    .filter(Boolean)
    .join("\n\n");
  const failed = Boolean(meta?.failed) || content.some((block) => block.kind === "error");
  const tone: "running" | "done" | "stopped" | "error" = running
    ? "running"
    : meta?.finishReason === "stopped"
      ? "stopped"
      : failed
        ? "error"
        : "done";
  const durationMs = meta?.startedAt
    ? (meta.endedAt ?? Date.now()) - meta.startedAt
    : elapsedMs;
  const label =
    tone === "running"
      ? "正在生成"
      : tone === "stopped"
        ? "已停止"
        : tone === "error"
          ? "执行失败"
          : "已完成";
  const time = durationMs > 0 ? `用时 ${formatDuration(durationMs)}` : "";
  const hasVisible = content.length > 0 || childGroups.length > 0;

  return (
    <div className="assistant-turn is-stream">
      <SummaryButton
        tone={tone}
        label={label}
        time={time}
        status={status}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
      />
      {!collapsed && (
        <div className="assistant-content">
          {!hasVisible && running && (
            <div className="thinking-row">
              <span className="thinking-dots"><i /><i /><i /></span>
              <span>正在思考…</span>
            </div>
          )}
          {content.map((block, index) => {
            switch (block.kind) {
              case "message": {
                const isLast = index === content.length - 1;
                return (
                  <div className="assistant-entry" key={`m${index}`}>
                    {block.agent && <AgentChip agent={agentView(agents, block.agent)} />}
                    <Markdown text={block.text || ""} className="assistant-text" />
                    {running && isLast && <span className="caret" />}
                  </div>
                );
              }
              case "reasoning":
                return <ReasoningRow key={`r${index}`} text={block.text} />;
              case "tool":
                return <ToolCard key={`t${index}`} block={block} onNotify={onNotify} />;
              case "phase":
                return <PhaseRow key={`p${index}`} block={block} agents={agents} />;
              case "verdict":
                return <VerdictChip key={`v${index}`} block={block} />;
              case "error":
                return (
                  <div className="error-card" key={`e${index}`}>
                    <IconAlert size={16} />
                    <span>{block.text}</span>
                  </div>
                );
              case "note":
                return <NoteRow key={`n${index}`} text={block.text} />;
              default:
                return null;
            }
          })}
          {childGroups.map((child) => (
            <ChildCard key={child.childId} child={child} />
          ))}
        </div>
      )}
      {!running && text && (
        <MessageActions
          text={text}
          ts={meta?.endedAt ?? Date.now()}
          usage={meta?.usage}
          feedback={feedback.stream}
          feedbackKey="stream"
          onFeedback={onFeedback}
          onNotify={onNotify}
          onExport={onExport}
        />
      )}
    </div>
  );
}

export function Conversation(props: ConversationProps) {
  const {
    entries,
    blocks,
    childGroups,
    agents,
    running,
    status,
    meta,
    elapsedMs,
    feedback,
    onFeedback,
    onNotify,
    onExport,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const prevRunningRef = useRef(running);
  const [showJump, setShowJump] = useState(false);
  const history = useMemo(() => groupHistory(entries), [entries]);
  const userBlocks = blocks.filter((block): block is Extract<Block, { kind: "user" }> => block.kind === "user");
  const hasStream = blocks.length > 0 || childGroups.length > 0 || running;

  useEffect(() => {
    if (running && !prevRunningRef.current) followRef.current = true;
    prevRunningRef.current = running;
  }, [running]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    const frame = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [entries, blocks, childGroups, running]);

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = true;
    setShowJump(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    followRef.current = distance < 80;
    setShowJump((previous) => {
      const next = distance > 160;
      return previous === next ? previous : next;
    });
  };

  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>("[data-copy],[data-wrap]");
    if (!action) return;
    const card = action.closest(".code-card");
    if (action.hasAttribute("data-wrap")) {
      card?.classList.toggle("is-wrapped");
      action.classList.toggle("is-on");
      return;
    }
    const code = card?.querySelector("pre code");
    const text = code?.textContent ?? "";
    void copyText(text).then((ok) => onNotify(ok ? "已复制代码" : "复制失败", ok ? "success" : "error"));
  };

  const turnTs = meta?.startedAt ?? 0;

  return (
    <div className="conversation-wrap">
      <div className="conversation-scroll" ref={scrollRef} onScroll={onScroll} onClickCapture={onClickCapture}>
        <div className="conversation">
          {history.map((item) => {
            if (item.kind === "user") {
              return <UserMessage key={item.key} text={item.entry.text} ts={item.entry.ts} onNotify={onNotify} />;
            }
            if (item.kind === "system") {
              return <NoteRow key={item.key} text={item.entry.text} />;
            }
            return (
              <AssistantGroup
                key={item.key}
                item={item}
                agents={agents}
                feedback={feedback}
                onFeedback={onFeedback}
                onNotify={onNotify}
                onExport={onExport}
              />
            );
          })}

          {userBlocks.map((block, index) => (
            <UserMessage
              key={`stream-user-${index}`}
              text={block.text || ""}
              ts={turnTs}
              onNotify={onNotify}
            />
          ))}

          {hasStream && (
            <StreamGroup
              blocks={blocks}
              childGroups={childGroups}
              agents={agents}
              running={running}
              status={status}
              meta={meta}
              elapsedMs={elapsedMs}
              feedback={feedback}
              onFeedback={onFeedback}
              onNotify={onNotify}
              onExport={onExport}
            />
          )}
        </div>
      </div>
      {showJump && (
        <button type="button" className="jump-btn" onClick={jumpToBottom} title="回到最新" aria-label="回到最新">
          <IconChevronDown size={17} />
        </button>
      )}
    </div>
  );
}
