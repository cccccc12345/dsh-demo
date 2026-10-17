import type { PendingApproval } from "../types";

interface ApprovalBarProps {
  approvals: PendingApproval[];
  onDecide: (id: string, decision: "approve" | "reject") => void;
}

export function ApprovalBar({ approvals, onDecide }: ApprovalBarProps) {
  if (approvals.length === 0) return null;
  return (
    <div className="approval-bar">
      <div className="approval-inner">
        {approvals.map((approval) => (
          <div className="approval-card" key={approval.id}>
            <div className="approval-icon">🛡️</div>
            <div className="approval-main">
              <div className="approval-title">
                人工审批 · <code>{approval.toolName}</code>
              </div>
              {approval.reason && <div className="approval-reason">{approval.reason}</div>}
              <div className="approval-hint">
                批准仅对本次工具调用生效;{approval.timeoutSeconds ? ` ${approval.timeoutSeconds} 秒内未处理会自动拒绝。` : "超时自动拒绝。"}
              </div>
            </div>
            <div className="approval-actions">
              <button className="approval-btn reject" onClick={() => onDecide(approval.id, "reject")}>
                拒绝
              </button>
              <button className="approval-btn approve" onClick={() => onDecide(approval.id, "approve")}>
                批准一次
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
