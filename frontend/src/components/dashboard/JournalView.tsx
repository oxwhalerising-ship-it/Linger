/**
 * ChatGPT Desktop 风格日历热力图、小确幸罐子与 Markdown 日记（JournalView）
 * -----------------------------------------------------------------------
 * 左侧：月度打卡热力图日历，支持快捷回到今天与高亮小确幸标记。
 * 右侧：编辑感复盘日记卡片（情绪/精力评分、习惯打卡、每日小确幸罐子）与代码块风格 Markdown 原文预览。
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  formatLocalDate,
  type DailyLogDetail,
  type MonthlyHeatmapDay,
} from "../../services/api";
import {
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconSparkles,
} from "./AppleIcons";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function getMonthDaysGrid(
  year: number,
  monthIndex: number,
): Array<string | null> {
  const firstDay = new Date(year, monthIndex, 1).getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cells: Array<string | null> = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const mm = String(monthIndex + 1).padStart(2, "0");
    const dd = String(d).padStart(2, "0");
    cells.push(`${year}-${mm}-${dd}`);
  }
  return cells;
}

export default function JournalView({initialDate}: {initialDate?:string}) {
  const today = new Date();
  const todayStr = formatLocalDate(today);
  const [year, setYear] = useState(Number(initialDate?.slice(0,4)) || today.getFullYear());
  const [monthIdx, setMonthIdx] = useState(initialDate ? Number(initialDate.slice(5,7))-1 : today.getMonth());
  const [selectedDate, setSelectedDate] = useState(initialDate || todayStr);

  const [monthMap, setMonthMap] = useState<Record<string, MonthlyHeatmapDay>>(
    {},
  );
  const [detailOpen,setDetailOpen]=useState(Boolean(initialDate));
  const selectedRef=useRef(selectedDate);
  selectedRef.current=selectedDate;
  const monthRef=useRef("");
  const [detail, setDetail] = useState<DailyLogDetail | null>(null);
  const [summaryDraft,setSummaryDraft]=useState<string|null>(null);
  const [error,setError]=useState("");
  const [newHighlight, setNewHighlight] = useState("");
  const [showMarkdown, setShowMarkdown] = useState(false);
  const [copied, setCopied] = useState(false);

  const monthStr = `${year}-${String(monthIdx + 1).padStart(2, "0")}`;

  monthRef.current=monthStr;
  const loadMonth = useCallback(async () => {
    try {
      const res = await api.getMonthlyLogs(monthStr);
      const map: Record<string, MonthlyHeatmapDay> = {};
      for (const day of res.days) {
        map[day.date] = day;
      }
      if(monthRef.current===monthStr)setMonthMap(map);
    } catch (e) {
      setError(String(e));
    }
  }, [monthStr]);

  const loadDayDetail = useCallback(async (dateStr: string) => {
    try {
      const res = await api.getDailyLog(dateStr);
      if(selectedRef.current===dateStr)setDetail(res);
    } catch(e) {
      if(selectedRef.current===dateStr){setDetail(null);setError(String(e))}
    }
  }, []);

  useEffect(() => {
    void loadMonth();
  }, [loadMonth]);

  useEffect(() => {
    setSummaryDraft(null);setDetail(null);setError("");
    void loadDayDetail(selectedDate);
  }, [loadDayDetail, selectedDate]);

  const handleScoreUpdate = async (
    field: "mood_score" | "energy_score",
    score: number,
  ) => {
    try {
      const updated = await api.upsertDailyLog(selectedDate, {
        [field]: score,
      });
      if(selectedRef.current===updated.date)setDetail(updated);
      await loadMonth();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleAddHighlight = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newHighlight.trim();
    if (!trimmed) return;

    try {
      const updated = await api.appendHighlight(selectedDate, trimmed);
      if(selectedRef.current===updated.date)setDetail(updated);
      setNewHighlight("");
      await loadMonth();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCopyMarkdown = async () => {
    if (!detail?.markdown_content) return;
    await navigator.clipboard.writeText(detail.markdown_content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const shiftMonth = (delta: number) => {
    const next = new Date(year, monthIdx + delta, 1);
    setYear(next.getFullYear());
    setMonthIdx(next.getMonth());
  };

  const jumpToToday = () => {
    setYear(today.getFullYear());
    setMonthIdx(today.getMonth());
    setSelectedDate(todayStr);
  };

  const cells = getMonthDaysGrid(year, monthIdx);

  return (
    <div className="h-full flex flex-col bg-[var(--bg-canvas)]">
      {/* 顶部 52px 极简栏 */}
      <header className="h-[52px] px-4 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-2">

          <span className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)] px-1">
            日历与小确幸
          </span>
        </div>

        {/* 右侧视图切换胶囊 */}
        <div className="inline-flex p-0.5 rounded-full bg-[var(--bg-subtle)] border border-[var(--border-subtle)]">
          <button
            type="button"
            onClick={() => setShowMarkdown(false)}
            className={`px-3 py-1 rounded-full text-[12px] font-medium transition-colors cursor-pointer ${
              !showMarkdown
                ? "bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-xs"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            卡片视图
          </button>
          <button
            type="button"
            onClick={() => setShowMarkdown(true)}
            className={`px-3 py-1 rounded-full text-[12px] font-medium transition-colors cursor-pointer ${
              showMarkdown
                ? "bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-xs"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            Markdown 原文
          </button>
        </div>
      </header>

      {/* 主内容区域 */}
      <div className="flex-1 overflow-y-auto px-5 sm:px-8 pb-10 pt-2">
        <div className={"l-journal-grid max-w-[960px] mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 items-start "+(detailOpen?"detail-open":"")}>
          {/* 左侧：月度打卡热力图日历 */}
          <section className="lg:col-span-5 rounded-2xl bg-[var(--bg-surface)] p-5 border border-[var(--border-subtle)] space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)] tabular-nums">
                {year} 年 {monthIdx + 1} 月
              </h3>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={jumpToToday}
                  className="px-2.5 h-7 rounded-lg text-[11.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                >
                  今天
                </button>
                <button
                  type="button"
                  onClick={() => shiftMonth(-1)}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                >
                  <IconChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => shiftMonth(1)}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                >
                  <IconChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-7 gap-1.5 text-center">
              {WEEKDAYS.map((w) => (
                <div
                  key={w}
                  className="text-[11px] font-medium text-[var(--text-tertiary)] py-1"
                >
                  {w}
                </div>
              ))}

              {cells.map((dateStr, idx) => {
                if (!dateStr) {
                  return <div key={`empty-${idx}`} className="h-9" />;
                }
                const info = monthMap[dateStr];
                const done = info?.done_count ?? 0;
                const isSelected = dateStr === selectedDate;
                const isToday = dateStr === todayStr;

                let heatClass =
                  "bg-[var(--bg-subtle)]/75 text-[var(--text-secondary)] hover:bg-[var(--bg-active)]";
                if (done >= 3) {
                  heatClass =
                    "bg-emerald-500 text-white font-semibold hover:bg-emerald-600";
                } else if (done === 2) {
                  heatClass =
                    "bg-emerald-500/45 text-emerald-950 dark:text-emerald-100 font-medium";
                } else if (done === 1 || info?.summary) {
                  heatClass =
                    "bg-emerald-500/18 text-emerald-800 dark:text-emerald-300";
                }

                return (
                  <button
                    key={dateStr}
                    type="button"
                    onClick={() => {setSelectedDate(dateStr);setDetailOpen(true)}}
                    className={`h-9 rounded-xl text-[12px] tabular-nums flex flex-col items-center justify-center transition-all cursor-pointer relative ${heatClass} ${
                      isSelected
                        ? "ring-2 ring-[var(--ink-primary)] ring-offset-2 ring-offset-[var(--bg-canvas)]"
                        : isToday
                          ? "ring-1 ring-[var(--border-strong)]"
                          : ""
                    }`}
                  >
                    <span>{Number(dateStr.slice(8))}</span>
                    {info?.highlights?.length ? (
                      <span className="w-1 h-1 rounded-full bg-amber-400 mt-0.5" />
                    ) : null}
                  </button>
                );
              })}
            </div>

            {/* 极简图例 */}
            <div className="pt-3 border-t border-[var(--border-subtle)] flex items-center justify-between text-[11px] text-[var(--text-tertiary)]">
              <div className="flex items-center gap-1.5">
                <span>打卡热力</span>
                <span className="w-2.5 h-2.5 rounded-[4px] bg-[var(--bg-subtle)] inline-block" />
                <span className="w-2.5 h-2.5 rounded-[4px] bg-emerald-500/20 inline-block" />
                <span className="w-2.5 h-2.5 rounded-[4px] bg-emerald-500/50 inline-block" />
                <span className="w-2.5 h-2.5 rounded-[4px] bg-emerald-500 inline-block" />
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                <span>含小确幸</span>
              </div>
            </div>
          </section>

          {/* 右侧：选中日期复盘详情 */}
          <section className="lg:col-span-7 rounded-2xl bg-[var(--bg-surface)] p-6 border border-[var(--border-subtle)] space-y-6">
            <button className="l-mobile-back l-text" onClick={()=>setDetailOpen(false)}>‹ 选择日期</button>
            <div className="space-y-1">
              <h3 className="text-[18px] font-semibold tracking-tight text-[var(--text-primary)] tabular-nums">
                {selectedDate} 复盘日记
              </h3>
              <p className="text-[11.5px] text-[var(--text-tertiary)] font-mono break-all">
                {detail?.md_path || "本地 Obsidian Markdown 自动同步"}
              </p>
            </div>

            {error&&<p className="l-error" role="alert">{error}</p>}
            {!showMarkdown && detail?.date===selectedDate && <section className="l-editor">
              {summaryDraft===null ? <><p>{detail.summary || "这一天还没有写下正文。"}</p>
                <button className="l-pill" onClick={()=>setSummaryDraft(detail.summary)}>编辑日记</button></> :
                <form onSubmit={async e=>{e.preventDefault();try{const result=await api.upsertDailyLog(selectedDate,{summary:summaryDraft});if(selectedRef.current===result.date){setDetail(result);setSummaryDraft(null)}await loadMonth()}catch(e){setError(String(e))}}}>
                  <textarea autoFocus aria-label="日记正文" value={summaryDraft} onChange={e=>setSummaryDraft(e.target.value)}/>
                  <button className="l-primary">保存正文</button> <button type="button" className="l-pill" onClick={()=>setSummaryDraft(null)}>取消</button>
                </form>}
            </section>}
            {showMarkdown ? (
              /* ChatGPT 代码块风格 Markdown 原文预览 */
              <div className="rounded-xl border border-[var(--border-subtle)] overflow-hidden bg-[var(--bg-subtle)]/60">
                <div className="px-3.5 py-2 border-b border-[var(--border-subtle)] flex items-center justify-between text-[11.5px] text-[var(--text-tertiary)]">
                  <span className="font-mono">{selectedDate}.md</span>
                  <button
                    type="button"
                    onClick={() => void handleCopyMarkdown()}
                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                  >
                    {copied ? (
                      <>
                        <IconCheck className="w-3.5 h-3.5 text-emerald-500" />
                        <span>已复制</span>
                      </>
                    ) : (
                      <>
                        <IconCopy className="w-3.5 h-3.5" />
                        <span>复制代码</span>
                      </>
                    )}
                  </button>
                </div>
                <pre className="p-4 text-[12.5px] text-[var(--text-primary)] font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-[420px]">
                  {detail?.markdown_content || "暂无内容"}
                </pre>
              </div>
            ) : (
              <div className="space-y-6">
                {/* 情绪与精力评分点选 */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  {(
                    [
                      ["mood_score", "今日情绪", detail?.mood_score],
                      ["energy_score", "今日精力", detail?.energy_score],
                    ] as const
                  ).map(([field, label, currentVal]) => (
                    <div
                      key={field}
                      className="p-3.5 rounded-xl bg-[var(--bg-subtle)]/70 border border-[var(--border-subtle)] space-y-2.5"
                    >
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="font-medium text-[var(--text-secondary)]">
                          {label}
                        </span>
                        <span className="text-[var(--text-tertiary)] tabular-nums">
                          {currentVal ? `${currentVal} / 5` : "未评分"}
                        </span>
                      </div>
                      <div className="grid grid-cols-5 gap-1.5">
                        {[1, 2, 3, 4, 5].map((num) => (
                          <button
                            key={num}
                            type="button"
                            onClick={() => void handleScoreUpdate(field, num)}
                            className={`h-8 rounded-lg text-[12.5px] font-medium tabular-nums transition-all cursor-pointer ${
                              currentVal === num
                                ? "bg-[var(--ink-primary)] text-[var(--ink-primary-fg)] shadow-xs"
                                : "bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)]"
                            }`}
                          >
                            {num}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                {/* 当日习惯打卡记录 */}
                <div className="space-y-2.5">
                  <h4 className="text-[13px] font-medium text-[var(--text-secondary)]">
                    当日习惯记录
                  </h4>
                  {detail?.habit_records?.length ? (
                    <div className="flex flex-wrap gap-2">
                      {detail.habit_records.map((r) => (
                        <span
                          key={r.habit_id}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium border ${
                            r.status === "done"
                              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                              : r.status === "partial"
                                ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                : "border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--text-tertiary)]"
                          }`}
                        >
                          <span>
                            {r.status === "done"
                              ? "✓"
                              : r.status === "partial"
                                ? "◐"
                                : "○"}
                          </span>
                          <span>{r.habit_title}</span>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[12.5px] text-[var(--text-tertiary)]">
                      这一天还没有习惯打卡记录。
                    </p>
                  )}
                </div>

                {/* 每日小确幸罐子（克制温暖的编辑感卡片） */}
                <div
                  className="p-4 rounded-2xl space-y-3 border"
                  style={{
                    backgroundColor: "var(--warm-bg)",
                    borderColor: "var(--warm-border)",
                  }}
                >
                  <div className="flex items-center justify-between">
                    <h4
                      className="text-[13.5px] font-semibold flex items-center gap-1.5"
                      style={{ color: "var(--warm-text)" }}
                    >
                      <IconSparkles className="w-4 h-4" />
                      <span>每日小确幸罐子</span>
                    </h4>
                    <span
                      className="text-[11.5px] tabular-nums"
                      style={{ color: "var(--warm-muted)" }}
                    >
                      {detail?.highlights?.length ?? 0} 条收藏
                    </span>
                  </div>

                  {detail?.highlights?.length ? (
                    <ul className="space-y-1.5">
                      {detail.highlights.map((hl, i) => (
                        <li
                          key={`${hl}-${i}`}
                          className="text-[13.5px] text-[var(--text-primary)] bg-[var(--bg-surface)]/85 px-3.5 py-2 rounded-xl border border-[var(--border-subtle)] leading-relaxed"
                        >
                          {hl}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p
                      className="text-[12.5px] leading-relaxed"
                      style={{ color: "var(--warm-muted)" }}
                    >
                      哪怕只是喝到一杯好喝的奶茶、准时下班，都值得放进罐子里喔～
                    </p>
                  )}

                  <form onSubmit={handleAddHighlight} className="flex gap-2 pt-0.5">
                    <input
                      type="text"
                      value={newHighlight}
                      onChange={(e) => setNewHighlight(e.target.value)}
                      placeholder="往罐子里放一颗今天的小确幸..."
                      className="flex-1 h-9 px-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] focus:border-[var(--border-strong)] text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none transition-colors"
                    />
                    <button
                      type="submit"
                      disabled={!newHighlight.trim()}
                      className="px-4 h-9 rounded-xl bg-[var(--ink-primary)] hover:bg-[var(--ink-primary-hover)] disabled:opacity-30 text-[var(--ink-primary-fg)] text-[12.5px] font-medium transition-colors cursor-pointer shrink-0"
                    >
                      收藏
                    </button>
                  </form>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
