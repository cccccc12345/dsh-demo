import { IconAlert, IconCheckCircle, IconSparkles, IconX } from "./Icons";

export interface ToastState {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

interface ToastProps {
  toast: ToastState | null;
  onClose: () => void;
}

export function Toast({ toast, onClose }: ToastProps) {
  if (!toast) return null;
  return (
    <div className={`toast is-${toast.kind}`} role="status" aria-live="polite">
      <span className="toast-icon">
        {toast.kind === "success" ? (
          <IconCheckCircle size={16} />
        ) : toast.kind === "error" ? (
          <IconAlert size={16} />
        ) : (
          <IconSparkles size={16} />
        )}
      </span>
      <span className="toast-text">{toast.text}</span>
      <button type="button" className="toast-close" onClick={onClose} aria-label="关闭提示">
        <IconX size={13} />
      </button>
    </div>
  );
}
