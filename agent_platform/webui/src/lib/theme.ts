import { useEffect, useState } from "react";

/*
 * 与官方同机制:只切换 body[data-ds-dark-theme],亮暗变量全部来自
 * vendor/design-platform.css。模式支持 system / light / dark。
 */

const STORE_KEY = "agentbox-theme";
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

function readStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    /* 隐私模式或禁用存储时按系统主题走 */
  }
  return "system";
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: ResolvedTheme): void {
  const dark = theme === "dark";
  document.body.toggleAttribute("data-ds-dark-theme", dark);
  document.documentElement.toggleAttribute("data-ds-light-theme", !dark);
  document.documentElement.style.colorScheme = theme;
}

export interface ThemeController {
  mode: ThemeMode;
  theme: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

export function useTheme(): ThemeController {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);
  const theme: ResolvedTheme = mode === "system" ? system : mode;

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (mode !== "system") return;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const onChange = () => setSystem(media.matches ? "dark" : "light");
    setSystem(media.matches ? "dark" : "light");
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, [mode]);

  const setMode = (next: ThemeMode) => {
    try {
      localStorage.setItem(STORE_KEY, next);
    } catch {
      /* 存不了也不影响本次切换 */
    }
    setModeState(next);
  };

  const toggle = () => setMode(theme === "dark" ? "light" : "dark");

  return { mode, theme, setMode, toggle };
}
