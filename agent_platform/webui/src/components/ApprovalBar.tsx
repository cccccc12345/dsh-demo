import type { PendingApproval } from "../types";
import { IconCheck, IconClock, IconShield, IconX } from "./Icons";

interface ApprovalBarProps {
  approvals: PendingApproval[];
  onDecide: (id: string, decision: "approve" | "reject") => void;
}

export function ApprovalBar({ approvals, onDecide }: ApprovalBarProps) {
  if (approvals.length === 0) return null;
  return (
    <div className="approval-bar" role="alert" aria-live="assertive">
      <div className="approval-inner">
        {approvals.length > 1 && (
          <div className="approval-count">
            <IconShield size={14} />
            {approvals.length} 个工具调用等待确认
          </div>
        )}
        {approvals.map((approval) => (
          <div className="approval-card" key={approval.id}>
            <div className="approval-icon">
              <IconShield size={18} />
            </div>
            <div className="approval-main">
              <div className="approval-title">
                需要你的确认
                <code className="approval-tool">{approval.toolName}</code>
              </div>
              {approval.reason && <div className="approval-reason">{approval.reason}</div>}
              <div className="approval-hint">
                <IconClock size={12} />
                批准仅对本次工具调用生效
                {approval.timeoutSeconds
                  ? ` · ${approval.timeoutSeconds} 秒内未处理会自动拒绝`
                  : " · 超时会自动拒绝"}
              </div>
            </div>
            <div className="approval-actions">
              <button
                type="button"
                className="approval-btn is-reject"
                onClick={() => onDecide(approval.id, "reject")}
              >
                <IconX size={14} />
                拒绝
              </button>
              <button
                type="button"
                className="approval-btn is-approve"
                onClick={() => onDecide(approval.id, "approve")}
              >
                <IconCheck size={14} />
                允许一次
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
