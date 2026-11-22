import { useCallback, useEffect, useState } from "react";
import { api, formatLocalDate } from "../../services/api";
import { IconCalendar, IconChat, IconAnalytics, IconChecklist, IconSparkles, IconBrain, IconSettings, IconSun, IconPlus, IconWindow, IconClock } from "./AppleIcons";
import ChatView from "./ChatView";
import JournalView from "./JournalView";
import ReportsView from "./ReportsView";
import SettingsView from "./SettingsView";
import HistoryView from "./HistoryView";
import PlanView, { type PlanSection } from "./PlanView";
import { Today, InsightsPage, Memories, Joys, Review, periodEnd } from "./CompanionPages";
import {
  executeFocusCommand,
  formatClock,
  setFocusSink,
  useFocusClock,
  type FocusControlCommand,
} from "../../services/focusClock";
import { connectDashboardEvents } from "../../services/dashboardEvents";
import "./companion.css";
const nav = [
  ["today", "今天", IconCalendar], ["plan", "安排", IconClock], ["chat", "对话", IconChat], ["insights", "洞察", IconAnalytics],
  ["journal", "日记", IconChecklist], ["joy", "小确幸", IconSparkles], ["memory", "记忆", IconBrain], ["settings", "设置", IconSettings],
] as const;
type Page = typeof nav[number][0] | "history" | "reports";
export default function DashboardLayout() {
  const [page, setPage] = useState<Page>("today");
  const [planSection, setPlanSection] = useState<PlanSection>("tasks");
  const clock = useFocusClock();
  const [thread, setThread] = useState(() => crypto.randomUUID() as string);
  const [chatVisited, setChatVisited] = useState(false);
  useEffect(() => {
    if (page === "chat")
      setChatVisited(true);
  }, [page]);
  const [launch, setLaunch] = useState<{
    id: number;
    text: string;
  }>();
  const [review, setReview] = useState(false), [reviewOpen, setReviewOpen] = useState(false);
  const [revision, setRevision] = useState(0), [day, setDay] = useState<string>();
  const [period, setPeriod] = useState<"weekly" | "monthly">("weekly"), [offset, setOffset] = useState(0);
  const [compose, setCompose] = useState(false), [ready, setReady] = useState(false);
  const [section, setSection] = useState<"general" | "schedule">("general");
  const [dark, setDark] = useState(() => localStorage.getItem("taiwanbot_theme") === "dark");
  const [source, setSource] = useState<{
    content: string;
    session_date: string;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const saved = useCallback(() => setRevision(n => n + 1), []);
  const journal = (v: string) => {
    setDay(v);
    setPage("journal");
  };
  const navigate = (p: Page) => {
    setPage(p);
    setCompose(false);
    setSection("general");
    if (p === "journal")
      setDay(undefined);
  };
  const openThread = (id: string) => {
    setLaunch(undefined);
    setThread(id);
    setReview(false);
    setReviewOpen(false);
    setPage("chat");
  };
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("taiwanbot_theme", dark ? "dark" : "light");
  }, [dark]);
  const [serviceDetail, setServiceDetail] = useState("");
  useEffect(() => {
    let live = true;
    let isReady = false;
    let timer: number | null = null;
    const scheduleNext = () => {
      if (!live) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void check(), isReady ? 5000 : 700);
    };
    async function check() {
      try {
        await api.getHealth();
        if (!live) return;
        const wasReady = isReady;
        isReady = true;
        setReady(true);
        if (!wasReady) {
          window.dispatchEvent(new Event("linger-backend-ready"));
        }
        const models = await api.getModelStatus();
        if (live) setServiceDetail(models.downloading ? "正在下载语音模型" : models.error ? "语音模型下载失败" :
          models.missing.length ? "语音模型未就绪" : "");
      } catch {
        if (live) {
          isReady = false;
          setReady(false);
          setServiceDetail((prev) => prev || "等待本地服务");
        }
      } finally {
        scheduleNext();
      }
    }
    void window.taiwanBotEnv?.getBackendStatus?.().then((status) => {
      if (!live || !status) return;
      if (status.state !== "ready") setServiceDetail(status.detail);
      if (status.state === "ready") void check();
    }).catch(() => {});
    void check();
    const unsubscribe = window.taiwanBotEnv?.onBackendStatus?.(event => {
      if (event.state === "ready") {
        void check();
        return;
      }
      setServiceDetail(event.detail);
      if (event.state === "down") {
        isReady = false;
        setReady(false);
      }
    });
    return () => {
      live = false;
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe?.();
    };
  }, []);
  const parent = page === "history" ? "chat" : page === "reports" ? "insights" : page;
  const openPlan = (section: PlanSection) => {
    setPlanSection(section);
    setPage("plan");
  };
  const applyNavigateTarget = useCallback((target: DashboardNavigateTarget) => {
    const rawPage = String(target.page || "").trim().toLowerCase();
    if (rawPage === "tasks" || rawPage === "focus" || rawPage === "habits") {
      setPlanSection(rawPage);
      setPage("plan");
      return;
    }
    if (rawPage === "plan") {
      if (target.planSection) setPlanSection(target.planSection);
      setPage("plan");
      return;
    }
    if (rawPage === "journal") {
      setDay(target.date || undefined);
      setPage("journal");
      return;
    }
    if (
      rawPage === "today" ||
      rawPage === "chat" ||
      rawPage === "insights" ||
      rawPage === "joy" ||
      rawPage === "memory" ||
      rawPage === "settings" ||
      rawPage === "history" ||
      rawPage === "reports"
    ) {
      setPage(rawPage);
      setCompose(false);
    }
  }, []);

  useEffect(() => {
    const offNavigate = window.taiwanBotEnv?.onDashboardNavigate?.((target) => {
      applyNavigateTarget(target);
    });
    const offEvents = connectDashboardEvents({
      onUiCommand: (action, payload) => {
        if (action === "focus_control") {
          const cmd = payload as unknown as FocusControlCommand;
          const outcome = executeFocusCommand(cmd);
          if (outcome.ok && cmd.open_panel === true && cmd.action !== "status") {
            setPlanSection("focus");
            setPage("plan");
            window.taiwanBotEnv?.openDashboard?.({ page: "plan", planSection: "focus" });
          }
          return {
            ok: outcome.ok,
            result: {
              conflict: Boolean(outcome.conflict),
              state: outcome.state,
            },
            error: outcome.error,
          };
        }
        if (action === "navigate") {
          const target: DashboardNavigateTarget = {
            page: String(payload.page || "today"),
            date: typeof payload.date === "string" ? payload.date : undefined,
          };
          applyNavigateTarget(target);
          window.taiwanBotEnv?.openDashboard?.(target);
          return { ok: true, result: { page: target.page } };
        }
        return { ok: false, error: `未知的面板指令：${action}` };
      },
    });
    const onDataChanged = () => setRevision((n) => n + 1);
    window.addEventListener("linger-data-changed", onDataChanged);
    return () => {
      offNavigate?.();
      offEvents();
      window.removeEventListener("linger-data-changed", onDataChanged);
    };
  }, [applyNavigateTarget]);
  useEffect(() => {
    setFocusSink(async (item) => {
      await api.recordFocus({
        client_id: item.client_id,
        task_id: item.task_id,
        kind: item.kind,
        planned_seconds: item.planned_seconds,
        actual_seconds: item.actual_seconds,
        started_at: item.started_at,
        session_date: item.session_date,
        completed: item.completed,
      });
      if (item.finish_task && item.task_id) {
        try {
          await api.updateTask(item.task_id, { status: "done" });
        } catch (err) {
          if (!String(err).includes("找不到")) throw err;
        }
      }
      window.dispatchEvent(new Event("linger-plan"));
    });
    return () => setFocusSink(null);
  }, []);
  function start(text: string) {
    setLaunch({ id: Date.now(), text });
    setReview(text.includes("复盘"));
    setPage("chat");
  }
  return <div className="l-shell">
    <aside className="l-sidebar">
      <div className="l-brand"><img alt="灵儿" src="./linger/crystal_badge.png" /></div>
      <button className="l-new" aria-label="新对话" onClick={() => openThread(crypto.randomUUID())}>
        <IconPlus />
      </button>
      <nav aria-label="主导航">
        {nav.map(([id, label, Icon]) => (
          <button key={id} aria-label={id === "plan" && clock.phase !== "idle" ? `${label}，${clock.phase === "focus" ? "专注中" : "休息中"} ${formatClock(clock.remaining)}` : label} aria-current={parent === id ? "page" : undefined} onClick={() => navigate(id)}>
            <Icon />
          </button>
        ))}
      </nav>
      <footer>
        <span role="status" tabIndex={0} aria-label={serviceDetail || (ready ? "本地服务已连接" : "等待本地服务")}>
          <i className={ready ? (serviceDetail ? "pending" : "online") : "offline"} />
        </span>
        <button aria-label="切换主题" onClick={() => setDark(!dark)}><IconSun /></button>
        {window.taiwanBotEnv && <button aria-label="显示或隐藏桌宠" onClick={() => window.taiwanBotEnv?.togglePetVisibility()}><IconWindow /></button>}
      </footer>
    </aside>

    <main className="l-main">
      {window.taiwanBotEnv && <div className="l-window-drag" aria-hidden="true" />}
      {clock.phase !== "idle" && !(page === "plan" && planSection === "focus") && <button className="l-focus-banner" onClick={() => openPlan("focus")}>
        {clock.phase === "focus" ? "专注中" : "休息中"} {formatClock(clock.remaining)}
        {clock.taskTitle ? ` · ${clock.taskTitle}` : ""}
      </button>}

      {page === "today" && <Today ready={ready} send={start} habits={() => openPlan("habits")} tasks={() => openPlan("tasks")} focus={() => openPlan("focus")} insights={() => {
        setPeriod("weekly");
        setOffset(0);
        setPage("insights");
      }} joy={() => {
        setCompose(true);
        setPage("joy");
      }} settings={() => {
        setSection("schedule");
        setPage("settings");
      }} />}

      {(page === "chat" || chatVisited) && <div className="l-chat-wrap" style={page === "chat" ? undefined : { display: "none" }}>
        <div className="l-chat-main"><ChatView key={thread} threadId={thread} launch={launch} onConsumed={() => setLaunch(undefined)} onJournal={journal} onHistory={() => setPage("history")} onReview={() => setReview(true)} onMemory={() => setPage("memory")} onSaved={saved} /></div>
        {review && <>
          <button className="l-review-toggle l-pill" onClick={() => setReviewOpen(!reviewOpen)}>{reviewOpen ? "关闭复盘" : "查看今日复盘"}</button>
          <div className={"l-review-slot " + (reviewOpen ? "open" : "")}><Review date={formatLocalDate()} revision={revision} open={() => journal(formatLocalDate())} /></div>
        </>}
      </div>}

      {page === "insights" && <InsightsPage period={period} offset={offset} select={p => {
        setPeriod(p);
        setOffset(0);
      }} shift={setOffset} report={() => setPage("reports")} day={journal} />}

      {page === "journal" && <JournalView initialDate={day} />}

      {page === "joy" && <Joys compose={compose} />}

      {page === "memory" && <Memories source={async (id) => {
        try {
          const m = await api.message(id);
          if (m.thread_id)
            openThread(m.thread_id);
          setSource(m);
        }
        catch (e) {
          setNotice(String(e));
        }
      }} />}

      {page === "settings" && <SettingsView initialSection={section} />}

      {page === "plan" && <PlanView section={planSection} select={setPlanSection} />}

      {page === "reports" && <>
        <button className="l-back" onClick={() => setPage("insights")}>‹ 返回洞察</button>
        <ReportsView endDate={periodEnd(period, offset)} initialPeriod={period} />
      </>}

      {page === "history" && <>
        <button className="l-back" onClick={() => setPage("chat")}>‹ 返回对话</button>
        <HistoryView />
      </>}

      {source && <div className="l-dialog">
        <article className="l-card">
          <h2>来源消息</h2>
          <time>{source.session_date}</time>
          <p>{source.content}</p>
          <button className="l-pill" onClick={() => setSource(null)}>关闭</button>
        </article>
      </div>}

      {notice && <button className="l-error" onClick={() => setNotice("")}>
        {notice} ×
      </button>}

    </main>
  </div>;
}
