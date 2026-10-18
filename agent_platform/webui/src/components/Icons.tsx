import type { ReactNode, SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconPanelLeft = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" /></Svg>
);
export const IconPlus = (p: IconProps) => (
  <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
);
export const IconPlusCircle = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></Svg>
);
export const IconSearch = (p: IconProps) => (
  <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4.5 4.5" /></Svg>
);
export const IconSort = (p: IconProps) => (
  <Svg {...p}><path d="M8 4v16M5 7l3-3 3 3M16 20V4M13 17l3 3 3-3" /></Svg>
);
export const IconFilter = (p: IconProps) => (
  <Svg {...p}><path d="M4 6h16M7 12h10M10 18h4" /></Svg>
);
export const IconFolder = (p: IconProps) => (
  <Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></Svg>
);
export const IconFolderOpen = (p: IconProps) => (
  <Svg {...p}><path d="M3 8V7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1" /><path d="M3 8h18l-2 10a2 2 0 0 1-2 1.6H5A2 2 0 0 1 3 18Z" /></Svg>
);
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
);
export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>
);
export const IconMore = (p: IconProps) => (
  <Svg {...p} stroke="none" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></Svg>
);
export const IconSettings = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.95 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 14.94a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.88a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.14.42.46.79.87 1.03.3.17.64.26.99.26H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z" /></Svg>
);
export const IconSun = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" /></Svg>
);
export const IconMoon = (p: IconProps) => (
  <Svg {...p}><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" /></Svg>
);
export const IconMonitor = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Svg>
);
export const IconMessage = (p: IconProps) => (
  <Svg {...p}><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /></Svg>
);
export const IconWorkflow = (p: IconProps) => (
  <Svg {...p}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="12" r="2.5" /><path d="M8.5 6H12a3 3 0 0 1 3 3v.5M8.5 18H12a3 3 0 0 0 3-3v-.5" /></Svg>
);
export const IconRoute = (p: IconProps) => (
  <Svg {...p}><circle cx="6" cy="19" r="2.5" /><circle cx="18" cy="5" r="2.5" /><path d="M8.5 19H14a4 4 0 0 0 4-4V7.5" /></Svg>
);
export const IconShield = (p: IconProps) => (
  <Svg {...p}><path d="M12 3 19 6v6c0 5-3.5 8-7 9-3.5-1-7-4-7-9V6Z" /><path d="m9 12 2 2 4-4" /></Svg>
);
export const IconCommand = (p: IconProps) => (
  <Svg {...p}><path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z" /></Svg>
);
export const IconCopy = (p: IconProps) => (
  <Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Svg>
);
export const IconCheck = (p: IconProps) => (
  <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>
);
export const IconCheckCircle = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></Svg>
);
export const IconThumbsUp = (p: IconProps) => (
  <Svg {...p}><path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" /><path d="M7 10.5 10.2 3a1.6 1.6 0 0 1 1.5-1h.3A1.8 1.8 0 0 1 13.8 4v4h5.1a2 2 0 0 1 2 2.4l-1.2 7A2 2 0 0 1 17.7 19H7" /></Svg>
);
export const IconThumbsDown = (p: IconProps) => (
  <Svg {...p}><path d="M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1Z" /><path d="M17 13.5 13.8 21a1.6 1.6 0 0 1-1.5 1h-.3A1.8 1.8 0 0 1 10.2 20v-4H5.1a2 2 0 0 1-2-2.4l1.2-7A2 2 0 0 1 6.3 5H17" /></Svg>
);
export const IconDownload = (p: IconProps) => (
  <Svg {...p}><path d="M12 3v12M8 11l4 4 4-4M4 21h16" /></Svg>
);
export const IconClock = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>
);
export const IconCpu = (p: IconProps) => (
  <Svg {...p}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></Svg>
);
export const IconPaperclip = (p: IconProps) => (
  <Svg {...p}><path d="M21.4 11.05 12.2 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></Svg>
);
export const IconArrowUp = (p: IconProps) => (
  <Svg {...p}><path d="M12 19V5M5 12l7-7 7 7" /></Svg>
);
export const IconArrowLeft = (p: IconProps) => (
  <Svg {...p}><path d="M19 12H5M12 19l-7-7 7-7" /></Svg>
);
export const IconSquare = (p: IconProps) => (
  <Svg {...p}><rect x="7" y="7" width="10" height="10" rx="1.6" fill="currentColor" stroke="none" /></Svg>
);
export const IconX = (p: IconProps) => (
  <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>
);
export const IconSparkles = (p: IconProps) => (
  <Svg {...p}><path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" /><path d="M19 15.5 19.8 18l2.5.8-2.5.8L19 22l-.8-2.4-2.5-.8 2.5-.8Z" /></Svg>
);
export const IconTerminal = (p: IconProps) => (
  <Svg {...p}><path d="m4 17 6-5-6-5M12 19h8" /></Svg>
);
export const IconFileText = (p: IconProps) => (
  <Svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></Svg>
);
export const IconFilePen = (p: IconProps) => (
  <Svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 17h4M15.5 13.5l2 2" /></Svg>
);
export const IconGlobe = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z" /></Svg>
);
export const IconBot = (p: IconProps) => (
  <Svg {...p}><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6" /></Svg>
);
export const IconUsers = (p: IconProps) => (
  <Svg {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a5 5 0 0 1 3.5 6" /></Svg>
);
export const IconZap = (p: IconProps) => (
  <Svg {...p}><path d="M13 2 3 14h9l-1 8 10-12h-9Z" /></Svg>
);
export const IconAlert = (p: IconProps) => (
  <Svg {...p}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></Svg>
);
export const IconPin = (p: IconProps) => (
  <Svg {...p}><path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z" /></Svg>
);
export const IconPinOff = (p: IconProps) => (
  <Svg {...p}><path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z" /><path d="m3 3 18 18" /></Svg>
);
export const IconTrash = (p: IconProps) => (
  <Svg {...p}><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" /></Svg>
);
export const IconPencil = (p: IconProps) => (
  <Svg {...p}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></Svg>
);
export const IconExternal = (p: IconProps) => (
  <Svg {...p}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" /></Svg>
);
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}><path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6" /></Svg>
);
export const IconCornerDownLeft = (p: IconProps) => (
  <Svg {...p}><path d="M20 4v7a4 4 0 0 1-4 4H4M9 10l-5 5 5 5" /></Svg>
);
export const IconSlash = (p: IconProps) => (
  <Svg {...p}><path d="M17 4 7 20" /></Svg>
);
export const IconCircleDot = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" /></Svg>
);
export const IconLoader = (p: IconProps) => (
  <Svg {...p}><path d="M21 12a9 9 0 1 1-6.2-8.6" /></Svg>
);
export const IconPanelRight = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M15 4v16" /></Svg>
);
export const IconListFilter = (p: IconProps) => (
  <Svg {...p}><path d="M4 6h16M7 12h10M10 18h4" /></Svg>
);
export const IconHash = (p: IconProps) => (
  <Svg {...p}><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" /></Svg>
);
export const IconKeyboard = (p: IconProps) => (
  <Svg {...p}><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></Svg>
);
