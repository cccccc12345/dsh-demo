export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function basename(path: string): string {
  if (!path) return "";
  const trimmed = path.replace(/[/\\]+$/, "");
  return trimmed.split(/[/\\]/).pop() || trimmed;
}

/** 后端 transcript 用秒,前端事件/会话用毫秒;统一在这里兼容。 */
export function toMillis(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return ts < 1_000_000_000_000 ? ts * 1000 : ts;
}

export function startOfDay(ts: number): number {
  const d = new Date(toMillis(ts));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function timeGroup(ts: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  if (day === today) return "今天";
  if (day === today - 86_400_000) return "昨天";
  if (day > today - 7 * 86_400_000) return "最近 7 天";
  return "更早";
}

export function formatRelativeDay(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const diff = Date.now() - toMillis(ts);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}分钟`;
  if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))}小时`;
  if (diff < 7 * 86_400_000) return `${Math.max(1, Math.round(diff / 86_400_000))}天`;
  const d = new Date(toMillis(ts));
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatDateTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(toMillis(ts));
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = `${d.getMonth() + 1}月${d.getDate()}日`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameYear ? `${date} ${time}` : `${d.getFullYear()}年${date} ${time}`;
}

export function formatClock(ts: number): string {
  const d = new Date(toMillis(ts));
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} 毫秒`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

export function formatDurationShort(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

export function formatTokens(value?: number): string {
  if (!value || !Number.isFinite(value)) return "";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function clampText(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      el.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function downloadText(filename: string, text: string, mime = "text/markdown;charset=utf-8"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(name: string): string {
  return (name || "session").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
}
