import React from "react";
import ReactDOM from "react-dom/client";
import { NotifyCard } from "@/agent-notify/NotifyCard";
import { FrontendErrorBoundary } from "@/components/FrontendErrorBoundary";
// 独立 webview 不共享主窗口的模块图，i18n 必须在这里重新初始化。
import "./i18n";
import "./index.css";

// 提示窗口是独立 webview：只装载通知卡片，不引入主应用的路由与查询层。
try {
  const isMac = /mac/i.test(navigator.userAgent || "");
  if (isMac) {
    document.body.classList.add("is-mac");
  }
} catch {
  // 平台检测失败不影响渲染
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FrontendErrorBoundary>
      <NotifyCard />
    </FrontendErrorBoundary>
  </React.StrictMode>,
);
