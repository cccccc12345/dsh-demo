/** 与 agent_platform/web 的 API 契约一一对应 */

export interface AgentSpecInfo {
  id: string;
  name: string;
  emoji: string;
  role: string;
  writes: boolean;
}

export interface WorkflowInfo {
  id: string;
  name: string;
  description: string;
  maxRounds: number;
  agents: AgentSpecInfo[];
}

export interface AgentRoster {
  defaultAgent: AgentSpecInfo;
  orchestrator: AgentSpecInfo;
  workflow: WorkflowInfo;
  counts: {
    modelAgents: number;
    teamAgents: number;
    orchestrators: number;
  };
}

export interface ConfigInfo {
  mock: boolean;
  startupError: string | null;
  model: string;
  provider: string;
  workspace: string;
  workflow?: WorkflowInfo;
  runtimeAlive?: boolean;
  streaming?: boolean;
}

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  messageCount: number;
}

export interface ChatDetail extends ChatSummary {
  transcript: TranscriptEntry[];
}

export interface TranscriptEntry {
  role: "user" | "assistant" | "system";
  text: string;
  ts: number;
  agent?: "coder" | "reviewer";
}

/** 后端 SSE 事件词汇表(见 translate_notification + mock 剧本) */
export interface TurnEvent {
  type:
    | "user_echo"
    | "turn_start"
    | "step_start"
    | "step_end"
    | "turn_end"
    | "chat_title"
    | "tool_call"
    | "tool_result"
    | "assistant_stream_start"
    | "assistant_delta"
    | "assistant_stream_end"
    | "usage"
    | "message"
    | "reasoning"
    | "error"
    | "phase"
    | "verdict"
    | "agent_spawn"
    | "agent_done"
    | "end";
  turn?: number;
  step?: number;
  callId?: string;
  name?: string;
  detail?: string;
  text?: string;
  streamId?: string;
  reasoning?: string;
  title?: string;
  isError?: boolean;
  agent?: "coder" | "reviewer";
  scope?: "child";
  child?: string;
  status?: string;
  stop?: string;
  summary?: string;
  stage?: "start" | "fix" | "review";
  round?: number;
  verdict?: "APPROVE" | "NEEDS_CHANGES";
  response?: string;
  finish_reason?: string;
  reason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    reasoningTokens?: number;
  };
  message?: string;
}

export interface TrajectoryEvent extends TurnEvent {
  /** 客户端收到事件的时间(毫秒) */
  ts: number;
}

/** Agent 角色标签 */
export type AgentName = "coder" | "reviewer";

/** 流式界面里的一个内容块(判别联合,渲染时按 kind 收窄) */
interface BlockBase {
  agent?: AgentName;
  scope?: "child";
  streamId?: string;
}

interface UserBlock extends BlockBase {
  kind: "user";
  text?: string;
}
interface MessageBlock extends BlockBase {
  kind: "message";
  text?: string;
}
interface ReasoningBlock extends BlockBase {
  kind: "reasoning";
  text: string;
}
interface ToolBlock extends BlockBase {
  kind: "tool";
  callId?: string;
  name?: string;
  detail?: string;
  result?: { text: string; isError: boolean };
}
interface PhaseBlock extends BlockBase {
  kind: "phase";
  stage?: string;
  round?: number;
}
interface VerdictBlock extends BlockBase {
  kind: "verdict";
  verdict?: string;
  round?: number;
}
interface ErrorBlock extends BlockBase {
  kind: "error";
  text: string;
}
interface NoteBlock extends BlockBase {
  kind: "note";
  text: string;
}

export type Block =
  | UserBlock
  | MessageBlock
  | ReasoningBlock
  | ToolBlock
  | PhaseBlock
  | VerdictBlock
  | ErrorBlock
  | NoteBlock;

export interface ChildLine {
  kind: "reasoning" | "message" | "tool";
  text: string;
  callId?: string;
  result?: { text: string; isError: boolean };
}

export interface ChildGroup {
  childId: string;
  lines: ChildLine[];
  status?: string;
  open: boolean;
}

/** 团队面板数据(由 phase / verdict / agent 消息驱动) */
export interface TeamPanel {
  coderStage?: string;
  coderRound?: number;
  reviewerStage?: string;
  reviewerRound?: number;
  coderText?: string;
  reviewerText?: string;
  timeline: { verdict: string; round: number }[];
}
