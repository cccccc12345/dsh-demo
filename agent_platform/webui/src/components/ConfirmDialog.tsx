import { useEffect } from "react";
import { IconAlert } from "./Icons";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="modal-layer is-confirm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className={danger ? "confirm-icon is-danger" : "confirm-icon"}>
          <IconAlert size={20} />
        </div>
        <div className="confirm-copy">
          <h2>{title}</h2>
          <p>{message}</p>
        </div>
        <div className="confirm-actions">
          <button type="button" className="ghost-btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? "danger-btn is-solid" : "primary-btn"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
