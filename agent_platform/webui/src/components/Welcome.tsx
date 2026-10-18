import { BrandMark } from "./Brand";

interface WelcomeProps {
  mock: boolean;
}

export function Welcome({ mock }: WelcomeProps) {
  return (
    <div className="welcome">
      <div className="welcome-brand">
        <BrandMark size={34} />
        <span className="welcome-wordmark">AgentBox</span>
        <span className="welcome-tagline">探索未至之境</span>
        <span className="preview-badge">预览版</span>
      </div>
      <p className="welcome-sub">
        {mock
          ? "服务运行在 Mock 模式,发送消息体验完整交互流程"
          : "多会话 Agent 工作台 · 工具调用 · 人工审批 · 团队流水线"}
      </p>
    </div>
  );
}
