import { useCallback, useEffect, useState } from "react";
import { api, formatLocalDate, type FocusOverview, type TaskItem } from "../../services/api";
import {
  formatClock,
  pauseFocus,
  setFinishTask,
  setFocusMinutes,
  setFocusMode,
  setFocusTask,
  skipBreak,
  startFocus,
  stopFocus,
  useFocusClock,
  type FocusMinutes,
  type FocusMode,
} from "../../services/focusClock";

function formatTotal(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} m` : `${hours} h`;
}

function formatMark(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

function clockTime(iso: string) {
  const matched = iso.match(/T(\d{2}):(\d{2})/);
  if (matched) return `${matched[1]}:${matched[2]}`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dayLabel(iso: string) {
  const date = new Date(`${iso}T12:00:00`);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export default function FocusPanel() {
  const clock = useFocusClock();
  const today = formatLocalDate();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [overview, setOverview] = useState<FocusOverview | null>(null);
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  const radius = 86;
  const circumference = 2 * Math.PI * radius;
  const idle = clock.phase === "idle";
  const onBreak = clock.phase === "short" || clock.phase === "long";
  const countingDown = clock.mode === "pomodoro" && !idle;
  const ratio = clock.planned > 0 ? Math.min(1, clock.remaining / clock.planned) : 1;

  const load = useCallback(async () => {
    try {
      const [openTasks, summary] = await Promise.all([
        api.listTasks("today", today),
        api.focusOverview(today),
      ]);
      setTasks(openTasks);
      setOverview(summary);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "专注记录没有加载出来");
    }
  }, [today]);

  useEffect(() => {
    void load();
  }, [load, clock.phase, clock.pending]);

  function choose(mode: FocusMode) {
    setPicking(false);
    setFocusMode(mode);
  }

  function bind(task: TaskItem | null) {
    setFocusTask(task ? task.id : null, task?.title ?? "");
    setPicking(false);
  }

  return <div className="l-pomo">
    <section className="l-pomo-stage">
      <div className="l-pomo-modes" aria-label="计时方式">
        {([
          ["pomodoro", "番茄计时"],
          ["stopwatch", "正计时"],
        ] as const).map(([id, label]) => (
          <button key={id} aria-pressed={clock.mode === id} disabled={!idle} onClick={() => choose(id)}>{label}</button>
        ))}
      </div>

      {idle && clock.mode === "pomodoro" && <div className="l-pomo-lengths" aria-label="专注时长">
        {([15, 25, 45] as FocusMinutes[]).map((minutes) => (
          <button key={minutes} aria-pressed={clock.focusMinutes === minutes} onClick={() => setFocusMinutes(minutes)}>
            {minutes}
          </button>
        ))}
      </div>}

      <div className="l-pomo-pick">
        <button className="l-pomo-task" disabled={!idle} onClick={() => setPicking((open) => !open)}>
          {clock.taskTitle || "选择一件事"} ›
        </button>
        {picking && idle && <div className="l-pomo-menu">
          <button onClick={() => bind(null)}>不绑定任务</button>
          {tasks.map((task) => (
            <button key={task.id} aria-pressed={clock.taskId === task.id} onClick={() => bind(task)}>{task.title}</button>
          ))}
          {!tasks.length && <p>今天还没有要做的事。</p>}
          {clock.mode === "pomodoro" && clock.taskId != null && <label className="l-check">
            <input type="checkbox" checked={clock.finishTask} onChange={(e) => setFinishTask(e.target.checked)} />
            这一轮做完就勾掉
          </label>}
        </div>}
      </div>

      <div className="l-ring-wrap">
        <svg className="l-ring" viewBox="0 0 200 200" role="img" aria-label={`${onBreak ? "休息" : "专注"} ${formatClock(clock.remaining)}`}>
          <circle cx="100" cy="100" r={radius} />
          {countingDown && <circle className="left" cx="100" cy="100" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - ratio)} />}
        </svg>
        <strong className="l-pomo-time">{formatClock(clock.remaining)}</strong>
      </div>

      {onBreak && <p className="l-muted">{clock.phase === "long" ? "这一轮辛苦了，多歇一会儿。" : "休息一下下。"}</p>}

      <div className="l-pomo-actions">
        {idle && <button className="l-pomo-go" onClick={startFocus}>开始</button>}
        {!idle && clock.running && <button className="l-pomo-go" onClick={pauseFocus}>暂停</button>}
        {!idle && !clock.running && <button className="l-pomo-go" onClick={startFocus}>继续</button>}
        {!idle && !onBreak && <button className="l-quiet" onClick={stopFocus}>结束</button>}
        {onBreak && <button className="l-quiet" onClick={skipBreak}>休息好了</button>}
      </div>
      {error && <p role="alert" className="l-error">{error}</p>}
    </section>

    <aside className="l-pomo-side">
      <h2>概览</h2>
      <div className="l-pomo-stats">
        <div><small>今日番茄</small><strong>{overview?.today_count ?? "—"}</strong></div>
        <div><small>今日专注时长</small><strong>{overview ? formatTotal(overview.today_seconds) : "—"}</strong></div>
        <div><small>总番茄</small><strong>{overview?.total_count ?? "—"}</strong></div>
        <div><small>总专注时长</small><strong>{overview ? formatTotal(overview.total_seconds) : "—"}</strong></div>
      </div>

      <h2>专注记录</h2>
      {overview && !overview.days.length && <p className="l-muted">还没有专注记录。</p>}
      {overview?.days.map((day) => (
        <section key={day.date}>
          <h3>{dayLabel(day.date)}</h3>
          <ol className="l-timeline">
            {day.sessions.map((item) => (
              <li key={item.id} className={item.completed ? "done" : ""}>
                <i />
                <div>
                  <b>{clockTime(item.started_at)} - {clockTime(item.ended_at)}</b>
                  <span>{item.task_title || (item.completed ? "专注" : "中途停下")}</span>
                </div>
                <em>{formatMark(item.actual_seconds)}</em>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </aside>
  </div>;
}
