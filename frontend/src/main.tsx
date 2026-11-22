import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

// 桌宠窗口在 React 挂载前同步声明 pet-mode，杜绝首帧出现白底
if (new URLSearchParams(window.location.search).get("window") === "pet") {
  document.documentElement.classList.add("pet-mode");
}

// 挂载 React 根组件到 index.html 的 #root 节点
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
