import React from "react";

interface ErrorBoundaryState {
  error: Error | null;
}

/** 顶层渲染兜底:任何 React 渲染异常都显示错误,而不是整页白屏。 */
export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[agent-platform] render error", error, info);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "monospace", lineHeight: 1.6 }}>
          <h2 style={{ marginTop: 0 }}>页面渲染失败</h2>
          <pre style={{ whiteSpace: "pre-wrap", color: "#b42318" }}>{this.state.error.message}</pre>
          <button onClick={() => window.location.reload()}>重新加载</button>
        </div>
      );
    }
    return this.props.children;
  }
}
