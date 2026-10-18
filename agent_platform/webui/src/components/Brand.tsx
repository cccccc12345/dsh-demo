interface BrandMarkProps {
  size?: number;
  className?: string;
}

/** 官方式黑底白字标记;亮暗主题下由 CSS 变量自动反色。 */
export function BrandMark({ size = 24, className = "" }: BrandMarkProps) {
  return (
    <span
      className={`brand-mark${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" width={Math.round(size * 0.68)} height={Math.round(size * 0.68)}>
        <path
          d="M5.1 18.2 10.7 5.8h2.6l5.6 12.4h-2.8l-1-2.4H8.9l-1 2.4H5.1Zm4.8-4.7h4.2l-2.1-4.9-2.1 4.9Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

interface BrandLockupProps {
  collapsed?: boolean;
  size?: number;
  showBadge?: boolean;
  className?: string;
}

/** 侧边栏/欢迎页共用的 wordmark + HARNESS 徽标。 */
export function BrandLockup({
  collapsed = false,
  size = 24,
  showBadge = true,
  className = "",
}: BrandLockupProps) {
  return (
    <span className={`brand-lockup${collapsed ? " is-collapsed" : ""}${className ? ` ${className}` : ""}`}>
      <BrandMark size={size} />
      {!collapsed && (
        <>
          <span className="brand-wordmark">AgentBox</span>
          {showBadge && <span className="brand-badge">HARNESS</span>}
        </>
      )}
    </span>
  );
}
