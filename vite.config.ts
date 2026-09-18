import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";

export default defineConfig(({ command }) => ({
  root: "src",
  plugins: [
    command === "serve" &&
      codeInspectorPlugin({
        bundler: "vite",
      }),
    react(),
  ].filter(Boolean),
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // 主应用窗口
        main: path.resolve(__dirname, "src/index.html"),
        // agent 完成提示窗口（独立 webview，仅渲染通知卡片）
        notify: path.resolve(__dirname, "src/notify.html"),
      },
    },
  },
  server: {
    port: 3000,
    strictPort: true,
    // 必须显式 host:true：默认只绑 IPv6([::1])，而 WKWebView 解析 localhost
    // 可能走 IPv4(127.0.0.1)，连接失败会让 Tauri 静默回退到 dist 旧产物，
    // 表现为"改了代码窗口没变化"。
    host: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
}));

