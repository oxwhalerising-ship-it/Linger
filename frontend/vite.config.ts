import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite 构建配置：集成 React 与 Tailwind CSS v4，使用相对路径方便 Electron 打包加载
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
