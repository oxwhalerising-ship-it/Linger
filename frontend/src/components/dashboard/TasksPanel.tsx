import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, formatLocalDate, type TaskItem } from "../../services/api";
import { isNetworkFetchError } from "../../services/api/client";

type Scope = "today" | "later" | "done";

export default function TasksPanel() {
  const today = formatLocalDate();
  const [scope, setScope] = useState<Scope>("today");
  const [items, setItems] = useState<TaskItem[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await api.listTasks(scope, today));
      setError("");
    } catch (err) {
      if (isNetworkFetchError(err)) {
        setError("");
        return;
      }
      setError(err instanceof Error ? err.message : "任务没有加载出来");
    }
  }, [scope, today]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onPlan = () => void load();
    window.addEventListener("linger-plan", onPlan);
    window.addEventListener("linger-data-changed", onPlan);
    window.addEventListener("linger-backend-ready", onPlan);
    return () => {
      window.removeEventListener("linger-plan", onPlan);
      window.removeEventListener("linger-data-changed", onPlan);
      window.removeEventListener("linger-backend-ready", onPlan);
    };
  }, [load]);

  async function run(work: () => Promise<unknown>) {
    try {
      await work();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "这次没有保存");
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const text = title.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api.createTask({ title: text, due_date: scope === "later" ? null : today });
      setTitle("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "没有加上");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div className="l-controls" aria-label="任务范围">
      {([
        ["today", "今天"],
        ["later", "稍后"],
        ["done", "完成"],
      ] as const).map(([id, label]) => (
        <button key={id} aria-pressed={scope === id} onClick={() => setScope(id)}>{label}</button>
      ))}
    </div>

    {scope !== "done" && <form className="l-capture" onSubmit={add}>
      <input
        aria-label="新任务"
        maxLength={200}
        placeholder={scope === "today" ? "今天要做的一件事…" : "先记下来，稍后再排…"}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <button className="l-primary" disabled={busy || !title.trim()}>添加</button>
    </form>}

    {error && <p role="alert" className="l-error">{error}</p>}

    {items.length === 0 && <p className="l-muted">
      {scope === "today" ? "今天还是空的。写下一件就好。" : scope === "later" ? "没有先放下的事。" : "最近还没有完成的事。"}
    </p>}

    <ul className="l-tasks">
      {items.map((task) => (
        <li key={task.id} className={task.status === "done" ? "l-task done" : "l-task"}>
          <input
            type="checkbox"
            aria-label={task.status === "done" ? `恢复${task.title}` : `完成${task.title}`}
            checked={task.status === "done"}
            onChange={() => void run(() => api.updateTask(task.id, { status: task.status === "done" ? "open" : "done" }))}
          />
          <p>
            {task.title}
            {task.status === "open" && task.due_date && task.due_date < today && <small className="l-overdue">逾期</small>}
            {task.status === "open" && task.important && <small>重要</small>}
            {task.status === "open" && scope === "later" && <small>{task.due_date ? task.due_date.slice(5) : "未排期"}</small>}
          </p>
          <span className="l-task-actions">
            {task.status === "open" && <button className="l-quiet" aria-pressed={task.important} onClick={() => void run(() => api.updateTask(task.id, { important: !task.important }))}>重要</button>}
            {task.status === "open" && scope === "today" && <button className="l-quiet" onClick={() => void run(() => api.postponeTask(task.id, today))}>明天</button>}
            {task.status === "open" && scope === "later" && <button className="l-quiet" onClick={() => void run(() => api.updateTask(task.id, { due_date: today }))}>今天</button>}
            <button className="l-quiet" onClick={() => void run(() => api.deleteTask(task.id))}>删除</button>
          </span>
        </li>
      ))}
    </ul>
  </>;
}
