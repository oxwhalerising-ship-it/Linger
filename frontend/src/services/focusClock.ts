/**
 * 番茄钟停在本机，切页和刷新都接着走。
 * 一轮结束才写进本地日记库；同一次结束用 client_id，避免重试记成两个番茄。
 */

import { useSyncExternalStore } from "react";

export type FocusPhase = "idle" | "focus" | "short" | "long";
export type FocusMinutes = number;
export type FocusMode = "pomodoro" | "stopwatch";

export const PRESET_FOCUS_MINUTES = [15, 25, 45] as const;

export interface FocusControlCommand {
  action: "start" | "pause" | "resume" | "stop" | "skip_break" | "status";
  mode?: FocusMode;
  minutes?: number;
  task_id?: number | null;
  task_title?: string;
  finish_task?: boolean;
  force?: boolean;
  open_panel?: boolean;
}

export interface FocusControlOutcome {
  ok: boolean;
  conflict?: boolean;
  error?: string;
  state: FocusSnapshot;
}

function clampFocusMinutes(raw: unknown): number {
  const num = Number(raw);
  if (!Number.isFinite(num)) return 25;
  return Math.max(1, Math.min(180, Math.round(num)));
}

export interface FocusReport {
  client_id: string;
  task_id: number | null;
  kind: "focus" | "break";
  planned_seconds: number;
  actual_seconds: number;
  started_at: string;
  session_date: string;
  completed: boolean;
  finish_task: boolean;
}

export interface FocusSnapshot {
  mode: FocusMode;
  phase: FocusPhase;
  running: boolean;
  remaining: number;
  planned: number;
  taskId: number | null;
  taskTitle: string;
  focusMinutes: FocusMinutes;
  round: number;
  finishTask: boolean;
  pending: number;
}

export interface FocusLifecycleEvent {
  id: string;
  type: "focus_completed" | "break_completed";
  taskTitle: string;
  focusMinutes: number;
  round: number;
  breakType: "short" | "long";
  mode: FocusMode;
}

interface ClockState extends Omit<FocusSnapshot, "pending" | "remaining"> {
  remaining: number;
  endsAt: number | null;
  runAt: number | null;
  startedAt: string;
  sessionDate: string;
  queue: FocusReport[];
  lastEvent?: FocusLifecycleEvent | null;
  taskFinished?: boolean;
}

const STORAGE = "linger.focus.v1";
const BREAKS = { short: 5 * 60, long: 15 * 60 };

function todayStamp(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function defaults(): ClockState {
  return {
    mode: "pomodoro",
    phase: "idle",
    running: false,
    remaining: 25 * 60,
    planned: 25 * 60,
    endsAt: null,
    runAt: null,
    startedAt: "",
    sessionDate: "",
    taskId: null,
    taskTitle: "",
    focusMinutes: 25,
    round: 0,
    finishTask: false,
    queue: [],
    lastEvent: null,
    taskFinished: false,
  };
}

function read(): ClockState {
  const base = defaults();
  try {
    if (typeof localStorage === "undefined") return base;
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<ClockState>;
    return {
      ...base,
      ...saved,
      queue: Array.isArray(saved.queue) ? saved.queue : [],
      mode: saved.mode === "stopwatch" ? "stopwatch" : "pomodoro",
      focusMinutes: saved.focusMinutes != null ? clampFocusMinutes(saved.focusMinutes) : 25,
    };
  } catch {
    return base;
  }
}

let state = read();
let snapshot = toSnapshot(state);
let ticker = 0;
let settling = false;
let flushing = false;
let audio: AudioContext | null = null;
let sink: ((item: FocusReport) => Promise<void>) | null = null;
const listeners = new Set<() => void>();
const lifecycleListeners = new Set<(event: FocusLifecycleEvent) => void>();
let lastEmittedEventId = state.lastEvent?.id ?? "";

function emitLifecycleIfNew(evt: FocusLifecycleEvent | null | undefined) {
  if (!evt || !evt.id || evt.id === lastEmittedEventId) return;
  lastEmittedEventId = evt.id;
  lifecycleListeners.forEach((fn) => {
    try {
      fn(evt);
    } catch {
      // ignore listener errors
    }
  });
}

function broadcastStateToPeer() {
  try {
    const { queue: _omitQueue, ...syncPayload } = state;
    window.taiwanBotEnv?.syncFocusState?.(syncPayload as unknown as Record<string, unknown>);
  } catch {
    // ignore in non-Electron browser
  }
}

function applyExternalState(raw: Partial<ClockState>) {
  if (!raw || typeof raw !== "object") return;
  const next: ClockState = {
    ...state,
    ...raw,
    // 保留本窗口自己的待上传队列，防止跨窗口覆盖丢失离线补传记录
    queue: state.queue,
    mode: raw.mode === "stopwatch" ? "stopwatch" : "pomodoro",
    focusMinutes: raw.focusMinutes != null ? clampFocusMinutes(raw.focusMinutes) : state.focusMinutes,
  };
  state = next;
  if (state.running) ensureTicker();
  publish();
  emitLifecycleIfNew(state.lastEvent);
}

function currentRemaining() {
  if (state.running && state.endsAt) return Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000));
  return state.remaining;
}

function currentShown() {
  if (state.mode === "stopwatch" && state.phase === "focus") {
    if (state.running && state.runAt) return state.remaining + Math.floor((Date.now() - state.runAt) / 1000);
    return state.remaining;
  }
  return currentRemaining();
}

function toSnapshot(source: ClockState): FocusSnapshot {
  return {
    mode: source.mode,
    phase: source.phase,
    running: source.running,
    remaining: source.phase === state.phase && source.running ? currentRemaining() : source.remaining,
    planned: source.planned,
    taskId: source.taskId,
    taskTitle: source.taskTitle,
    focusMinutes: source.focusMinutes,
    round: source.round,
    finishTask: source.finishTask,
    pending: source.queue.length,
  };
}

function publish() {
  const next = { ...toSnapshot(state), remaining: currentShown() };
  snapshot = next;
  listeners.forEach((fn) => fn());
}

function persist(broadcast = false) {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(state));
  } catch {
    /* 本机存不下倒计时时，这一轮仍然可以走完 */
  }
  if (broadcast) {
    broadcastStateToPeer();
  }
}

function armAudio() {
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch {
    audio = null;
  }
}

function chime(high: boolean) {
  if (!audio) return;
  try {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = high ? 660 : 440;
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.04, audio.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.36);
  } catch {
    /* 没有声音也不影响这一轮已经结束 */
  }
}

function ensureTicker() {
  if (ticker || typeof window === "undefined") return;
  ticker = window.setInterval(tick, 250);
}

function idleClock() {
  if (state.mode === "stopwatch") return { planned: 0, remaining: 0 };
  const planned = state.focusMinutes * 60;
  return { planned, remaining: planned };
}

function goIdle(lifecycleEvent?: FocusLifecycleEvent | null) {
  state = {
    ...state,
    phase: "idle",
    running: false,
    endsAt: null,
    runAt: null,
    ...idleClock(),
    startedAt: "",
    sessionDate: "",
    ...(lifecycleEvent !== undefined ? { lastEvent: lifecycleEvent } : {}),
  };
  persist(true);
  publish();
  if (lifecycleEvent) emitLifecycleIfNew(lifecycleEvent);
}

function beginBreak(phase: "short" | "long", round: number, lifecycleEvent?: FocusLifecycleEvent | null) {
  const planned = BREAKS[phase];
  state = {
    ...state,
    phase,
    round,
    running: true,
    planned,
    remaining: planned,
    startedAt: new Date().toISOString(),
    sessionDate: todayStamp(),
    endsAt: Date.now() + planned * 1000,
    ...(lifecycleEvent !== undefined ? { lastEvent: lifecycleEvent } : {}),
  };
  persist(true);
  ensureTicker();
  publish();
  if (lifecycleEvent) emitLifecycleIfNew(lifecycleEvent);
}

function enqueue(natural: boolean) {
  const actual = natural ? state.planned : Math.max(0, state.planned - currentRemaining());
  if (!natural && actual < 5) return;
  const report: FocusReport = {
    client_id: crypto.randomUUID(),
    task_id: state.taskId,
    kind: state.phase === "focus" ? "focus" : "break",
    planned_seconds: state.planned,
    actual_seconds: actual,
    started_at: state.startedAt || new Date().toISOString(),
    session_date: state.sessionDate || todayStamp(),
    completed: natural,
    finish_task: natural && state.phase === "focus" && state.finishTask && state.taskId != null,
  };
  state = { ...state, queue: [...state.queue, report] };
}

function settle(natural: boolean, audible: boolean) {
  if (settling || state.phase === "idle") return;
  settling = true;
  const phase = state.phase;
  const completedTaskTitle = state.taskTitle;
  const completedFocusMinutes = state.focusMinutes;
  const completedMode = state.mode;
  const autoFinished = natural && phase === "focus" && state.finishTask && state.taskId != null;
  try {
    enqueue(natural);
    if (natural && audible) chime(phase === "focus");
    if (natural && phase === "focus") {
      const next = state.round + 1;
      const breakPhase: "short" | "long" = next >= 4 ? "long" : "short";
      if (autoFinished) {
        state = { ...state, taskFinished: true };
      }
      const evt: FocusLifecycleEvent = {
        id: crypto.randomUUID(),
        type: "focus_completed",
        taskTitle: completedTaskTitle,
        focusMinutes: completedFocusMinutes,
        round: next,
        breakType: breakPhase,
        mode: completedMode,
      };
      beginBreak(breakPhase, next >= 4 ? 0 : next, evt);
    } else if (natural && (phase === "short" || phase === "long")) {
      const evt: FocusLifecycleEvent = {
        id: crypto.randomUUID(),
        type: "break_completed",
        taskTitle: completedTaskTitle,
        focusMinutes: completedFocusMinutes,
        round: state.round,
        breakType: phase,
        mode: completedMode,
      };
      goIdle(evt);
    } else {
      goIdle();
    }
  } finally {
    settling = false;
  }
  void flush();
}

function tick() {
  if (state.mode === "stopwatch") {
    if (!state.running) return;
    const shown = currentShown();
    if (shown >= 8 * 3600) {
      stopFocus();
      return;
    }
    if (shown !== snapshot.remaining) publish();
    return;
  }
  if (!state.running || !state.endsAt) return;
  const left = currentRemaining();
  if (left <= 0) {
    const fresh = Date.now() - state.endsAt < 15_000;
    settle(true, fresh);
    return;
  }
  if (left !== state.remaining) {
    state = { ...state, remaining: left };
    persist();
    publish();
  }
}

async function flush() {
  const send = sink;
  if (send == null || flushing) return;
  flushing = true;
  try {
    while (state.queue.length) {
      await send(state.queue[0]);
      state = { ...state, queue: state.queue.slice(1) };
      persist();
      publish();
    }
  } catch {
    /* 留在队列里，下次面板还在时再写 */
  } finally {
    flushing = false;
  }
}

if (state.mode === "stopwatch") {
  if (state.running) ensureTicker();
} else if (state.running && state.endsAt && state.endsAt <= Date.now()) {
  settle(true, Date.now() - state.endsAt < 15_000);
} else if (state.running) {
  ensureTicker();
}

export function formatClock(total: number) {
  const safe = Math.max(0, total);
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function setFocusSink(next: ((item: FocusReport) => Promise<void>) | null) {
  sink = next;
  if (next) void flush();
}

export function startFocus() {
  if (state.running) return;
  armAudio();
  if (state.mode === "stopwatch") {
    const fresh = state.phase === "idle";
    state = {
      ...state,
      phase: "focus",
      running: true,
      runAt: Date.now(),
      endsAt: null,
      remaining: fresh ? 0 : state.remaining,
      planned: 0,
      startedAt: fresh ? new Date().toISOString() : state.startedAt,
      sessionDate: fresh ? todayStamp() : state.sessionDate,
    };
    persist(true);
    ensureTicker();
    publish();
    return;
  }
  if (state.phase !== "idle") {
    const remaining = currentRemaining();
    state = { ...state, running: true, endsAt: Date.now() + remaining * 1000, remaining };
    persist(true);
    ensureTicker();
    publish();
    return;
  }
  const planned = state.focusMinutes * 60;
  state = {
    ...state,
    phase: "focus",
    running: true,
    planned,
    remaining: planned,
    startedAt: new Date().toISOString(),
    sessionDate: todayStamp(),
    endsAt: Date.now() + planned * 1000,
    taskFinished: false,
  };
  persist(true);
  ensureTicker();
  publish();
}

export function pauseFocus() {
  if (!state.running) return;
  if (state.mode === "stopwatch") {
    state = { ...state, running: false, runAt: null, endsAt: null, remaining: currentShown() };
  } else {
    state = { ...state, running: false, endsAt: null, remaining: currentRemaining() };
  }
  persist(true);
  publish();
}

export function stopFocus() {
  if (state.phase === "idle") return;
  if (state.mode === "stopwatch") {
    const actual = Math.min(currentShown(), 8 * 3600);
    if (actual >= 5) {
      state = {
        ...state,
        queue: [...state.queue, {
          client_id: crypto.randomUUID(),
          task_id: state.taskId,
          kind: "focus",
          planned_seconds: Math.max(actual, 1),
          actual_seconds: actual,
          started_at: state.startedAt || new Date().toISOString(),
          session_date: state.sessionDate || todayStamp(),
          completed: true,
          finish_task: state.finishTask && state.taskId != null,
        }],
      };
    }
    goIdle();
    void flush();
    return;
  }
  settle(false, false);
}

export function setFocusMode(mode: FocusMode) {
  if (state.phase !== "idle" || state.mode === mode) return;
  state = { ...state, mode };
  state = { ...state, ...idleClock() };
  persist(true);
  publish();
}

export function skipBreak() {
  if (state.phase !== "short" && state.phase !== "long") return;
  const actual = Math.max(0, state.planned - currentRemaining());
  if (actual >= 5) {
    state = {
      ...state,
      queue: [...state.queue, {
        client_id: crypto.randomUUID(),
        task_id: state.taskId,
        kind: "break",
        planned_seconds: state.planned,
        actual_seconds: actual,
        started_at: state.startedAt || new Date().toISOString(),
        session_date: state.sessionDate || todayStamp(),
        completed: true,
        finish_task: false,
      }],
    };
  }
  goIdle();
  void flush();
}

export function setFocusMinutes(minutes: FocusMinutes) {
  if (state.phase !== "idle" || state.mode !== "pomodoro") return;
  const clamped = clampFocusMinutes(minutes);
  state = { ...state, focusMinutes: clamped, planned: clamped * 60, remaining: clamped * 60 };
  persist(true);
  publish();
}

export function setFocusTask(id: number | null, title: string) {
  if (state.phase !== "idle") return;
  state = { ...state, taskId: id, taskTitle: title, finishTask: id ? state.finishTask : false, taskFinished: false };
  persist(true);
  publish();
}

export function setFinishTask(finishTask: boolean) {
  if (state.phase !== "idle" || state.taskId == null) return;
  state = { ...state, finishTask };
  persist(true);
  publish();
}

/** 休息完毕后一键「再来一轮」：沿用上一轮专注时长与未完成绑定任务（若上一轮已自动完成任务则解绑）。 */
export function startNextPomodoroRound() {
  if (state.phase === "short" || state.phase === "long") {
    skipBreak();
  }
  if (state.phase !== "idle") return;
  if (state.taskFinished) {
    state = { ...state, taskId: null, taskTitle: "", finishTask: false, taskFinished: false };
  }
  if (state.mode !== "pomodoro") {
    setFocusMode("pomodoro");
  }
  startFocus();
}

export function onFocusLifecycle(fn: (event: FocusLifecycleEvent) => void) {
  lifecycleListeners.add(fn);
  return () => {
    lifecycleListeners.delete(fn);
  };
}

// 监听跨窗口同步（Electron IPC 实时推送 + 同源 localStorage storage 事件双保险）
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE || !event.newValue) return;
    try {
      const parsed = JSON.parse(event.newValue) as Partial<ClockState>;
      applyExternalState(parsed);
    } catch {
      // ignore malformed storage sync
    }
  });
  window.taiwanBotEnv?.onFocusStateSynced?.((payload) => {
    applyExternalState(payload as Partial<ClockState>);
  });
}

export function getFocusSnapshot(): FocusSnapshot {
  return { ...toSnapshot(state), remaining: currentShown() };
}

/**
 * 供灵儿工具通过 `/ws/events` 远程操控番茄钟/正计时器：
 * - 支持自定义 1~180 分钟、任务绑定与完成自动勾掉；
 * - 已有计时在进行中且 `force !== true` 时不粗暴覆盖，而是返回 `conflict: true` + 当前进度。
 */
export function executeFocusCommand(cmd: FocusControlCommand): FocusControlOutcome {
  const action = cmd.action;

  if (action === "status") {
    return { ok: true, state: getFocusSnapshot() };
  }

  if (action === "pause") {
    if (state.phase === "idle") {
      return { ok: false, error: "当前没有正在进行的计时器。", state: getFocusSnapshot() };
    }
    pauseFocus();
    return { ok: true, state: getFocusSnapshot() };
  }

  if (action === "resume") {
    if (state.phase === "idle") {
      return { ok: false, error: "当前没有已暂停的计时器。", state: getFocusSnapshot() };
    }
    startFocus();
    return { ok: true, state: getFocusSnapshot() };
  }

  if (action === "stop") {
    if (state.phase === "idle") {
      return { ok: false, error: "当前没有运行中的专注计时。", state: getFocusSnapshot() };
    }
    if (state.phase === "short" || state.phase === "long") {
      skipBreak();
    } else {
      stopFocus();
    }
    return { ok: true, state: getFocusSnapshot() };
  }

  if (action === "skip_break") {
    if (state.phase !== "short" && state.phase !== "long") {
      return { ok: false, error: "当前不在休息阶段。", state: getFocusSnapshot() };
    }
    skipBreak();
    return { ok: true, state: getFocusSnapshot() };
  }

  if (action === "start") {
    if (state.phase !== "idle") {
      if (!cmd.force) {
        return {
          ok: false,
          conflict: true,
          error: "当前已有正在进行的计时器。",
          state: getFocusSnapshot(),
        };
      }
      if (state.phase === "short" || state.phase === "long") {
        skipBreak();
      } else {
        stopFocus();
      }
    }

    const nextMode: FocusMode = cmd.mode === "stopwatch" ? "stopwatch" : "pomodoro";
    setFocusMode(nextMode);
    if (nextMode === "pomodoro" && cmd.minutes != null) {
      setFocusMinutes(cmd.minutes);
    }
    if (cmd.task_id !== undefined || cmd.task_title !== undefined) {
      setFocusTask(
        typeof cmd.task_id === "number" ? cmd.task_id : null,
        String(cmd.task_title || "").trim(),
      );
    }
    if (typeof cmd.finish_task === "boolean" && state.taskId != null) {
      setFinishTask(cmd.finish_task);
    }
    startFocus();
    return { ok: true, state: getFocusSnapshot() };
  }

  return { ok: false, error: "未知的番茄钟控制指令。", state: getFocusSnapshot() };
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useFocusClock() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
