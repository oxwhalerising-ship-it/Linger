/**
 * 前端双窗口路由入口（按窗口模式代码分割，避免桌宠窗口加载整套控制台代码）
 * -----------------------------------------------------------------------
 * - `?window=pet`：Windows 透明无边框置顶桌宠浮窗（PetWindow）
 * - `?window=dashboard`（或默认）：苹果风主控面板（DashboardLayout）
 */

import { lazy, Suspense } from "react";

const PetWindow = lazy(() => import("./components/pet/PetWindow"));
const DashboardLayout = lazy(
  () => import("./components/dashboard/DashboardLayout"),
);

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const windowMode = params.get("window");

  if (windowMode === "pet") {
    return (
      <Suspense fallback={null}>
        <PetWindow />
      </Suspense>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="h-screen w-screen flex items-center justify-center bg-[var(--bg-canvas)] text-sm text-[var(--text-muted)]">
          正在唤醒灵儿控制台…
        </div>
      }
    >
      <DashboardLayout />
    </Suspense>
  );
}
