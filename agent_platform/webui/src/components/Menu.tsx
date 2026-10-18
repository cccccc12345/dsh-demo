import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { IconCheck } from "./Icons";

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  description?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  items: MenuItem[];
  onClose: () => void;
  className?: string;
  style?: CSSProperties;
}

export function Menu({ items, onClose, className = "", style }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className={`menu${className ? ` ${className}` : ""}`}
      role="menu"
      style={style}
    >
      {items.map((item) => (
        <div key={item.id}>
          {item.separatorBefore && <div className="menu-separator" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`menu-item${item.danger ? " is-danger" : ""}${item.checked ? " is-checked" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            <span className="menu-icon">{item.icon}</span>
            <span className="menu-copy">
              <span className="menu-label">{item.label}</span>
              {item.description && <span className="menu-description">{item.description}</span>}
            </span>
            {item.checked && <IconCheck size={14} className="menu-check" />}
            {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}
