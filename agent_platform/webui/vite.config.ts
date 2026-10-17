import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 产物直接打进 agent_platform/static/,由 FastAPI 的 StaticFiles + GET / 提供。
// base 定为 /static/,保证 index.html 里资源引用带上该前缀。
export default defineConfig({
  base: "/static/",
  plugins: [react()],
  build: {
    outDir: "../static",
    // 保留旧 hash 资源:浏览器里的旧 index.html 可能仍引用上一版 index-*.js,
    // 删掉旧文件会导致 404 + 白屏。新构建只追加,不清理旧 hash。
    emptyOutDir: false,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"],
          markdown: ["marked", "dompurify", "highlight.js"],
        },
      },
    },
  },
  server: {
    port: 5199,
    proxy: {
      // 本地 dev 时把 API 与静态资源代理到 uvicorn
      "/api": "http://127.0.0.1:8765",
      "/static": "http://127.0.0.1:8765",
    },
  },
});
