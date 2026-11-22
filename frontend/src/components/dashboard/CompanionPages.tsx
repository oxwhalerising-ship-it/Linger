import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, formatLocalDate, type DailyLogDetail, type Insights, type ReportStats, type MemoryItem } from "../../services/api";
import { isNetworkFetchError } from "../../services/api/client";
import { IconMic, IconStop, IconArrowUp, IconSparkles, IconCalendar, IconAnalytics, IconClock } from "./AppleIcons";
import { LocalWavRecorder } from "../../services/voiceRecorder";
import { formatClock, useFocusClock } from "../../services/focusClock";
function useResource<T>(load: () => Promise<T>, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    const onReady = () => setRevision(n => n + 1);
    window.addEventListener("linger-backend-ready", onReady);
    window.addEventListener("linger-data-changed", onReady);
    return () => {
      window.removeEventListener("linger-backend-ready", onReady);
      window.removeEventListener("linger-data-changed", onReady);
    };
  }, []);
  useEffect(() => {
    if (!enabled) {
      setError("");
      return;
    }
    let live = true;
    let retryTimer: number | null = null;
    let attempt = 0;
    const run = () => {
      load().then(v => {
        if (!live) return;
        setError("");
        setData(v);
      }).catch(e => {
        if (!live) return;
        if (isNetworkFetchError(e)) {
          // 后端尚在启动或瞬时重连时静默重试，绝不弹出英文 TypeError: Failed to fetch
          setError("");
          attempt += 1;
          const delayMs = attempt <= 6 ? 800 : 2000;
          retryTimer = window.setTimeout(() => {
            if (live) run();
          }, delayMs);
          return;
        }
        setError(String(e));
      });
    };
    setError("");
    run();
    return () => {
      live = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [load, revision, enabled]);
  return { data, refresh, error, setError };
}
function Fault({ error }: {
  error: string;
}) {
  return error ? <p role="alert" className="l-error">{error}</p> : null;
}
type Period = "weekly" | "monthly";
function localDay(value: string) {
  return new Date(value + "T12:00:00");
}
export function periodEnd(period: Period, offset: number) {
  const d = new Date();
  if (period === "weekly")
    d.setDate(d.getDate() + 6 - (d.getDay() + 6) % 7 + offset * 7);
  else
    d.setMonth(d.getMonth() + offset + 1, 0);
  return formatLocalDate(d);
}
export function Trend({ stats, open }: {
  stats: ReportStats;
  open?: (date: string) => void;
}) {
  const start = localDay(stats.start_date);
  const days = Array.from({ length: stats.total_days }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return formatLocalDate(d);
  });
  const fields = ["energy_score", "mood_score"] as const;
  const has = stats.trend.some(r => r.energy_score !== null || r.mood_score !== null);
  if (!has)
    return <p className="l-muted">记录心情或精力后，这里会出现趋势。</p>;
  return <>
    <svg className="l-chart" viewBox="0 0 320 100" role="img" aria-label="精力与心情趋势，量表从一至五">

      {[1, 2, 3, 4, 5].map(n => <g key={n}>
        <text x="1" y={101 - n * 18}>{n}</text>
        <path className="gridline" d={'M18 ' + (98 - n * 18) + ' H314'} />
      </g>)}

      {fields.map((f, k) => {
        let previous = false;
        let path = "";
        const dots = days.map((d, i) => {
          const v = stats.trend.find(r => r.date === d)?.[f];
          if (v == null) {
            previous = false;
            return null;
          }
          const x = 18 + i * 294 / Math.max(1, days.length - 1), y = 98 - v * 18;
          path += (previous ? " L" : " M") + x + " " + y;
          previous = true;
          return <circle key={d} cx={x} cy={y} r="3" onClick={() => open?.(d)}>
            <title>
              {d} ·
              {k ? "心情" : "精力"}
              {v}
            </title>
          </circle>;
        });
        return <g key={f} className={'series s' + k}>
          <path d={path} />
          {dots}
        </g>;
      })}
    </svg>

    <small className="l-muted">● 精力
      <span className="l-lavender">● 心情</span>
    </small>
  </>;
}
export function Today({ ready = true, send, habits, tasks, focus, insights, joy, settings }: {
  ready?: boolean;
  send: (v: string) => void;
  habits: () => void;
  tasks: () => void;
  focus: () => void;
  insights: () => void;
  joy: () => void;
  settings: () => void;
}) {
  const [draft, setDraft] = useState("");
  const today = formatLocalDate();
  const clock = useFocusClock();
  const { data, error, setError, refresh } = useResource(useCallback(() => Promise.all([api.listHabits(true), api.getDailyLog(today), api.insights("weekly", today), api.getScheduleStatus(), api.listTasks("today", today)]), [today]), ready);
  const hour = new Date().getHours();
  const done = data?.[0].filter(h => data[1].habit_records.some(r => r.habit_id === h.id && r.status === "done")).length;
  const next = data?.[3].jobs.filter(j => j.next_run_time && new Date(j.next_run_time).getTime() > Date.now()).sort((a, b) => Date.parse(a.next_run_time!) - Date.parse(b.next_run_time!))[0];
  const recorder = useRef<LocalWavRecorder | null>(null);
  const [voice, setVoice] = useState<"idle" | "recording" | "transcribing">("idle");
  useEffect(() => () => {
    recorder.current?.stop();
  }, []);
  useEffect(() => {
    const onPlan = () => refresh();
    window.addEventListener("linger-plan", onPlan);
    return () => window.removeEventListener("linger-plan", onPlan);
  }, [refresh]);
  async function dictate() {
    try {
      if (voice === "recording") {
        const wav = recorder.current?.stop();
        if (wav) {
          setVoice("transcribing");
          const { text } = await api.transcribeAudioWav(wav);
          setDraft(v => (v + " " + text).trim());
        }
        setVoice("idle");
        return;
      }
      recorder.current = new LocalWavRecorder();
      setVoice("recording");
      await recorder.current.start();
    }
    catch (e) {
      setVoice("idle");
      setError("语音输入未完成：" + String(e));
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (draft.trim())
      send(draft.trim());
  }
  return <div className="l-page l-home">
    <header className="l-hero">
      <div>
        <time>{new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}</time>

        <h1>{hour < 6 ? "夜深了" : hour < 11 ? "早安" : hour < 14 ? "午安" : hour < 18 ? "下午好" : "晚上好"}</h1>
        <p>{done == null ? "" : done ? "今天已经完成了 " + done + " 个习惯。" : "今天想从哪件小事开始？"}</p>
      </div>
    </header>

    <form onSubmit={submit} className="l-compose">
      <img className="l-composer-mascot" alt="灵儿" src="./companion/greeting.webp" />
      <textarea aria-label="和灵儿说说今天的事" placeholder="和灵儿说说今天的事…" maxLength={2000} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          if (draft.trim())
            send(draft.trim());
        }
      }} />
      <button type="button" className="l-dictate" aria-label={voice === "recording" ? "结束录音" : "语音输入"} disabled={voice === "transcribing"} onClick={dictate}>
        {voice === "recording" ? <IconStop /> : <IconMic />}
        {voice === "recording" ? "结束录音" : voice === "transcribing" ? "正在识别" : ""}
      </button>
      <button className="l-send" aria-label="发送" disabled={!draft.trim()}><IconArrowUp /></button>
    </form>

    <div className="l-actions">
      <button onClick={() => send("帮我复盘今天，先从还没核对的习惯开始。")}>
        <IconCalendar />晚间复盘
      </button>
      <button onClick={insights}>
        <IconAnalytics />查看本周状态
      </button>
      <button onClick={joy}>
        <IconSparkles />记一件小确幸
      </button>
      <button onClick={focus}>
        <IconClock />{clock.phase === "idle" ? "开始专注" : `${clock.phase === "focus" ? "专注中" : "休息中"} ${formatClock(clock.remaining)}`}
      </button>
    </div>

    <Fault error={error} />
    <div className="l-home-cards">
      <section className="l-card">
        <button onClick={tasks}>
          <h2>今日任务 ›</h2>
        </button>
        <strong className="l-number">
          {data?.[4].length ?? "—"}
          <small> 件</small>
        </strong>
        {data?.[4].slice(0, 4).map(task => <label className={"l-check" + (task.due_date && task.due_date < today ? " l-overdue" : "")} key={task.id}>
          <input type="checkbox" checked={false} aria-label={`完成${task.title}`} onChange={() => api.updateTask(task.id, { status: "done" }).then(refresh).catch(e => setError(String(e)))} />
          {task.title}
        </label>)}
        {data && !data[4].length && <button className="l-text" onClick={tasks}>写下一件今天要做的事</button>}
      </section>

      <section className="l-card">
        <button onClick={habits}>
          <h2>今日习惯 ›</h2>
        </button>
        <strong className="l-number">
          {done ?? "—"}
          <small> /
            {data?.[0].length ?? "—"}
          </small>
        </strong>

        {data?.[0].slice(0, 4).map(h => {
          const checked = data[1].habit_records.some(r => r.habit_id === h.id && r.status === "done");
          return <label className="l-check" key={h.id}>
            <input type="checkbox" checked={checked} onChange={() => api.recordDailyHabit(today, { habit_id: h.id, status: checked ? "missed" : "done" }).then(refresh).catch(e => setError(String(e)))} />
            {h.title}
          </label>;
        })}

        {data && !data[0].length && <button className="l-text" onClick={habits}>添加第一个习惯</button>}
      </section>

      <section className="l-card">
        <button onClick={insights}>
          <h2>精力与心情 ›</h2>
        </button>
        {data && <Trend stats={data[2]} />}
      </section>

      <section className="l-card">
        <button onClick={settings}>
          <h2>下一个提醒 ›</h2>
        </button>
        {data && <>{data[3].dnd_enabled ? <p>免打扰已开启</p> : next ? <>
          <strong className="l-number">{new Date(next.next_run_time!).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</strong>
          <p>{next.name}</p>
        </> : <p className="l-muted">暂无待触发提醒</p>}</>}
      </section>
    </div>
  </div>;
}
export function InsightsPage({ period, offset, select, shift, report, day }: {
  period: Period;
  offset: number;
  select: (p: Period) => void;
  shift: (n: number) => void;
  report: () => void;
  day: (v: string) => void;
}) {
  const end = periodEnd(period, offset);
  const { data, error } = useResource(useCallback(() => api.insights(period, end), [period, end]));
  const dates = Array.from({ length: 90 }, (_, i) => {
    const d = localDay(end);
    d.setDate(d.getDate() - 89 + i);
    return formatLocalDate(d);
  });
  return <div className="l-page">
    <header className="l-head">
      <h1>洞察</h1>
      <div className="l-controls">
        <button aria-pressed={period === "weekly"} onClick={() => select("weekly")}>周</button>
        <button aria-pressed={period === "monthly"} onClick={() => select("monthly")}>月</button>
        <button aria-label="上一周期" onClick={() => shift(offset - 1)}>‹</button>
        <button aria-label="下一周期" disabled={offset >= 0} onClick={() => shift(offset + 1)}>›</button>
      </div>
    </header>
    <Fault error={error} />

    {data && <>
      <div className="l-subhead">
        <time>
          {data.start_date} —
          {end}
        </time>
        <button className="l-pill" onClick={report}>成长
          {period === "weekly" ? "周" : "月"}报 →
        </button>
      </div>

      <div className="l-metrics">{[[data.overall_completion_rate + "%", "习惯完成率"], [data.streak + " 天", "连续打卡"], [data.avg_energy ?? "—", "平均精力"], [data.highlights.length + " 件", "小确幸"]].map(([v, k]) => <div className="l-card" key={k}>
        <strong>{v}</strong>
        {k}
      </div>)}</div>

      <div className="l-two">
        <section className="l-card">
          <h2>精力与心情</h2>
          <Trend stats={data} open={day} />
        </section>
        <section className="l-card">
          <h2>各习惯完成情况</h2>
          {data.habit_breakdown.map(h => <label className="l-bar" key={h.habit_id}>
            {h.title}
            <progress value={h.completion_rate} max={100} />
            {h.completion_rate}%
          </label>)}
          {!data.habit_breakdown.length && "暂无习惯"}
        </section>

        <section className="l-card">
          <h2>近 90 天打卡</h2>
          <small>
            {dates[0]} —
            {end}
          </small>
          <div className="l-heat">{dates.map(d => <button title={d + " · " + (data.activity[d] || 0) + " 项"} aria-label={d + " 日记"} key={d} style={{ opacity: data.activity[d] ? Math.min(.4 + data.activity[d] * .13, 1) : .12 }} onClick={() => day(d)} />)}</div>
        </section>

        <section className="l-card l-observe">
          <h2>灵儿的观察</h2>
          <p>{data.logged_days ? "这段时间你留下了 " + data.logged_days + " 天日记，记下了 " + data.highlights.length + " 件小确幸。" : "这一段时间还没有日记。"}</p>
          <img alt="" src="./companion/observation.webp" />
        </section>
      </div>
    </>}
  </div>;
}
function joyIllustration(text: string) {
  if (/猫|喵/.test(text))
    return "cat";
  if (/茶|咖啡|饮/.test(text))
    return "tea";
  if (/书|读/.test(text))
    return "book";
  if (/夕阳|日落|黄昏/.test(text))
    return "sunset";
  return "river";
}
export function Joys({ compose = false }: {
  compose?: boolean;
}) {
  const [month, setMonth] = useState(formatLocalDate().slice(0, 7)), [only, setOnly] = useState(false), [editing, setEditing] = useState(compose), [content, setContent] = useState(""), [date, setDate] = useState(formatLocalDate()), [busy, setBusy] = useState(false);
  const { data, refresh, error, setError } = useResource(useCallback(() => api.highlights(month), [month]));
  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy || !content.trim())
      return;
    setBusy(true);
    try {
      await api.appendHighlight(date, content);
      setMonth(date.slice(0, 7));
      setOnly(false);
      setContent("");
      setEditing(false);
      refresh();
    }
    catch (e) {
      setError(String(e));
    }
    finally {
      setBusy(false);
    }
  }
  const items = data?.filter(h => !only || h.favorite);
  return <div className="l-page">
    <header className="l-head">
      <h1>小确幸</h1>
      <button className="l-primary" onClick={() => setEditing(true)}>＋ 记一件</button>
    </header>
    <div className="l-subhead">
      <div className="l-controls">{["全部", "已收藏"].map((v, i) => <button key={v} aria-pressed={only === !!i} onClick={() => setOnly(!!i)}>{v}</button>)}</div>
      <input aria-label="月份" type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} />
    </div>
    <Fault error={error} />

    {editing && <form className="l-card l-editor" onSubmit={add}>
      <input aria-label="记录日期" type="date" required value={date} onChange={e => setDate(e.target.value)} />
      <textarea autoFocus required maxLength={2000} aria-label="小确幸内容" placeholder="今天哪一刻让你觉得，刚刚好？" value={content} onChange={e => setContent(e.target.value)} />
      <div>
        <button type="button" className="l-pill" onClick={() => setEditing(false)}>取消</button>
        <button disabled={busy} className="l-primary">保存</button>
      </div>
    </form>}

    <div className="l-two l-joys">{items?.map(h => <article className="l-card" key={h.id}>
      <img alt="" src={"./companion/" + joyIllustration(h.content) + ".webp"} />
      <button aria-label={h.favorite ? "取消收藏" : "收藏"} aria-pressed={!!h.favorite} className="l-star" onClick={() => api.favorite(h.id, !h.favorite).then(refresh).catch(e => setError(String(e)))}>{h.favorite ? "★" : "☆"}</button>
      <h2>{h.content}</h2>
      <time>{h.date}</time>
    </article>)}</div>
    {items && !items.length && <p className="l-muted">{only ? "这个月还没有收藏。" : "这个月的小确幸，从记下一件小事开始。"}</p>}
  </div>;
}
const kinds = { preference: "个人喜好", ongoing_event: "近期关心", highlight: "历史高光" };
export function Memories({ source }: {
  source: (id: number) => void;
}) {
  const { data, refresh, error, setError } = useResource(useCallback(() => api.listMemories(), []));
  const [filter, setFilter] = useState(""), [q, setQ] = useState(""), [id, setId] = useState<number>(), [draft, setDraft] = useState<Partial<MemoryItem> | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const rows = data?.filter(m => (!filter || filter === m.memory_type) && m.content.includes(q)) || [];
  const item = rows.find(m => m.id === id) || rows[0];
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft?.content?.trim() || !draft.memory_type)
      return;
    try {
      const saved = draft.id ? await api.editMemory(draft as MemoryItem) : await api.createMemory({ content: draft.content.trim(), memory_type: draft.memory_type });
      setId(saved.id);
      setFilter("");
      setQ("");
      setDraft(null);
      refresh();
    }
    catch (e) {
      setError(String(e));
    }
  }
  return <div className="l-page">
    <header className="l-head">
      <h1>记忆</h1>
      <button className="l-primary" onClick={() => setDraft({ memory_type: "preference", content: "" })}>＋ 添加记忆</button>
    </header>
    <input className="l-search" placeholder="搜索记忆…" aria-label="搜索记忆" value={q} onChange={e => setQ(e.target.value)} />
    <div className="l-controls">{Object.entries({ "": "全部", ...kinds }).map(([v, k]) => <button aria-pressed={filter === v} key={v} onClick={() => {
      setFilter(v);
      setDetailOpen(false);
    }}>{k}</button>)}</div>
    <Fault error={error} />

    {draft && <form onSubmit={save} className="l-card l-editor">
      <select aria-label="记忆分类" value={draft.memory_type} onChange={e => setDraft({ ...draft, memory_type: e.target.value as MemoryItem["memory_type"] })}>{Object.entries(kinds).map(([v, k]) => <option value={v} key={v}>{k}</option>)}</select>
      <textarea autoFocus required maxLength={500} aria-label="记忆内容" value={draft.content} onChange={e => setDraft({ ...draft, content: e.target.value })} />
      <div>
        <button type="button" className="l-pill" onClick={() => setDraft(null)}>取消</button>
        <button className="l-primary">保存</button>
      </div>
    </form>}

    <div className={"l-two l-memory-grid " + (detailOpen ? "detail-open" : "")}>
      <section className="l-card">
        {rows.map(m => <button className="l-memory-row" aria-pressed={m.id === item?.id} key={m.id} onClick={() => {
          setId(m.id);
          setDetailOpen(true);
        }}>
          <strong>{m.content}</strong>
          <small>
            {kinds[m.memory_type]} ·
            {m.created_at.slice(0, 10)}
          </small>
        </button>)}
        {data && !rows.length && "没有符合条件的记忆"}
      </section>
      {item && <article className="l-card">
        <button className="l-mobile-back l-text" onClick={() => setDetailOpen(false)}>‹ 返回列表</button>
        <small>{kinds[item.memory_type]}</small>
        <h2>{item.content}</h2>
        <p>{item.created_at.slice(0, 10)}</p>
        {item.source_message_id && <button className="l-text" onClick={() => source(item.source_message_id!)}>查看对话 →</button>}
        <div className="l-actions">
          <button onClick={() => setDraft({ ...item })}>编辑</button>
          <button onClick={async () => {
            if (window.confirm("忘记这条记忆？"))
              try {
                await api.deleteMemory(item.id);
                refresh();
              }
              catch (e) {
                setError(String(e));
              }
          }}>忘记这条</button>
        </div>
      </article>}
    </div>
  </div>;
}
export function Review({ date, revision, open }: {
  date: string;
  revision: number;
  open: () => void;
}) {
  const [md, setMd] = useState(false);
  const { data, error } = useResource<DailyLogDetail>(useCallback(() => api.getDailyLog(date), [date, revision]));
  return <aside className="l-review">
    <h2>今日复盘</h2>
    <time>{date}</time>
    <div className="l-controls">
      <button aria-pressed={!md} onClick={() => setMd(false)}>预览</button>
      <button aria-pressed={md} onClick={() => setMd(true)}>Markdown</button>
    </div>
    <Fault error={error} />
    {data && (md ? <pre>{data.markdown_content}</pre> : <>
      <p>{data.summary}</p>
      {data.habit_records.map(r => <p key={r.habit_id}>
        {r.status === "done" ? "✓" : r.status === "partial" ? "◐" : "○"}
        {r.habit_title}
      </p>)}
      <p>心情
        {data.mood_score ?? "—"} / 5　精力
        {data.energy_score ?? "—"} / 5
      </p>
      <h3>今日小确幸</h3>
      {data.highlights.map((h, i) => <p key={i}>{h}</p>)}
    </>)}
    <button className="l-text" onClick={open}>打开日记 →</button>
  </aside>;
}
