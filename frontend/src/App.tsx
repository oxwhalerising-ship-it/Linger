/**
 * 前端双窗口路由入口（Step 5 升级为苹果风完整主控面板）
 * ----------------------------------------------------
 * - `?window=pet`：Windows 透明无边框置顶桌宠浮窗（PetWindow）
 * - `?window=dashboard`（或默认）：苹果风主控面板（DashboardLayout）
 */

import DashboardLayout from "./components/dashboard/DashboardLayout";
import PetWindow from "./components/pet/PetWindow";

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const windowMode = params.get("window");

  if (windowMode === "pet") {
    return <PetWindow />;
  }

  return <DashboardLayout />;
}
