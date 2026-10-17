import { useEffect, useRef, type MouseEvent } from "react";
import { renderMarkdown } from "../lib/markdown";
import type { Block, ChildGroup, TranscriptEntry } from "../types";

const AGENT_ICON = { coder: "👨‍💻", reviewer: "🔍" } as const;
const AGENT_NAME = { coder: "Coder", reviewer: "Reviewer" } as const;

function phaseLabel(b: Extract<Block, { kind: "phase" }>): string {  const who = `${b.agent === "coder" ? "👨‍💻 Coder" : "🔍 Reviewer"}`;
  const stage =
    b.stage === "start" ? "开始编码" : b.stage === "fix" ? `第 ${b.round} 轮修复` : "审查中";
  return `${who} · ${stage}`;
}

function ToolRow({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const open = block.result?.isError ?? false;
  const running = block.result === undefined;
  return (
    <details className="tool-row" open={open}>
      <summary className="tool-head">
        <span className="tool-icon">{(block.name || "tool").slice(0, 3)}</span>
        <span className="tool-name">{block.name}</span>
        <span className="tool-args">{block.detail || ""}</span>
        <span className={`tool-state${running ? " run" : ""}`}>
          {block.agent && <span>{AGENT_ICON[block.agent]}</span>}
          {running ? (
            <><span className="mini-spin" />运行中</>
          ) : block.result?.isError ? (
            <span className="st-err">⚠️ 失败</span>
          ) : (
            <span className="st-ok">✓</span>
          )}
        </span>
      </summary>
      <div className="tool-body">
        {block.detail && (
          <div className="tool-args-pane">
            <span className="lab">arguments</span>
            <pre><code>{block.detail}</code></pre>
          </div>
        )}
        {block.result && (
          <div className="tool-out">
            <span className="lab">output</span>
            <pre className={block.result.isError ? "is-err" : ""}>{block.result.text || "(无输出)"}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

function Md({ text, className }: { text: string; className?: string }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

interface FlowProps {
  entries: TranscriptEntry[];
  blocks: Block[];
  childGroups: ChildGroup[];
  running: boolean;
  emptyHint: string;
}

export function Flow({ entries, blocks, childGroups, running, emptyHint }: FlowProps) {
  const flowRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    const el = flowRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  });

  const idle = entries.length === 0 && blocks.length === 0 && childGroups.length === 0 && !running;

  const onClick = (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest?.("button.code-copy");
    if (!btn) return;
    const code = btn.parentElement?.nextElementSibling?.querySelector?.("code");
    const text = code?.textContent ?? "";
    void navigator.clipboard?.writeText(text).then(() => {
      btn.textContent = "已复制";
      setTimeout(() => { btn.textContent = "复制"; }, 1200);
    });
  };

  return (
    <div className="flow" ref={flowRef} onScroll={(e) => {
      const el = e.currentTarget;
      followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    }} onClickCapture={onClick}>
      <div className="flow-inner">
        {idle && (
          <div className="flow-welcome">
            <div className="wl-logo">A</div>
            <h1>AgentBox</h1>
            <p>{emptyHint}</p>
          </div>
        )}

        {entries.map((entry, i) => {
          if (entry.role === "user") {
            return (
              <div className="bubble-user" key={`e${i}`}>
                <div className="user-card">{entry.text}</div>
              </div>
            );
          }
          if (entry.role === "system") return <Md key={`e${i}`} className="note md" text={entry.text} />;
          if (entry.agent) {
            return (
              <div className={`agent-row ${entry.agent}`} key={`e${i}`}>
                <div className="avatar">{AGENT_ICON[entry.agent]}</div>
                <div className="agent-body">
                  <div className="agent-tag">{AGENT_NAME[entry.agent]}</div>
                  <Md className="assistant-text md" text={entry.text} />
                </div>
              </div>
            );
          }
          return <Md key={`e${i}`} className="assistant-text md" text={entry.text} />;
        })}

        {blocks.map((b, i) => {
          switch (b.kind) {
            case "user":
              return <div className="bubble-user" key={`b${i}`}><div className="user-card">{b.text}</div></div>;
            case "message":
              return b.agent ? (
                <div className={`agent-row ${b.agent}`} key={`b${i}`}>
                  <div className="avatar">{AGENT_ICON[b.agent]}</div>
                  <div className="agent-body">
                    <div className="agent-tag">{AGENT_NAME[b.agent]}</div>
                    <Md className="assistant-text md" text={b.text || ""} />
                    {i === blocks.length - 1 && running && <span className="caret" />}
                  </div>
                </div>
              ) : (
                <div key={`b${i}`}>
                  <Md className="assistant-text md" text={b.text || ""} />
                  {i === blocks.length - 1 && running && <span className="caret" />}
                </div>
              );
            case "reasoning":
              return (
                <details className="reasoning" key={`b${i}`}>
                  <summary>{b.scope === "child" && "🤖 "}{b.agent ? AGENT_NAME[b.agent] + " " : ""}💭 推理过程</summary>
                  <div className="reasoning-body">{b.text}</div>
                </details>
              );
            case "tool":
              return <ToolRow key={`b${i}`} block={b} />;
            case "phase":
              return (
                <div className="phase" key={`b${i}`}>
                  <span className="em">🧩</span>{phaseLabel(b)}
                  <span className="bar" />
                </div>
              );
            case "verdict":
              return (
                <div className={`verdict ${b.verdict === "APPROVE" ? "approve" : "reject"}`} key={`b${i}`}>
                  {b.verdict === "APPROVE" ? "✅ Reviewer 通过" : `🔁 Reviewer 打回(第 ${b.round} 轮)`}
                </div>
              );
            case "error":
              return <div className="err-box" key={`b${i}`}>⚠️ {b.text}</div>;
            case "note":
              return <div className="note" key={`b${i}`}>{b.text}</div>;
            default:
              return null;
          }
        })}

        {childGroups.map((child) => (
          <details className="child-group" key={child.childId} open={child.open}>
            <summary className="child-head">
              🤖 子代理 {child.childId.slice(0, 8)} · {child.status || "运行中"}
            </summary>
            {child.lines.map((line, i) => (
              <div key={i} className={`child-line ${line.kind}`}>
                {line.kind === "tool" ? (
                  line.result
                    ? `${line.callId ?? "tool"} → ${line.result.isError ? "✖" : "✓"} ${line.text}`
                    : `▸ ${line.text}`
                ) : (
                  line.text
                )}
              </div>
            ))}
          </details>
        ))}
      </div>
    </div>
  );
}
