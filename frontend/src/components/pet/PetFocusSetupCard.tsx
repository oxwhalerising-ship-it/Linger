/**
 * 桌宠三步式番茄时钟配置卡（PetFocusSetupCard）
 * ---------------------------------------------
 * 点击灵儿环绕菜单的「番茄时钟」图标后弹出：
 * Step 1 · 设置多长时间（快捷档位 15/25/45/60 + 自定义 1~180 分钟 + 番茄/正计时）
 * Step 2 · 进行什么任务（从今日待办快选 或 直接输入任务名，可留空）
 * Step 3 · 确认开启（展示本次专注摘要，点击确认后灵儿抱起番茄升空至主屏右上角！）
 */

import { useEffect, useState } from "react";
import { api, formatLocalDate, type TaskItem } from "../../services/api";
import type { FocusMode } from "../../services/focusClock";
import { playPetSound } from "../../services/petSoundEffects";

export interface FocusSetupResult {
  mode: FocusMode;
  minutes: number;
  taskId: number | null;
  taskTitle: string;
  finishTask: boolean;
}

interface PetFocusSetupCardProps {
  initialMinutes?: number;
  dndEnabled?: boolean;
  onConfirm: (setup: FocusSetupResult) => void;
  onClose: () => void;
}

const DURATION_CHIPS = [15, 25, 45, 60] as const;

export default function PetFocusSetupCard({
  initialMinutes = 25,
  dndEnabled = false,
  onConfirm,
  onClose,
}: PetFocusSetupCardProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [mode, setMode] = useState<FocusMode>("pomodoro");
  const [minutes, setMinutes] = useState<number>(
    Math.max(1, Math.min(180, Math.round(initialMinutes || 25))),
  );
  const [customInput, setCustomInput] = useState<string>(
    String(Math.max(1, Math.min(180, Math.round(initialMinutes || 25)))),
  );
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [taskTitle, setTaskTitle] = useState<string>("");
  const [finishTask, setFinishTask] = useState<boolean>(false);

  useEffect(() => {
    let live = true;
    void api
      .listTasks("today", formatLocalDate())
      .then((list) => {
        if (live) setTasks(list.slice(0, 6));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const applyMinutes = (val: number) => {
    const clamped = Math.max(1, Math.min(180, Math.round(val)));
    setMinutes(clamped);
    setCustomInput(String(clamped));
  };

  const handleCustomChange = (raw: string) => {
    const digits = raw.replace(/[^\d]/g, "").slice(0, 3);
    setCustomInput(digits);
    if (digits) {
      const n = Number(digits);
      if (Number.isFinite(n) && n >= 1) {
        setMinutes(Math.min(180, n));
      }
    }
  };

  const goStep = (next: 1 | 2 | 3) => {
    playPetSound("dispatch", { muted: dndEnabled });
    setStep(next);
  };

  const handleConfirm = () => {
    onConfirm({
      mode,
      minutes: Math.max(1, Math.min(180, minutes)),
      taskId: selectedTaskId,
      taskTitle: taskTitle.trim(),
      finishTask: selectedTaskId != null && finishTask,
    });
  };

  return (
    <div
      className="apple-sheet w-[316px] rounded-[22px] p-3.5 animate-bubble-pop select-none"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* 顶部标题 + 三步进度点 + 关闭 */}
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[14px]">🍅</span>
          <span className="text-[13px] font-semibold tracking-[-0.02em] text-[#1d1d1f]">
            {step === 1
              ? "设置专注时长"
              : step === 2
                ? "这轮做什么任务？"
                : "准备抱起番茄起飞"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1" aria-label={`第 ${step} 步，共 3 步`}>
            {([1, 2, 3] as const).map((idx) => (
              <span
                key={idx}
                className={`h-1.5 rounded-full transition-all duration-200 ${
                  idx === step
                    ? "w-4 bg-[#0071e3]"
                    : idx < step
                      ? "w-1.5 bg-sky-400"
                      : "w-1.5 bg-slate-200"
                }`}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭番茄配置"
            className="w-5 h-5 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-600 text-[12px] cursor-pointer"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Step 1: 设置多长时间 */}
      {step === 1 && (
        <div className="space-y-2.5">
          {/* 计时模式小切换 */}
          <div className="grid grid-cols-2 gap-0.5 p-0.5 rounded-full apple-well text-[12px] font-medium">
            <button
              type="button"
              onClick={() => setMode("pomodoro")}
              className={`apple-btn py-1 rounded-full cursor-pointer ${
                mode === "pomodoro"
                  ? "bg-white text-[#1d1d1f] shadow-[0_1px_3px_rgba(0,0,0,0.12)] font-semibold"
                  : "text-[rgba(60,60,67,0.7)]"
              }`}
            >
              番茄倒计时
            </button>
            <button
              type="button"
              onClick={() => setMode("stopwatch")}
              className={`apple-btn py-1 rounded-full cursor-pointer ${
                mode === "stopwatch"
                  ? "bg-white text-[#1d1d1f] shadow-[0_1px_3px_rgba(0,0,0,0.12)] font-semibold"
                  : "text-[rgba(60,60,67,0.7)]"
              }`}
            >
              自由正计时
            </button>
          </div>

          {mode === "pomodoro" ? (
            <>
              <div className="grid grid-cols-4 gap-1.5">
                {DURATION_CHIPS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => applyMinutes(m)}
                    className={`apple-btn py-1.5 text-[12px] font-semibold cursor-pointer ${
                      minutes === m ? "apple-btn-fill" : "apple-btn-plain"
                    }`}
                  >
                    {m}分
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-2xl apple-well">
                <span className="text-[12px] apple-caption">自定义分钟</span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => applyMinutes(minutes - 5)}
                    className="w-6 h-6 rounded-lg bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 text-[13px] font-semibold cursor-pointer"
                  >
                    -
                  </button>
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label="自定义专注分钟数"
                    value={customInput}
                    onChange={(e) => handleCustomChange(e.target.value)}
                    onBlur={() => setCustomInput(String(minutes))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") goStep(2);
                    }}
                    className="w-11 text-center text-[15px] font-semibold tracking-[-0.03em] tabular-nums text-[#1d1d1f] bg-white rounded-lg py-0.5 focus:outline-none focus:shadow-[0_0_0_3px_rgba(0,113,227,0.28)]"
                  />
                  <span className="text-[11px] text-slate-500">分</span>
                  <button
                    type="button"
                    onClick={() => applyMinutes(minutes + 5)}
                    className="w-6 h-6 rounded-lg bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 text-[13px] font-semibold cursor-pointer"
                  >
                    +
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="text-[12.5px] apple-caption apple-well px-3 py-2">
              从 00:00 开始正向计时，想停的时候随时点击结束，灵儿会自动帮你记录本次专注时长喔～
            </p>
          )}

          <div className="flex justify-end pt-0.5">
            <button
              type="button"
              onClick={() => goStep(2)}
              className="apple-btn apple-btn-fill px-4 py-1.5 text-[13px] cursor-pointer"
            >
              下一步：选任务 →
            </button>
          </div>
        </div>
      )}

      {/* Step 2: 进行什么任务 */}
      {step === 2 && (
        <div className="space-y-2.5">
          <input
            type="text"
            autoFocus
            maxLength={60}
            value={taskTitle}
            onChange={(e) => {
              setTaskTitle(e.target.value);
              setSelectedTaskId(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") goStep(3);
            }}
            placeholder="输入想专注的事（可留空，如写周报、看书）"
            className="w-full px-3 py-2 rounded-xl apple-well text-[13px] text-[#1d1d1f] placeholder:text-[rgba(60,60,67,0.45)] focus:outline-none focus:bg-white focus:shadow-[0_0_0_3px_rgba(0,113,227,0.28)]"
          />

          {tasks.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10.5px] text-slate-400">快速选一个今日待办：</div>
              <div className="flex flex-wrap gap-1.5 max-h-[62px] overflow-y-auto">
                {tasks.map((task) => {
                  const active = selectedTaskId === task.id;
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => {
                        if (active) {
                          setSelectedTaskId(null);
                          setTaskTitle("");
                        } else {
                          setSelectedTaskId(task.id);
                          setTaskTitle(task.title);
                        }
                      }}
                      className={`apple-btn max-w-[136px] truncate px-2.5 py-1 text-[12px] cursor-pointer ${
                        active ? "apple-btn-fill" : "apple-btn-plain"
                      }`}
                    >
                      {task.title}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {mode === "pomodoro" && selectedTaskId != null && (
            <label className="flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={finishTask}
                onChange={(e) => setFinishTask(e.target.checked)}
                className="rounded accent-rose-500"
              />
              <span>这一轮结束自动把该任务勾为完成</span>
            </label>
          )}

          <div className="flex items-center justify-between pt-0.5">
            <button
              type="button"
              onClick={() => goStep(1)}
              className="apple-btn apple-btn-plain px-3 py-1.5 text-[12px] cursor-pointer"
            >
              ← 上一步
            </button>
            <button
              type="button"
              onClick={() => goStep(3)}
              className="apple-btn apple-btn-fill px-4 py-1.5 text-[13px] cursor-pointer"
            >
              下一步：确认 →
            </button>
          </div>
        </div>
      )}

      {/* Step 3: 确认开始 */}
      {step === 3 && (
        <div className="space-y-2.5">
          <div className="rounded-2xl apple-well px-3 py-2.5 flex items-center gap-3">
            <div className="w-11 h-11 rounded-full bg-[#ff3b30] text-white flex flex-col items-center justify-center shrink-0">
              <span className="text-[11px] leading-none">🍅</span>
              <span className="font-mono text-[11px] font-bold leading-tight mt-0.5">
                {mode === "stopwatch" ? "正计" : `${minutes}m`}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold tracking-[-0.02em] text-[#1d1d1f] truncate">
                {taskTitle.trim() || "自由专注时光"}
              </div>
              <div className="text-[12px] apple-caption mt-0.5">
                {mode === "stopwatch"
                  ? "灵儿会抱着番茄钟飞到右上角陪你正计时～"
                  : `灵儿会抱着 ${minutes} 分钟番茄钟飞到右上角坐着陪你～`}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-0.5">
            <button
              type="button"
              onClick={() => goStep(2)}
              className="apple-btn apple-btn-plain px-3 py-1.5 text-[12px] cursor-pointer"
            >
              ← 修改
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              className="apple-btn apple-btn-fill px-4 py-1.5 text-[13px] cursor-pointer"
            >
              确认开始！
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
