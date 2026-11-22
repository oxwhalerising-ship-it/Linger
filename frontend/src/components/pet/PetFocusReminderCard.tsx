/**
 * 番茄钟完成 / 休息完毕智能互动气泡卡（PetFocusReminderCard）
 * ---------------------------------------------------------
 * 悬浮在右上角还原后的灵儿头顶：
 * - break-alert：展示 LLM 按任务内容随机生成的台湾腔休息建议，提供「好哒去休息」「跳过休息」「再来一轮」
 * - next-round-prompt：展示休息完毕的随机鼓励询问，提供「再来一轮（N分）」「先休息啦」
 */

import { formatClock } from "../../services/focusClock";

export interface FocusReminderView {
  kind: "break-alert" | "next-round-prompt";
  reply: string;
  suggestionTag: string;
  taskTitle: string;
  focusMinutes: number;
  round: number;
  loading: boolean;
}

interface PetFocusReminderCardProps {
  reminder: FocusReminderView;
  breakRemaining?: number;
  onAcceptBreak: () => void;
  onSkipBreak: () => void;
  onStartNextRound: () => void;
  onFinishAll: () => void;
}

export default function PetFocusReminderCard({
  reminder,
  breakRemaining = 0,
  onAcceptBreak,
  onSkipBreak,
  onStartNextRound,
  onFinishAll,
}: PetFocusReminderCardProps) {
  const isBreakAlert = reminder.kind === "break-alert";

  return (
    <div className="w-[336px] px-1 pt-0.5 animate-bubble-pop">
      <div className="apple-sheet relative w-full rounded-[22px] px-3.5 py-2.5">
        {/* 顶部轻量标签行 */}
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-[-0.01em] ${
                isBreakAlert
                  ? "bg-[rgba(255,59,48,0.12)] text-[#ff3b30]"
                  : "bg-[rgba(52,199,89,0.14)] text-[#248a3d]"
              }`}
            >
              {isBreakAlert
                ? `🍅 第 ${Math.max(1, reminder.round)} 轮完成`
                : "✨ 休息完毕"}
            </span>
            {reminder.suggestionTag && (
              <span className="truncate px-1.5 py-0.5 rounded-full text-[11px] font-medium apple-well apple-caption">
                {reminder.suggestionTag}
              </span>
            )}
          </div>
          {isBreakAlert && breakRemaining > 0 && (
            <span className="shrink-0 text-[12px] font-semibold text-[#248a3d] tabular-nums tracking-[-0.03em]">
              ☕ {formatClock(breakRemaining)}
            </span>
          )}
        </div>

        {/* 灵儿智能随机生成的暖心台湾腔文案 */}
        {reminder.loading ? (
          <div className="py-1.5 space-y-1.5">
            <div className="h-3.5 w-4/5 rounded-full bg-black/8 animate-pulse" />
            <div className="h-3.5 w-3/5 rounded-full bg-black/5 animate-pulse" />
          </div>
        ) : (
          <p className="text-[14px] leading-[1.4] font-medium tracking-[-0.016em] text-[#1d1d1f] break-words">
            {reminder.reply}
          </p>
        )}

        {/* 快捷操作按钮行 */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {isBreakAlert ? (
            <>
              <button
                type="button"
                onClick={onAcceptBreak}
                className="apple-btn apple-btn-fill px-3 py-1 text-[12px] cursor-pointer"
              >
                好哒，去休息
              </button>
              <button
                type="button"
                onClick={onStartNextRound}
                className="apple-btn apple-btn-plain px-2.5 py-1 text-[12px] cursor-pointer"
              >
                再来一轮
              </button>
              <button
                type="button"
                onClick={onSkipBreak}
                className="apple-btn apple-btn-plain px-2.5 py-1 text-[12px] cursor-pointer"
              >
                先结束啦
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onStartNextRound}
                className="apple-btn apple-btn-fill px-3.5 py-1 text-[12px] cursor-pointer"
              >
                再来一轮（{reminder.focusMinutes}分）
              </button>
              <button
                type="button"
                onClick={onFinishAll}
                className="apple-btn apple-btn-plain px-3 py-1 text-[12px] cursor-pointer"
              >
                先休息啦
              </button>
            </>
          )}
        </div>

        {/* 指向灵儿头顶的磨砂气泡小尖角 */}
        <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rotate-45 bg-white/90" />
      </div>
    </div>
  );
}
