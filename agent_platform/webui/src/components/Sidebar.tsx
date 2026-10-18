import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatSummary, ConfigInfo } from "../types";
import type { ResolvedTheme } from "../lib/theme";
import { basename, cx, formatRelativeDay, timeGroup } from "../lib/ui";
import { BrandLockup } from "./Brand";
import {
  IconArrowLeft,
  IconChevronDown,
  IconCommand,
  IconDownload,
  IconFolder,
  IconLoader,
  IconMoon,
  IconMore,
  IconPanelLeft,
  IconPencil,
  IconPin,
  IconPinOff,
  IconPlus,
  IconPlusCircle,
  IconRoute,
  IconSearch,
  IconSettings,
  IconShield,
  IconSort,
  IconSun,
  IconTrash,
  IconWorkflow,
  IconX,
} from "./Icons";
import { Menu, type MenuItem } from "./Menu";

interface SidebarProps {
  chats: ChatSummary[];
  activeId: string | null;
  runningChatId: string | null;
  config: ConfigInfo | null;
  collapsed: boolean;
  mobileOpen: boolean;
  approvalsCount: number;
  pinned: string[];
  running: boolean;
  theme: ResolvedTheme;
  onSelectChat: (id: string) => void;
  onCreateChat: () => void;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string, title: string) => void;
  onTogglePin: (id: string) => void;
  onToggleCollapsed: () => void;
  onCloseMobile: () => void;
  onOpenSettings: () => void;
  onOpenTeam: () => void;
  onOpenTrajectory: () => void;
  onOpenApprovals: () => void;
  onOpenPalette: () => void;
  onExportChat: (id: string) => void;
  onToggleTheme: () => void;
  onStopAll: () => void;
}

interface RenameState {
  id: string;
  value: string;
}

interface MenuState {
  id: string;
  x: number;
  y: number;
}

const VISIBLE_LIMIT = 6;

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  return (
    <input
      ref={ref}
      className="session-rename"
      value={value}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          const next = value.trim();
          if (next) onCommit(next);
          else onCancel();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => {
        const next = value.trim();
        if (next && next !== initial) onCommit(next);
        else onCancel();
      }}
      aria-label="重命名会话"
    />
  );
}

export function Sidebar(props: SidebarProps) {
  const {
    chats,
    activeId,
    runningChatId,
    config,
    collapsed,
    mobileOpen,
    approvalsCount,
    pinned,
    running,
    theme,
    onSelectChat,
    onCreateChat,
    onDeleteChat,
    onRenameChat,
    onTogglePin,
    onToggleCollapsed,
    onCloseMobile,
    onOpenSettings,
    onOpenTeam,
    onOpenTrajectory,
    onOpenApprovals,
    onOpenPalette,
    onExportChat,
    onToggleTheme,
    onStopAll,
  } = props;

  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [newestFirst, setNewestFirst] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [rename, setRename] = useState<RenameState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const workspace = basename(config?.workspace || "");
  const agentCount = config?.workflow?.agents.length ?? 0;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? chats.filter((chat) => (chat.title || "新会话").toLowerCase().includes(needle))
      : chats;
    return [...list].sort((a, b) => (newestFirst ? b.createdAt - a.createdAt : a.createdAt - b.createdAt));
  }, [chats, newestFirst, query]);

  const pinnedChats = useMemo(
    () => filtered.filter((chat) => pinned.includes(chat.id)),
    [filtered, pinned],
  );

  const rest = useMemo(
    () => filtered.filter((chat) => !pinned.includes(chat.id)),
    [filtered, pinned],
  );

  const groups = useMemo(() => {
    if (query.trim()) return [["搜索结果", rest] as const].filter(([, list]) => list.length > 0);
    const map = new Map<string, ChatSummary[]>();
    for (const chat of rest) {
      const key = timeGroup(chat.createdAt);
      const list = map.get(key) ?? [];
      list.push(chat);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [query, rest]);

  const hiddenCount = Math.max(0, rest.length - VISIBLE_LIMIT);
  const activeChat = chats.find((chat) => chat.id === activeId) ?? null;

  const menuChat = menu ? chats.find((chat) => chat.id === menu.id) : undefined;

  const sessionMenuItems: MenuItem[] = menuChat
    ? [
        {
          id: "rename",
          label: "重命名",
          icon: <IconPencil size={15} />,
          onSelect: () => setRename({ id: menuChat.id, value: menuChat.title || "新会话" }),
        },
        {
          id: "pin",
          label: pinned.includes(menuChat.id) ? "取消置顶" : "置顶会话",
          icon: pinned.includes(menuChat.id) ? <IconPinOff size={15} /> : <IconPin size={15} />,
          onSelect: () => onTogglePin(menuChat.id),
        },
        {
          id: "export",
          label: "导出 Markdown",
          icon: <IconDownload size={15} />,
          onSelect: () => onExportChat(menuChat.id),
        },
        {
          id: "delete",
          label: "删除会话",
          icon: <IconTrash size={15} />,
          danger: true,
          separatorBefore: true,
          onSelect: () => onDeleteChat(menuChat.id),
        },
      ]
    : [];

  const moreItems: MenuItem[] = [
    {
      id: "settings",
      label: "设置",
      icon: <IconSettings size={15} />,
      shortcut: "⌘,",
      onSelect: onOpenSettings,
    },
    {
      id: "palette",
      label: "命令面板",
      icon: <IconCommand size={15} />,
      shortcut: "⌘K",
      onSelect: onOpenPalette,
    },
    {
      id: "theme",
      label: theme === "dark" ? "切换到亮色" : "切换到暗色",
      icon: theme === "dark" ? <IconSun size={15} /> : <IconMoon size={15} />,
      onSelect: onToggleTheme,
    },
    {
      id: "stop",
      label: "停止全部任务",
      icon: <IconX size={15} />,
      danger: true,
      disabled: !running,
      separatorBefore: true,
      onSelect: onStopAll,
    },
  ];

  const renderSession = (chat: ChatSummary) => {
    const isActive = chat.id === activeId;
    const isRunning = runningChatId === chat.id;
    return (
      <div
        className={cx("session-row", isActive && "is-active", isRunning && "is-running")}
        key={chat.id}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({
            id: chat.id,
            x: Math.min(event.clientX, window.innerWidth - 230),
            y: Math.min(event.clientY, window.innerHeight - 230),
          });
        }}
      >
        <button
          type="button"
          className="session-main"
          onClick={() => onSelectChat(chat.id)}
          title={chat.title || "新会话"}
          aria-current={isActive ? "page" : undefined}
        >
          {isRunning ? (
            <span className="session-spinner"><IconLoader size={13} /></span>
          ) : pinned.includes(chat.id) ? (
            <IconPin size={12} className="session-pin" />
          ) : null}
          {rename?.id === chat.id ? (
            <RenameInput
              initial={rename.value}
              onCommit={(value) => {
                setRename(null);
                onRenameChat(chat.id, value);
              }}
              onCancel={() => setRename(null)}
            />
          ) : (
            <>
              <span className="session-title">{chat.title || "新会话"}</span>
              <span className="session-time">{formatRelativeDay(chat.createdAt)}</span>
            </>
          )}
        </button>
        <button
          type="button"
          className="session-more"
          aria-label={`会话操作:${chat.title || "新会话"}`}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({
              id: chat.id,
              x: Math.min(rect.right - 190, window.innerWidth - 230),
              y: Math.min(rect.bottom + 4, window.innerHeight - 230),
            });
          }}
        >
          <IconMore size={15} />
        </button>
      </div>
    );
  };

  return (
    <aside
      className={cx("sidebar", collapsed && "is-collapsed", mobileOpen && "is-mobile-open")}
      aria-label="会话导航"
    >
      <div className="sidebar-brand">
        {collapsed ? (
          <button
            type="button"
            className="brand-button is-collapsed"
            onClick={onToggleCollapsed}
            title="展开侧边栏"
            aria-label="展开侧边栏"
          >
            <BrandLockup collapsed size={24} />
          </button>
        ) : (
          <div className="brand-button">
            <BrandLockup size={24} />
          </div>
        )}
        <button
          type="button"
          className="icon-btn sidebar-collapse"
          onClick={onToggleCollapsed}
          title={collapsed ? "展开侧边栏" : "收起侧边栏"}
          aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          <IconPanelLeft size={17} />
        </button>
        <button
          type="button"
          className="icon-btn sidebar-close"
          onClick={onCloseMobile}
          title="关闭侧边栏"
          aria-label="关闭侧边栏"
        >
          <IconArrowLeft size={17} />
        </button>
      </div>

      <div className="sidebar-scroll">
        <button
          type="button"
          className="new-session"
          onClick={onCreateChat}
          title="新会话 (⌘N)"
        >
          <IconPlusCircle size={17} />
          <span>新会话</span>
        </button>

        <nav className="sidebar-nav" aria-label="工作区导航">
          <button type="button" className="nav-item" onClick={onOpenTeam} title="团队工作流">
            <IconWorkflow size={17} />
            <span className="nav-label">团队工作流</span>
            {agentCount > 0 && <span className="nav-badge">{agentCount}</span>}
          </button>
          <button type="button" className="nav-item" onClick={onOpenTrajectory} title="运行轨迹">
            <IconRoute size={17} />
            <span className="nav-label">运行轨迹</span>
          </button>
          <button type="button" className="nav-item" onClick={onOpenPalette} title="命令面板">
            <IconCommand size={17} />
            <span className="nav-label">命令面板</span>
            <span className="nav-kbd">⌘K</span>
          </button>
        </nav>

        {!collapsed && (
          <>
            <div className="sidebar-section-head">
              <span>工作区</span>
              <span className="section-actions">
                <button
                  type="button"
                  className="icon-btn is-small"
                  onClick={() => {
                    if (searchOpen) {
                      setSearchOpen(false);
                      setQuery("");
                    } else {
                      setSearchOpen(true);
                    }
                  }}
                  title="搜索会话"
                  aria-label="搜索会话"
                >
                  <IconSearch size={15} />
                </button>
                <button
                  type="button"
                  className="icon-btn is-small"
                  onClick={() => setNewestFirst((value) => !value)}
                  title={newestFirst ? "当前:最新优先" : "当前:最早优先"}
                  aria-label="切换排序"
                >
                  <IconSort size={15} />
                </button>
                <button
                  type="button"
                  className="icon-btn is-small"
                  onClick={onCreateChat}
                  title="新建会话"
                  aria-label="新建会话"
                >
                  <IconPlus size={15} />
                </button>
              </span>
            </div>

            {searchOpen && (
              <div className="sidebar-search">
                <IconSearch size={14} />
                <input
                  ref={searchRef}
                  value={query}
                  placeholder="搜索会话…"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setQuery("");
                      setSearchOpen(false);
                    }
                  }}
                  aria-label="搜索会话"
                />
                {query && (
                  <button type="button" onClick={() => setQuery("")} aria-label="清空搜索">
                    <IconX size={13} />
                  </button>
                )}
              </div>
            )}

            <button
              type="button"
              className="workspace-row"
              onClick={() => setWorkspaceOpen((open) => !open)}
              aria-expanded={workspaceOpen}
            >
              <IconFolder size={16} />
              <span className="workspace-name">{workspace || "工作区"}</span>
              <IconChevronDown
                size={14}
                className={cx("workspace-chevron", !workspaceOpen && "is-closed")}
              />
            </button>

            {workspaceOpen && (
              <div className="session-list" aria-label="会话列表">
                {filtered.length === 0 && (
                  <div className="sidebar-empty">{query ? "没有匹配的会话" : "还没有会话"}</div>
                )}

                {pinnedChats.length > 0 && (
                  <div className="session-group">
                    <div className="session-group-label">已置顶</div>
                    {pinnedChats.map(renderSession)}
                  </div>
                )}

                {groups.map(([label, list]) => {
                  const startIndex = label === "搜索结果" ? 0 : rest.indexOf(list[0]);
                  const remaining = expanded || query ? Infinity : Math.max(0, VISIBLE_LIMIT - startIndex);
                  const visible = list.slice(0, remaining);
                  if (visible.length === 0) return null;
                  return (
                    <div className="session-group" key={label}>
                      {label !== "今天" && <div className="session-group-label">{label}</div>}
                      {visible.map(renderSession)}
                    </div>
                  );
                })}

                {!query && hiddenCount > 0 && (
                  <button
                    type="button"
                    className="session-more-link"
                    onClick={() => setExpanded((value) => !value)}
                  >
                    {expanded ? "收起会话" : `展开其余 ${hiddenCount} 个会话`}
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {collapsed && (
          <>
            <div className="rail-divider" />
            <div className="rail-recents" aria-label="最近会话">
              {chats.slice(0, 5).map((chat) => (
                <button
                  type="button"
                  key={chat.id}
                  className={cx("rail-recent", chat.id === activeId && "is-active")}
                  onClick={() => onSelectChat(chat.id)}
                  title={chat.title || "新会话"}
                  aria-label={chat.title || "新会话"}
                >
                  {(chat.title || "新").slice(0, 1)}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {!collapsed && (
        <div className="sidebar-foot">
          {approvalsCount > 0 && (
            <button type="button" className="sidebar-approval" onClick={onOpenApprovals}>
              <IconShield size={14} />
              <span>{approvalsCount} 个待审批</span>
              <span className="sidebar-approval-dot" />
            </button>
          )}
          <div className="sidebar-status" title={config?.workspace || ""}>
            <span
              className={cx(
                "status-dot",
                config?.mock && "is-mock",
                config?.startupError && "is-error",
              )}
            />
            <span>{config ? (config.mock ? "Mock 预览" : "已连接") : "连接中…"}</span>
            {config && <span className="sidebar-status-model">{config.model}</span>}
          </div>
          <div className="sidebar-footer">
            <div className="menu-anchor">
              <button
                type="button"
                className="more-btn"
                onClick={() => setMoreOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
              >
                <IconMore size={16} />
                <span>更多</span>
              </button>
              {moreOpen && (
                <Menu
                  items={moreItems}
                  onClose={() => setMoreOpen(false)}
                  className="is-up is-start"
                />
              )}
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={onToggleTheme}
              title={theme === "dark" ? "切换到亮色" : "切换到暗色"}
              aria-label="切换主题"
            >
              {theme === "dark" ? <IconSun size={16} /> : <IconMoon size={16} />}
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={onOpenSettings}
              title="设置"
              aria-label="设置"
            >
              <IconSettings size={16} />
            </button>
          </div>
        </div>
      )}

      {collapsed && (
        <div className="sidebar-foot is-rail">
          <button
            type="button"
            className="icon-btn"
            onClick={onOpenSettings}
            title="设置"
            aria-label="设置"
          >
            <IconSettings size={17} />
          </button>
          {approvalsCount > 0 && (
            <button
              type="button"
              className="icon-btn is-alert"
              onClick={onOpenApprovals}
              title={`${approvalsCount} 个待审批`}
              aria-label={`${approvalsCount} 个待审批`}
            >
              <IconShield size={17} />
            </button>
          )}
        </div>
      )}

      {activeChat && collapsed && (
        <div className="sr-only">{activeChat.title}</div>
      )}

      {menu && menuChat && (
        <Menu
          items={sessionMenuItems}
          onClose={() => setMenu(null)}
          style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 1300 }}
        />
      )}
    </aside>
  );
}
