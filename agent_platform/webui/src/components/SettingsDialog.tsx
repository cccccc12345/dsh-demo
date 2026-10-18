import { useEffect, useState, type ReactNode } from "react";
import type { ConfigInfo } from "../types";
import type { ThemeMode } from "../lib/theme";
import { basename, copyText, cx } from "../lib/ui";
import { BrandLockup } from "./Brand";
import {
  IconCheck,
  IconCopy,
  IconCpu,
  IconFolder,
  IconKeyboard,
  IconMonitor,
  IconMoon,
  IconSettings,
  IconShield,
  IconSparkles,
  IconSquare,
  IconSun,
  IconUsers,
  IconWorkflow,
  IconX,
} from "./Icons";

type Section = "appearance" | "model" | "workspace" | "workflow" | "about";

interface SettingsDialogProps {
  open: boolean;
  config: ConfigInfo | null;
  themeMode: ThemeMode;
  sidebarCollapsed: boolean;
  running: boolean;
  onClose: () => void;
  onThemeMode: (mode: ThemeMode) => void;
  onSidebarCollapsed: (collapsed: boolean) => void;
  onStopAll: () => void;
  onNotify: (text: string, kind?: "info" | "success" | "error") => void;
}

const SECTIONS: Array<{ id: Section; label: string; icon: JSX.Element }> = [
  { id: "appearance", label: "外观", icon: <IconSun size={16} /> },
  { id: "model", label: "模型", icon: <IconCpu size={16} /> },
  { id: "workspace", label: "工作区", icon: <IconFolder size={16} /> },
  { id: "workflow", label: "工作流", icon: <IconWorkflow size={16} /> },
  { id: "about", label: "关于", icon: <IconSparkles size={16} /> },
];

const THEME_OPTIONS: Array<{
  id: ThemeMode;
  label: string;
  description: string;
  icon: JSX.Element;
}> = [
  { id: "system", label: "跟随系统", description: "随系统亮暗自动切换", icon: <IconMonitor size={18} /> },
  { id: "light", label: "浅色", description: "明亮、清爽", icon: <IconSun size={18} /> },
  { id: "dark", label: "深色", description: "低光环境更舒适", icon: <IconMoon size={18} /> },
];

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-field">
      <div className="settings-field-copy">
        <span className="settings-field-label">{label}</span>
        {hint && <span className="settings-field-hint">{hint}</span>}
      </div>
      <div className="settings-field-value">{children}</div>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx("switch", checked && "is-on")}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
    </button>
  );
}

export function SettingsDialog(props: SettingsDialogProps) {
  const {
    open,
    config,
    themeMode,
    sidebarCollapsed,
    running,
    onClose,
    onThemeMode,
    onSidebarCollapsed,
    onStopAll,
    onNotify,
  } = props;
  const [section, setSection] = useState<Section>("appearance");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  const workflow = config?.workflow;

  const copyWorkspace = async () => {
    const ok = await copyText(config?.workspace || "");
    if (ok) {
      setCopied(true);
      onNotify("工作区路径已复制", "success");
      window.setTimeout(() => setCopied(false), 1400);
    } else {
      onNotify("复制失败", "error");
    }
  };

  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-label="设置">
        <header className="settings-header">
          <div className="settings-heading">
            <span className="settings-heading-icon"><IconSettings size={18} /></span>
            <div>
              <h2>设置</h2>
              <p>外观、模型与工作流配置</p>
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭" aria-label="关闭">
            <IconX size={18} />
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-nav" aria-label="设置分类">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cx("settings-nav-item", section === item.id && "is-active")}
                onClick={() => setSection(item.id)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {section === "appearance" && (
              <>
                <div className="settings-section-head">
                  <h3>外观</h3>
                  <p>主题会保存在本地,下次打开自动恢复。</p>
                </div>
                <div className="theme-grid">
                  {THEME_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={cx("theme-option", themeMode === option.id && "is-active")}
                      onClick={() => onThemeMode(option.id)}
                    >
                      <span className="theme-option-icon">{option.icon}</span>
                      <span className="theme-option-label">{option.label}</span>
                      <span className="theme-option-desc">{option.description}</span>
                      {themeMode === option.id && <IconCheck size={15} className="theme-option-check" />}
                    </button>
                  ))}
                </div>
                <div className="settings-list">
                  <Field label="收起侧边栏" hint="只保留图标轨道,给对话更多空间">
                    <Switch
                      checked={sidebarCollapsed}
                      onChange={onSidebarCollapsed}
                      label="收起侧边栏"
                    />
                  </Field>
                </div>
              </>
            )}

            {section === "model" && (
              <>
                <div className="settings-section-head">
                  <h3>模型与运行</h3>
                  <p>模型和 provider 由服务端 .env 配置,修改后重启服务生效。</p>
                </div>
                <div className="settings-list">
                  <Field label="模型">
                    <code className="settings-code">{config?.model || "—"}</code>
                  </Field>
                  <Field label="Provider">
                    <code className="settings-code">{config?.provider || "—"}</code>
                  </Field>
                  <Field label="流式输出" hint="assistant-stream 插件逐 token 推送到前端">
                    <span className={cx("settings-badge", config?.streaming && "is-ok")}>
                      {config?.streaming ? "已启用" : "未启用"}
                    </span>
                  </Field>
                  <Field label="Runtime" hint="共享 dsh runtime 进程">
                    <span className={cx("settings-badge", config?.runtimeAlive && "is-ok")}>
                      {config?.runtimeAlive ? "在线" : config?.mock ? "Mock 模式" : "待启动"}
                    </span>
                  </Field>
                  <Field label="Mock 模式" hint="未配置真实 API Key 时回放本地剧本">
                    <span className={cx("settings-badge", config?.mock && "is-warn")}>
                      {config?.mock ? "开启" : "关闭"}
                    </span>
                  </Field>
                </div>
                {config?.startupError && (
                  <div className="settings-error">
                    <IconShield size={15} />
                    <span>{config.startupError}</span>
                  </div>
                )}
              </>
            )}

            {section === "workspace" && (
              <>
                <div className="settings-section-head">
                  <h3>工作区</h3>
                  <p>Agent 的 bash / read / write 等工具只能访问这个目录。</p>
                </div>
                <div className="settings-list">
                  <Field label="目录路径">
                    <span className="settings-path" title={config?.workspace || ""}>
                      <code>{config?.workspace || "—"}</code>
                      <button type="button" onClick={copyWorkspace} title="复制路径" aria-label="复制路径">
                        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                      </button>
                    </span>
                  </Field>
                  <Field label="目录名">
                    <code className="settings-code">{basename(config?.workspace || "") || "—"}</code>
                  </Field>
                  <Field label="人工审批" hint="工具执行前在浏览器里确认">
                    <span className={cx("settings-badge", config?.approval?.enabled && "is-ok")}>
                      {config?.approval?.enabled ? `已启用 · ${config.approval.timeoutSeconds}s` : "关闭"}
                    </span>
                  </Field>
                </div>
                <div className="settings-actions">
                  <button
                    type="button"
                    className="danger-btn"
                    onClick={onStopAll}
                    disabled={!running}
                  >
                    <IconSquare size={14} />
                    停止全部任务
                  </button>
                  <span className="settings-action-hint">
                    {running ? "会硬中断共享 runtime,下一条消息自动重启" : "当前没有运行中的任务"}
                  </span>
                </div>
              </>
            )}

            {section === "workflow" && (
              <>
                <div className="settings-section-head">
                  <h3>团队工作流</h3>
                  <p>{workflow?.description || "在仓库根目录的 workflows.json 中定义角色和编排方式。"}</p>
                </div>
                <div className="settings-list">
                  <Field label="名称">
                    <span className="settings-value">{workflow?.name || "未配置"}</span>
                  </Field>
                  <Field label="编排类型">
                    <span className="settings-badge">
                      {workflow?.type === "pipeline" ? "pipeline · 顺序执行" : "review · 质量门禁"}
                    </span>
                  </Field>
                  {workflow?.type !== "pipeline" && (
                    <Field label="最大轮次">
                      <span className="settings-value">{workflow?.maxRounds ?? "—"}</span>
                    </Field>
                  )}
                </div>
                <div className="settings-roster">
                  <div className="settings-roster-head">
                    <IconUsers size={15} />
                    <span>角色名册</span>
                  </div>
                  {(workflow?.agents ?? []).map((agent) => (
                    <div className="settings-roster-row" key={agent.id}>
                      <span className="roster-emoji">{agent.emoji}</span>
                      <div className="roster-copy">
                        <span className="roster-name">{agent.name}</span>
                        <span className="roster-role">{agent.role}</span>
                      </div>
                      <span className={cx("roster-badge", agent.writes && "is-write")}>
                        {agent.writes ? "可写文件" : "只读"}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {section === "about" && (
              <>
                <div className="about-brand">
                  <BrandLockup size={30} />
                  <p>基于 DeepSeek Harness SDK 的多 Agent Web 工作台</p>
                </div>
                <div className="settings-list">
                  <Field label="版本">
                    <span className="settings-value">0.1.0 · 预览版</span>
                  </Field>
                  <Field label="前端">
                    <span className="settings-value">React + Vite · 官方设计令牌</span>
                  </Field>
                  <Field label="后端">
                    <span className="settings-value">FastAPI · SSE · dsh runtime</span>
                  </Field>
                </div>
                <div className="shortcuts-card">
                  <div className="shortcuts-head">
                    <IconKeyboard size={15} />
                    <span>键盘快捷键</span>
                  </div>
                  <div className="shortcut-row"><span>命令面板</span><kbd>⌘ K</kbd></div>
                  <div className="shortcut-row"><span>新建会话</span><kbd>⌘ N</kbd></div>
                  <div className="shortcut-row"><span>收起 / 展开侧边栏</span><kbd>⌘ B</kbd></div>
                  <div className="shortcut-row"><span>打开设置</span><kbd>⌘ ,</kbd></div>
                  <div className="shortcut-row"><span>发送消息</span><kbd>Enter</kbd></div>
                  <div className="shortcut-row"><span>换行</span><kbd>Shift Enter</kbd></div>
                  <div className="shortcut-row"><span>关闭弹层</span><kbd>Esc</kbd></div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
