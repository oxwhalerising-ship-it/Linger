/**
 * 主屏右上角「灵儿坐地抱着立体番茄时钟」悬浮陪伴视图（PetFocusWidget）
 * -------------------------------------------------------------------
 * - 灵儿落地后稳稳坐在柔和晶云底影上，双腿自然向前轻晃，双臂一直抱着怀里的 3D 立体大番茄倒计时时钟
 * - 番茄肚子上就是超清晰的实时倒计时数字与消耗进度光弧；茶歇期柔和切换为薄荷茶歇番茄
 * - 平时极简清爽只展示坐着的灵儿 + 可选短任务标签；鼠标悬停时灵儿抬头看你并浮现迷你快捷控制条
 * - 支持按住灵儿或番茄轻拖微调位置，不打断计时
 */

import { useEffect, useRef, useState } from "react";
import {
  formatClock,
  pauseFocus,
  skipBreak,
  startFocus,
  stopFocus,
  type FocusSnapshot,
} from "../../services/focusClock";
import type { AvatarConfig, PetEmotion } from "../../types/pet";
import AvatarRenderer from "./AvatarRenderer";

interface PetFocusWidgetProps {
  clock: FocusSnapshot;
  avatarConfig: AvatarConfig;
  dndEnabled: boolean;
  /** 刚抵达右上角时播放约 380ms 落地缓冲坐下动画 */
  justLanded?: boolean;
  onStopAndReturn: () => void;
  onSkipBreak: () => void;
  onOpenPanel: () => void;
}

export default function PetFocusWidget({
  clock,
  avatarConfig,
  dndEnabled,
  justLanded = false,
  onStopAndReturn,
  onSkipBreak,
  onOpenPanel,
}: PetFocusWidgetProps) {
  const [hovered, setHovered] = useState(false);
  const [landingPhase, setLandingPhase] = useState(justLanded);
  const draggingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!justLanded) {
      setLandingPhase(false);
      return;
    }
    setLandingPhase(true);
    const timer = window.setTimeout(() => setLandingPhase(false), 400);
    return () => window.clearTimeout(timer);
  }, [justLanded]);

  const onBreak = clock.phase === "short" || clock.phase === "long";
  const isStopwatch = clock.mode === "stopwatch" && !onBreak;
  const progress = isStopwatch
    ? 1
    : clock.planned > 0
      ? Math.max(0, Math.min(1, clock.remaining / clock.planned))
      : 1;

  const seatedEmotion: PetEmotion = onBreak
    ? "relieved"
    : !clock.running
      ? "curious"
      : hovered
        ? "happy"
        : "encouraging";

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    draggingRef.current = true;
    pointerIdRef.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    window.taiwanBotEnv?.startPetDrag?.();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || pointerIdRef.current !== e.pointerId) return;
    window.taiwanBotEnv?.updatePetDrag?.();
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || pointerIdRef.current !== e.pointerId) return;
    draggingRef.current = false;
    pointerIdRef.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
    window.taiwanBotEnv?.endPetDrag?.();
  };

  const handleToggleRun = () => {
    if (clock.running) pauseFocus();
    else startFocus();
  };

  const handleStop = () => {
    if (onBreak) {
      skipBreak();
      onSkipBreak();
    } else {
      stopFocus();
      onStopAndReturn();
    }
  };

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className="relative flex flex-col items-center justify-end w-[238px] h-[274px] pb-1.5 select-none cursor-grab active:cursor-grabbing"
    >
      {/* 坐在地上抱着立体番茄倒计时时钟的灵儿本体 */}
      <div className="relative flex items-center justify-center">
        <AvatarRenderer
          emotion={seatedEmotion}
          config={avatarConfig}
          size={198}
          dndEnabled={dndEnabled}
          lookTarget={hovered ? { x: 0, y: -0.22 } : null}
          tomatoClock={{
            stage: landingPhase ? "landing" : "sitting",
            timeText: formatClock(clock.remaining),
            progress,
            running: clock.running,
            onBreak,
            isStopwatch,
          }}
          cleanMode={true}
        />
      </div>

      {/* 底部信息与悬停控制区：平时仅低调显示任务名/轮次，悬停平滑切换为快捷控制条 */}
      <div className="relative h-[30px] w-full flex items-center justify-center mt-0.5">
        {/* 非悬停态：轻量任务名 + 轮次胶囊 */}
        <div
          className={`apple-sheet absolute flex items-center gap-1.5 px-2.5 py-0.5 rounded-full transition-opacity duration-200 ${
            hovered ? "opacity-0 pointer-events-none" : "opacity-100"
          }`}
        >
          <span className="text-[11px] font-semibold tracking-[-0.01em] text-[#1d1d1f] shrink-0">
            {onBreak
              ? "☕ 茶歇"
              : isStopwatch
                ? "⏱️ 正计时"
                : `🍅 第${Math.max(1, clock.round + 1)}轮`}
          </span>
          {clock.taskTitle && (
            <>
              <span className="text-black/25">·</span>
              <span
                title={clock.taskTitle}
                className="max-w-[116px] truncate text-[11px] font-medium text-[#1d1d1f]"
              >
                {clock.taskTitle}
              </span>
            </>
          )}
        </div>

        {/* 悬停态：轻盈快捷控制条 */}
        <div
          className={`apple-sheet absolute flex items-center gap-1.5 px-2 py-1 rounded-full transition-opacity duration-200 ${
            hovered
              ? "opacity-100 pointer-events-auto"
              : "opacity-0 pointer-events-none"
          }`}
        >
          <button
            type="button"
            onClick={handleToggleRun}
            className="apple-btn apple-btn-fill px-2.5 py-0.5 text-[12px] cursor-pointer"
          >
            {clock.running ? "暂停" : "继续"}
          </button>
          <button
            type="button"
            onClick={handleStop}
            className="apple-btn apple-btn-plain px-2 py-0.5 text-[12px] cursor-pointer"
          >
            {onBreak ? "跳过休息" : "结束"}
          </button>
          <button
            type="button"
            onClick={onOpenPanel}
            className="apple-btn apple-btn-plain px-2 py-0.5 text-[12px] cursor-pointer"
          >
            面板
          </button>
        </div>
      </div>
    </div>
  );
}
