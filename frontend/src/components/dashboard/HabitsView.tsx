import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, formatLocalDate, type HabitBoardItem } from "../../services/api";
import { isNetworkFetchError } from "../../services/api/client";
import { useToast } from "../../hooks/useToast";

const CATEGORIES = ["生活习惯", "作息睡眠", "运动健康", "学习成长", "情绪自我"];
const WEEKDAY = "日一二三四五六";

function dayMark(iso: string) {
  return WEEKDAY[new Date(`${iso}T12:00:00`).getDay()];
}

export default function HabitsView() {
  const today = formatLocalDate();
  const [items, setItems] = useState<HabitBoardItem[]>([]);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [targetDesc, setTargetDesc] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const { toast, showToast } = useToast(2600);

  const load = useCallback(async () => {
    try {
      const board = await api.habitBoard(today);
      setItems(board.items);
      setError("");
    } catch (err) {
      if (isNetworkFetchError(err)) {
        setError("");
        return;
      }
      setError(err instanceof Error ? err.message : "习惯没有加载出来");
    }
  }, [today]);

  useEffect(() => {
    void load();
    const onReady = () => void load();
    window.addEventListener("linger-backend-ready", onReady);
    window.addEventListener("linger-data-changed", onReady);
    return () => {
      window.removeEventListener("linger-backend-ready", onReady);
      window.removeEventListener("linger-data-changed", onReady);
    };
  }, [load]);

  const active = items.filter((item) => item.is_active);
  const done = active.filter((item) => item.today_status === "done").length;

  async function add(e: FormEvent) {
    e.preventDefault();
    const text = title.trim();
    if (!text) return;
    try {
      await api.createHabit({ title: text, category, target_desc: targetDesc.trim() });
      setTitle("");
      setTargetDesc("");
      setAdding(false);
      await load();
      showToast("已加进每天的小事");
    } catch (err) {
      setError(err instanceof Error ? err.message : "没有加上");
    }
  }

  async function check(habitId: number, status: "done" | "partial" | "missed") {
    try {
      await api.recordDailyHabit(today, { habit_id: habitId, status, note: "面板打卡" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "打卡没有保存");
    }
  }

  async function run(work: () => Promise<unknown>, ok: string) {
    try {
      await work();
      await load();
      showToast(ok);
    } catch (err) {
      setError(err instanceof Error ? err.message : "没有保存");
    }
  }

  return <>
    <section className="l-card l-habit-summary">
      <div>
        <h2>今天</h2>
        <p className="l-muted">完成或部分都算保住连续天数。今天还没打的，要到明天才会断。</p>
      </div>
      <strong className="l-number">{active.length ? done : "—"}<small> / {active.length || "—"}</small></strong>
      <div className="l-meter" aria-hidden="true"><span style={{ width: `${active.length ? Math.round((done / active.length) * 100) : 0}%` }} /></div>
    </section>

    {(adding || items.length === 0) && <form className="l-card l-editor" onSubmit={add}>
      <div className="l-controls" aria-label="习惯分类">
        {CATEGORIES.map((item) => (
          <button key={item} type="button" aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>
        ))}
      </div>
      <input aria-label="习惯名称" maxLength={100} placeholder="例如：喝水、睡前放下手机" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input aria-label="补充说明" maxLength={200} placeholder="补充一句，给灵儿晚上核对时用（可选）" value={targetDesc} onChange={(e) => setTargetDesc(e.target.value)} />
      <div className="l-actions">
        <button className="l-primary" disabled={!title.trim()}>添加</button>
        {items.length > 0 && <button type="button" className="l-quiet" onClick={() => setAdding(false)}>收起</button>}
      </div>
    </form>}

    {!adding && items.length > 0 && <button className="l-text" onClick={() => setAdding(true)}>新增习惯</button>}
    {error && <p role="alert" className="l-error">{error}</p>}

    <ul className="l-habits">
      {items.map((habit) => (
        <li key={habit.id} className={habit.is_active ? "l-habit" : "l-habit paused"}>
          <div>
            <strong>{habit.title}</strong>
            <small>
              {habit.category}
              {habit.target_desc ? ` · ${habit.target_desc}` : ""}
              {habit.is_active ? "" : " · 已暂停"}
            </small>
            <span className="l-week" aria-label="最近七天">
              {habit.week.map((day) => (
                <i key={day.date} className={day.status ?? "empty"} title={`${day.date} ${day.status === "done" ? "完成" : day.status === "partial" ? "部分" : day.status === "missed" ? "未做" : "未记"}`}>
                  {dayMark(day.date)}
                </i>
              ))}
            </span>
          </div>
          <div>
            <em>{habit.streak ? `连续 ${habit.streak} 天` : "从今天开始"}</em>
            <div className="l-controls" aria-label={`${habit.title}的今日状态`}>
              {([
                ["done", "完成"],
                ["partial", "部分"],
                ["missed", "未做"],
              ] as const).map(([status, label]) => (
                <button key={status} aria-pressed={habit.today_status === status} onClick={() => void check(habit.id, status)}>{label}</button>
              ))}
            </div>
            <span className="l-task-actions">
              <button className="l-quiet" onClick={() => void run(() => api.updateHabit(habit.id, { is_active: !habit.is_active }), habit.is_active ? "先暂停" : "继续这个习惯")}>
                {habit.is_active ? "暂停" : "恢复"}
              </button>
              <button className="l-quiet" onClick={() => void run(() => api.deleteHabit(habit.id), "已删除")}>删除</button>
            </span>
          </div>
        </li>
      ))}
    </ul>
    {toast && <p className="l-toast" role="status">{toast}</p>}
  </>;
}
