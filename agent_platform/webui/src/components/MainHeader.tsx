import { useState } from "react";
import type { ResolvedTheme } from "../lib/theme";
import type { ViewTab } from "../types";
import { cx } from "../lib/ui";
import {
  IconArrowLeft,
  IconCommand,
  IconDownload,
  IconLoader,
  IconMessage,
  IconMore,
  IconMoon,
  IconPanelLeft,
  IconPlusCircle,
  IconSettings,
  IconShield,
  IconSquare,
  IconSun,
  IconTrash,
  IconX,
} from "./Icons";
import { Menu, type MenuItem } from "./Menu";

interface MainHeaderProps {
  title: string;
  empty: boolean;
  standalone: boolean;
  hasChat: boolean;
  view: ViewTab;
  running: boolean;
  status: string;
  elapsedLabel: string;
  connected: boolean;
  mock: boolean;
  teamCount: number;
  approvalsCount: number;
  theme: ResolvedTheme;
  onChangeView: (view: ViewTab) => void;
  onOpenSidebar: () => void;
  onNewChat: () => void;
  onStopAll: () => void;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
  onOpenApprovals: () => void;
  onExport: () => void;
  onDelete: () => void;
  onToggleTheme: () => void;
  onBack: () => void;
}

const TABS: Array<{ id: ViewTab; label: string }> = [
  { id: "chat", label: "对话" },
  { id: "team", label: "团队" },
  { id: "trajectory", label: "轨迹" },
];

export function MainHeader(props: MainHeaderProps) {
  const {
    title,
    empty,
    standalone,
    hasChat,
    view,
    running,
    status,
    elapsedLabel,
    connected,
    mock,
    teamCount,
    approvalsCount,
    theme,
    onChangeView,
    onOpenSidebar,
    onNewChat,
    onStopAll,
    onOpenSettings,
    onOpenPalette,
    onOpenApprovals,
    onExport,
    onDelete,
    onToggleTheme,
    onBack,
  } = props;

  const [moreOpen, setMoreOpen] = useState(false);

  const menuItems: MenuItem[] = [
    {
      id: "new",
      label: "新建会话",
      icon: <IconPlusCircle size={15} />,
      shortcut: "⌘N",
      onSelect: onNewChat,
    },
    ...(hasChat
      ? [
          {
            id: "export",
            label: "导出 Markdown",
            icon: <IconDownload size={15} />,
            onSelect: onExport,
          },
        ]
      : []),
    {
      id: "palette",
      label: "命令面板",
      icon: <IconCommand size={15} />,
      shortcut: "⌘K",
      onSelect: onOpenPalette,
    },
    {
      id: "settings",
      label: "设置",
      icon: <IconSettings size={15} />,
      shortcut: "⌘,",
      onSelect: onOpenSettings,
    },
    ...(running
      ? [
          {
            id: "stop",
            label: "停止全部任务",
            icon: <IconSquare size={15} />,
            danger: true,
            separatorBefore: true,
            onSelect: onStopAll,
          },
        ]
      : []),
    ...(hasChat
      ? [
          {
            id: "delete",
            label: "删除会话",
            icon: <IconTrash size={15} />,
            danger: true,
            separatorBefore: true,
            onSelect: onDelete,
          },
        ]
      : []),
  ];

  if (empty) {
    return (
      <header className="main-header is-empty">
        <button
          type="button"
          className="icon-btn mobile-menu-btn"
          onClick={onOpenSidebar}
          aria-label="打开侧边栏"
          title="打开侧边栏"
        >
          <IconPanelLeft size={18} />
        </button>
        <div className="header-spacer" />
        {approvalsCount > 0 && (
          <button type="button" className="header-approval" onClick={onOpenApprovals}>
            <IconShield size={14} />
            <span>{approvalsCount} 个待审批</span>
          </button>
        )}
        <span
          className={cx("connection-pill", mock && "is-mock", !connected && "is-offline")}
          title={mock ? "Mock 模式:使用本地剧本回放" : connected ? "后端已连接" : "后端未连接"}
        >
          <span className="status-dot" />
          {mock ? "Mock 模式" : connected ? "在线" : "离线"}
        </span>
        <button
          type="button"
          className="icon-btn"
          onClick={onToggleTheme}
          title={theme === "dark" ? "切换到亮色" : "切换到暗色"}
          aria-label="切换主题"
        >
          {theme === "dark" ? <IconSun size={17} /> : <IconMoon size={17} />}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={onOpenSettings}
          title="设置"
          aria-label="设置"
        >
          <IconSettings size={17} />
        </button>
        <div className="menu-anchor">
          <button
            type="button"
            className="icon-btn"
            onClick={() => setMoreOpen((open) => !open)}
            title="更多"
            aria-label="更多"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
          >
            <IconMore size={17} />
          </button>
          {moreOpen && <Menu items={menuItems} onClose={() => setMoreOpen(false)} className="is-end" />}
        </div>
      </header>
    );
  }

  return (
    <header className="main-header">
      <div className="title-row">
        <button
          type="button"
          className="icon-btn mobile-menu-btn"
          onClick={onOpenSidebar}
          aria-label="打开侧边栏"
          title="打开侧边栏"
        >
          <IconPanelLeft size={18} />
        </button>

        <div className="title-crumb">
          {standalone ? (
            <button
              type="button"
              className="icon-btn is-small"
              onClick={onBack}
              title="返回对话"
              aria-label="返回对话"
            >
              <IconArrowLeft size={16} />
            </button>
          ) : (
            <IconMessage size={16} className="title-icon" />
          )}
          <h1 className="title-text" title={title}>
            {title}
          </h1>
        </div>

        <div className="title-actions">
          {approvalsCount > 0 && (
            <button type="button" className="header-approval" onClick={onOpenApprovals}>
              <IconShield size={14} />
              <span>审批 {approvalsCount}</span>
            </button>
          )}
          {running ? (
            <span className="run-pill" title={status || "正在运行"}>
              <IconLoader size={13} className="spin" />
              <span className="run-pill-text">{status || "运行中"}</span>
              {elapsedLabel && <span className="run-pill-time">{elapsedLabel}</span>}
            </span>
          ) : (
            <span
              className={cx("connection-pill", mock && "is-mock", !connected && "is-offline")}
              title={mock ? "Mock 模式:使用本地剧本回放" : connected ? "后端已连接" : "后端未连接"}
            >
              <span className="status-dot" />
              {mock ? "Mock" : connected ? "在线" : "离线"}
            </span>
          )}
          {running && (
            <button
              type="button"
              className="icon-btn is-stop"
              onClick={onStopAll}
              title="停止全部任务"
              aria-label="停止全部任务"
            >
              <IconX size={17} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            onClick={onNewChat}
            title="新建会话 (⌘N)"
            aria-label="新建会话"
          >
            <IconPlusCircle size={17} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onToggleTheme}
            title={theme === "dark" ? "切换到亮色" : "切换到暗色"}
            aria-label="切换主题"
          >
            {theme === "dark" ? <IconSun size={17} /> : <IconMoon size={17} />}
          </button>
          <div className="menu-anchor">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setMoreOpen((open) => !open)}
              title="更多"
              aria-label="更多"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
            >
              <IconMore size={17} />
            </button>
            {moreOpen && <Menu items={menuItems} onClose={() => setMoreOpen(false)} className="is-end" />}
          </div>
        </div>
      </div>

      {!standalone && hasChat && (
        <div className="view-tabs" role="tablist" aria-label="视图">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={view === tab.id}
              className={cx("view-tab", view === tab.id && "is-active")}
              onClick={() => onChangeView(tab.id)}
            >
              {tab.label}
              {tab.id === "team" && teamCount > 0 && (
                <span className="tab-count">{teamCount}</span>
              )}
              {tab.id === "trajectory" && running && <span className="tab-live" />}
            </button>
          ))}
        </div>
      )}
    </header>
  );
}
