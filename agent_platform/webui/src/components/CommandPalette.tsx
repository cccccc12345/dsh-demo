import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ResolvedTheme } from "../lib/theme";
import { cx } from "../lib/ui";
import {
  IconCommand,
  IconDownload,
  IconMessage,
  IconMoon,
  IconPanelLeft,
  IconPlusCircle,
  IconRoute,
  IconSettings,
  IconSquare,
  IconSun,
  IconWorkflow,
} from "./Icons";

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  icon: ReactNode;
  keywords?: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  running: boolean;
  hasChat: boolean;
  theme: ResolvedTheme;
  onClose: () => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  onOpenChat: () => void;
  onOpenTeam: () => void;
  onOpenTrajectory: () => void;
  onStopAll: () => void;
  onExport: () => void;
  onToggleSidebar: () => void;
}

export function CommandPalette(props: CommandPaletteProps) {
  const {
    open,
    running,
    hasChat,
    theme,
    onClose,
    onNewChat,
    onOpenSettings,
    onToggleTheme,
    onOpenChat,
    onOpenTeam,
    onOpenTrajectory,
    onStopAll,
    onExport,
    onToggleSidebar,
  } = props;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands: CommandItem[] = useMemo(
    () => [
      {
        id: "new",
        label: "新建会话",
        hint: "开始一段新的对话",
        shortcut: "⌘N",
        icon: <IconPlusCircle size={17} />,
        keywords: "new chat session",
        action: onNewChat,
      },
      {
        id: "settings",
        label: "打开设置",
        hint: "外观、模型、工作区与工作流",
        shortcut: "⌘,",
        icon: <IconSettings size={17} />,
        keywords: "settings preferences config",
        action: onOpenSettings,
      },
      {
        id: "theme",
        label: theme === "dark" ? "切换到亮色主题" : "切换到暗色主题",
        hint: "立即切换界面明暗",
        icon: theme === "dark" ? <IconSun size={17} /> : <IconMoon size={17} />,
        keywords: "theme dark light appearance",
        action: onToggleTheme,
      },
      {
        id: "sidebar",
        label: "收起 / 展开侧边栏",
        shortcut: "⌘B",
        icon: <IconPanelLeft size={17} />,
        keywords: "sidebar collapse expand",
        action: onToggleSidebar,
      },
      {
        id: "chat",
        label: "返回对话",
        hint: "查看当前会话",
        icon: <IconMessage size={17} />,
        keywords: "chat conversation view",
        action: onOpenChat,
      },
      {
        id: "team",
        label: "打开团队工作流",
        hint: "查看各角色阶段与输出",
        icon: <IconWorkflow size={17} />,
        keywords: "team workflow agents",
        action: onOpenTeam,
      },
      {
        id: "trajectory",
        label: "打开运行轨迹",
        hint: "Turn / Step / Tool 时间线",
        icon: <IconRoute size={17} />,
        keywords: "trajectory timeline events",
        action: onOpenTrajectory,
      },
      ...(hasChat
        ? [
            {
              id: "export",
              label: "导出当前会话",
              hint: "下载为 Markdown",
              icon: <IconDownload size={17} />,
              keywords: "export download markdown",
              action: onExport,
            },
          ]
        : []),
      ...(running
        ? [
            {
              id: "stop",
              label: "停止全部任务",
              hint: "硬中断共享 runtime",
              icon: <IconSquare size={17} />,
              keywords: "stop cancel interrupt",
              action: onStopAll,
            },
          ]
        : []),
    ],
    [
      hasChat,
      onExport,
      onNewChat,
      onOpenChat,
      onOpenSettings,
      onOpenTeam,
      onOpenTrajectory,
      onStopAll,
      onToggleSidebar,
      onToggleTheme,
      running,
      theme,
    ],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.hint ?? ""} ${command.keywords ?? ""}`.toLowerCase().includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  const run = (item: CommandItem) => {
    item.action();
    onClose();
  };

  return (
    <div
      className="palette-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="palette-input-row">
          <IconCommand size={18} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索命令或操作…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((index) => (filtered.length === 0 ? 0 : (index + 1) % filtered.length));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((index) =>
                  filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length,
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                const item = filtered[selected] ?? filtered[0];
                if (item) run(item);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            aria-label="搜索命令"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" ref={listRef} role="listbox" aria-label="命令">
          {filtered.length === 0 && <div className="palette-empty">没有匹配的命令</div>}
          {filtered.map((item, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === selected}
              data-index={index}
              key={item.id}
              className={cx("palette-item", index === selected && "is-active")}
              onMouseEnter={() => setSelected(index)}
              onClick={() => run(item)}
            >
              <span className="palette-icon">{item.icon}</span>
              <span className="palette-copy">
                <span className="palette-label">{item.label}</span>
                {item.hint && <span className="palette-hint">{item.hint}</span>}
              </span>
              {item.shortcut && <kbd className="palette-shortcut">{item.shortcut}</kbd>}
            </button>
          ))}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 执行</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  );
}
