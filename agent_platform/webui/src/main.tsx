import "./styles/vendor/fonts/brand-font.css";
import "./styles/vendor/base.css";
import "./styles/vendor/design-platform.css";
import "./styles/vendor/focus.css";
import "./styles/vendor/scrollbar.css";
import "./styles/vendor/corner-shape.css";
import "./styles/app.css";

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

document.documentElement.setAttribute("data-platform", navigator.platform.toLowerCase().includes("mac") ? "darwin" : "other");

window.addEventListener("unhandledrejection", (event) => {
  console.error("[agent-platform] unhandled rejection", event.reason);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
