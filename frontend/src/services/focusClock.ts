/**
 * 番茄钟停在本机，切页和刷新都接着走。
 * 一轮结束才写进本地日记库；同一次结束用 client_id，避免重试记成两个番茄。
 */

import { useSyncExternalStore } from "react";

export type FocusPhase = "idle" | "focus" | "short" | "long";
export type FocusMinutes = 15 | 25 | 45;
export type FocusMode = "pomodoro" | "stopwatch";

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

interface ClockState extends Omit<FocusSnapshot, "pending" | "remaining"> {
  remaining: number;
  endsAt: number | null;
  runAt: number | null;
  startedAt: string;
  sessionDate: string;
  queue: FocusReport[];
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
      focusMinutes: saved.focusMinutes === 15 || saved.focusMinutes === 45 ? saved.focusMinutes : 25,
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

function persist() {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(state));
  } catch {
    /* 本机存不下倒计时时，这一轮仍然可以走完 */
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

function goIdle() {
  state = {
    ...state,
    phase: "idle",
    running: false,
    endsAt: null,
    runAt: null,
    ...idleClock(),
    startedAt: "",
    sessionDate: "",
  };
  persist();
  publish();
}

function beginBreak(phase: "short" | "long", round: number) {
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
  };
  persist();
  ensureTicker();
  publish();
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
  try {
    enqueue(natural);
    if (natural && audible) chime(phase === "focus");
    if (natural && phase === "focus") {
      const next = state.round + 1;
      if (next >= 4) beginBreak("long", 0);
      else beginBreak("short", next);
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
    persist();
    ensureTicker();
    publish();
    return;
  }
  if (state.phase !== "idle") {
    const remaining = currentRemaining();
    state = { ...state, running: true, endsAt: Date.now() + remaining * 1000, remaining };
    persist();
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
  };
  persist();
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
  persist();
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
  persist();
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
  state = { ...state, focusMinutes: minutes, planned: minutes * 60, remaining: minutes * 60 };
  persist();
  publish();
}

export function setFocusTask(id: number | null, title: string) {
  if (state.phase !== "idle") return;
  state = { ...state, taskId: id, taskTitle: title, finishTask: id ? state.finishTask : false };
  persist();
  publish();
}

export function setFinishTask(finishTask: boolean) {
  if (state.phase !== "idle" || state.taskId == null) return;
  state = { ...state, finishTask };
  persist();
  publish();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useFocusClock() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
