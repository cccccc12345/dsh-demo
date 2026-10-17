import { useEffect, useState } from "react";

/*
 * 主题切换与官方同机制:切换 body[data-ds-dark-theme] 属性,
 * 亮暗两套变量都来自 vendor 的 design-platform.css。
 */

const STORE_KEY = "agentbox-theme";
type Theme = "dark" | "light";

function readStoredTheme(): string | null {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    // Safari 隐私模式 / 禁用站点存储时 localStorage 访问会抛异常。
    return null;
  }
}

function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORE_KEY, theme);
  } catch {
    // 存不了主题不影响页面使用。
  }
}

function currentTheme(): Theme {
  const stored = readStoredTheme();
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: Theme): void {
  document.body.toggleAttribute("data-ds-dark-theme", theme === "dark");
  document.documentElement.toggleAttribute("data-ds-light-theme", theme === "light");
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    storeTheme(next);
    setTheme(next);
  };
  return { theme, toggle };
}
