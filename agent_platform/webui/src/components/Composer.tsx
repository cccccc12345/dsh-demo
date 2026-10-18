import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { WorkflowInfo } from "../types";
import { basename, cx } from "../lib/ui";
import {
  IconArrowUp,
  IconChevronDown,
  IconCommand,
  IconCornerDownLeft,
  IconCpu,
  IconDownload,
  IconFolder,
  IconPlus,
  IconSettings,
  IconSlash,
  IconSparkles,
  IconSquare,
  IconWorkflow,
} from "./Icons";
import { Menu, type MenuItem } from "./Menu";

export type ComposerVariant = "hero" | "dock";

export interface ComposerProps {
  variant: ComposerVariant;
  disabled: boolean;
  running: boolean;
  team: boolean;
  workflow: WorkflowInfo | null;
  model: string;
  provider: string;
  streaming?: boolean;
  mock: boolean;
  workspace: string;
  onSubmit: (text: string, team: boolean) => void;
  onTeamChange: (team: boolean) => void;
  onStop: () => void;
  onOpenSettings: () => void;
  onNewChat: () => void;
  onExport: () => void;
  focusSignal?: number;
}

interface SlashCommand {
  id: string;
  label: string;
  description: string;
  template?: string;
  teamMode?: boolean;
  clear?: boolean;
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "team",
    label: "团队工作流",
    description: "切换到多角色流水线,再描述任务",
    teamMode: true,
  },
  {
    id: "review",
    label: "代码审查",
    description: "审查改动,指出风险与改进点",
    template: "请审查以下改动,按严重程度列出风险、缺陷与改进建议:\n",
  },
  {
    id: "test",
    label: "生成测试",
    description: "补充测试用例,覆盖边界与异常",
    template: "请为以下模块补充测试用例,覆盖正常路径、边界条件和异常分支:\n",
  },
  {
    id: "explain",
    label: "解释代码",
    description: "说明执行流程与关键设计",
    template: "请解释以下代码的执行流程、关键设计和潜在问题:\n",
  },
  {
    id: "clear",
    label: "清空输入",
    description: "清空当前输入框",
    clear: true,
  },
];

const SUGGESTIONS = [
  "用团队工作流生成测试用例",
  "解释这个项目的结构",
  "审查当前改动",
];

export function Composer(props: ComposerProps) {
  const {
    variant,
    disabled,
    running,
    team,
    workflow,
    model,
    provider,
    streaming,
    mock,
    workspace,
    onSubmit,
    onTeamChange,
    onStop,
    onOpenSettings,
    onNewChat,
    onExport,
    focusSignal = 0,
  } = props;

  const [text, setText] = useState("");
  const [menu, setMenu] = useState<"mode" | "plus" | "model" | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = variant === "hero" ? 200 : 240;
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 24), max)}px`;
  }, [text, variant]);

  useEffect(() => {
    if (focusSignal > 0) textareaRef.current?.focus();
  }, [focusSignal]);

  const slashQuery = text.startsWith("/") ? text.slice(1).split(/\s/)[0].toLowerCase() : null;
  const slashOpen = slashQuery !== null && !running && !disabled;
  const slashItems = useMemo(
    () => (slashQuery === null ? [] : SLASH_COMMANDS.filter((item) => item.id.startsWith(slashQuery))),
    [slashQuery],
  );

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  const submit = () => {
    const value = text.trim();
    if (!value || disabled || running) return;
    onSubmit(value, team);
    setText("");
    setMenu(null);
  };

  const runCommand = (command: SlashCommand) => {
    if (command.teamMode) {
      onTeamChange(true);
      setText("");
    } else if (command.clear) {
      setText("");
    } else {
      setText(command.template ?? "");
    }
    setMenu(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || composingRef.current) return;
    if (slashOpen && slashItems.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((index) => (index + 1) % slashItems.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((index) => (index - 1 + slashItems.length) % slashItems.length);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        runCommand(slashItems[slashIndex] ?? slashItems[0]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setText("");
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const chooseSuggestion = (suggestion: string) => {
    if (suggestion.includes("团队")) onTeamChange(true);
    setText(`${suggestion}。`);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const modeItems: MenuItem[] = [
    {
      id: "standard",
      label: "标准模式",
      description: "普通对话,适合问答和单步任务",
      icon: <IconSparkles size={15} />,
      checked: !team,
      onSelect: () => onTeamChange(false),
    },
    {
      id: "team",
      label: workflow?.name ? `团队工作流 · ${workflow.name}` : "团队工作流",
      description: workflow?.description || "按工作流顺序编排多个角色",
      icon: <IconWorkflow size={15} />,
      checked: team,
      disabled: !workflow,
      onSelect: () => onTeamChange(true),
    },
  ];

  const plusItems: MenuItem[] = [
    {
      id: "new",
      label: "新建会话",
      icon: <IconPlus size={15} />,
      shortcut: "⌘N",
      onSelect: onNewChat,
    },
    {
      id: "template",
      label: "插入指令",
      icon: <IconSlash size={15} />,
      onSelect: () => setText("/"),
    },
    {
      id: "export",
      label: "导出当前会话",
      icon: <IconDownload size={15} />,
      onSelect: onExport,
    },
    {
      id: "settings",
      label: "打开设置",
      icon: <IconSettings size={15} />,
      separatorBefore: true,
      onSelect: onOpenSettings,
    },
  ];

  const modelItems: MenuItem[] = [
    {
      id: "model",
      label: model,
      description: `${provider}${streaming ? " · 流式输出" : ""}`,
      icon: <IconCpu size={15} />,
      checked: true,
      onSelect: () => undefined,
    },
    {
      id: "settings",
      label: "模型与运行设置",
      description: "模型由服务端 .env 配置",
      icon: <IconSettings size={15} />,
      onSelect: onOpenSettings,
    },
  ];

  return (
    <div className={cx("composer", `is-${variant}`)}>
      <div className="composer-shell">
        {variant === "hero" && (
          <div className="composer-context">
            <span className="context-item" title={workspace}>
              <IconFolder size={14} />
              <span>{basename(workspace) || "工作区"}</span>
            </span>
            <span className="context-sep">·</span>
            <span className="context-item">
              <IconWorkflow size={14} />
              <span>{team ? "团队工作流" : "标准模式"}</span>
            </span>
            {workflow && <span className="context-agents">{workflow.agents.length} 个角色</span>}
          </div>
        )}

        <div className={cx("composer-card", team && "is-team", running && "is-running")}>
          {slashOpen && slashItems.length > 0 && (
            <div className="slash-menu" role="listbox" aria-label="指令">
              <div className="slash-head">
                <IconSlash size={13} />
                <span>指令</span>
                <span className="slash-esc">Esc 取消</span>
              </div>
              {slashItems.map((command, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === slashIndex}
                  key={command.id}
                  className={cx("slash-item", index === slashIndex && "is-active")}
                  onMouseEnter={() => setSlashIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => runCommand(command)}
                >
                  <span className="slash-key">/{command.id}</span>
                  <span className="slash-copy">
                    <span className="slash-label">{command.label}</span>
                    <span className="slash-desc">{command.description}</span>
                  </span>
                  {index === slashIndex && <IconCornerDownLeft size={14} className="slash-enter" />}
                </button>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            disabled={disabled || running}
            placeholder={
              running
                ? "正在处理,可点击右下角停止…"
                : team
                  ? "描述团队任务,例如:为工作区生成测试用例…"
                  : "发消息或创建任务,/ 调用指令,@ 文件或对话"
            }
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            aria-label="消息输入"
          />

          <div className="composer-toolbar">
            <div className="menu-anchor">
              <button
                type="button"
                className="composer-icon-btn"
                onClick={() => setMenu((value) => (value === "plus" ? null : "plus"))}
                title="更多操作"
                aria-label="更多操作"
                aria-haspopup="menu"
                aria-expanded={menu === "plus"}
              >
                <IconPlus size={17} />
              </button>
              {menu === "plus" && (
                <Menu items={plusItems} onClose={() => setMenu(null)} className="is-up is-start" />
              )}
            </div>

            <div className="menu-anchor">
              <button
                type="button"
                className={cx("mode-btn", team && "is-team")}
                onClick={() => setMenu((value) => (value === "mode" ? null : "mode"))}
                title={team ? "团队工作流模式" : "标准模式"}
                aria-haspopup="menu"
                aria-expanded={menu === "mode"}
              >
                {team ? <IconWorkflow size={15} /> : <IconSparkles size={15} />}
                <span>{team ? "团队工作流" : "标准模式"}</span>
                <IconChevronDown size={13} />
              </button>
              {menu === "mode" && (
                <Menu items={modeItems} onClose={() => setMenu(null)} className="is-up is-start" />
              )}
            </div>

            <span className="composer-spacer" />

            <div className="menu-anchor">
              <button
                type="button"
                className="model-chip"
                onClick={() => setMenu((value) => (value === "model" ? null : "model"))}
                title={`${provider} · ${model}`}
                aria-haspopup="menu"
                aria-expanded={menu === "model"}
              >
                <IconCpu size={14} />
                <span className="model-name">{model}</span>
                {streaming && <span className="model-effort">High</span>}
                <IconChevronDown size={13} />
              </button>
              {menu === "model" && (
                <Menu items={modelItems} onClose={() => setMenu(null)} className="is-up is-end" />
              )}
            </div>

            {running ? (
              <button
                type="button"
                className="send-btn is-stop"
                onClick={onStop}
                title="停止全部任务"
                aria-label="停止全部任务"
              >
                <IconSquare size={16} />
              </button>
            ) : (
              <button
                type="button"
                className="send-btn"
                onClick={submit}
                disabled={disabled || !text.trim()}
                title="发送 (Enter)"
                aria-label="发送"
              >
                <IconArrowUp size={18} />
              </button>
            )}
          </div>
        </div>

        {variant === "hero" && !text && !running && (
          <div className="composer-suggestions">
            {SUGGESTIONS.map((suggestion) => (
              <button
                type="button"
                key={suggestion}
                className="suggestion"
                onClick={() => chooseSuggestion(suggestion)}
              >
                {suggestion.includes("团队") ? <IconWorkflow size={13} /> : <IconSparkles size={13} />}
                {suggestion}
              </button>
            ))}
          </div>
        )}

        <div className="composer-hint">
          <span>
            {running ? (
              <>
                <span className="hint-dot" /> 正在生成
              </>
            ) : (
              <>
                <IconCornerDownLeft size={12} /> Enter 发送 · Shift+Enter 换行
              </>
            )}
          </span>
          <span className="composer-hint-right">
            {mock && <span className="hint-badge">Mock</span>}
            {workflow && team && <span className="hint-badge is-team">{workflow.type === "pipeline" ? "流水线" : "评审"}</span>}
            <span>
              <IconCommand size={12} /> ⌘K 命令面板
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
