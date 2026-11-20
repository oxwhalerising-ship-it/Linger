/**
 * ChatGPT Desktop 风格周报与月报 AI 复盘分析页（ReportsView）
 * ----------------------------------------------------------
 * 一键生成「本周周报」与「本月月报」，呈现极简 KPI 指标、
 * 情绪/精力双曲线趋势图、习惯达成明细与灵儿台湾腔暖心编辑感点评。
 */

import { useCallback, useEffect, useState } from "react";
import { api, type ReportItem } from "../../services/api";
import type { DashboardViewProps } from "./DashboardLayout";
import { IconSidebar, IconSparkles } from "./AppleIcons";

/** 极简双曲线 SVG 趋势图 */
function MoodEnergyChart({
  trend,
}: {
  trend: Array<{
    date: string;
    mood_score: number | null;
    energy_score: number | null;
  }>;
}) {
  const validPoints = trend.filter(
    (p) => p.mood_score !== null || p.energy_score !== null,
  );
  if (validPoints.length === 0) {
    return (
      <div className="h-36 flex items-center justify-center text-[12px] text-[var(--text-tertiary)] bg-[var(--bg-subtle)]/60 rounded-xl border border-[var(--border-subtle)]">
        该周期暂无情绪与精力打分，可在「日历与小确幸」或对话中记录
      </div>
    );
  }

  const width = 520;
  const height = 148;
  const padX = 28;
  const padY = 18;
  const stepX =
    validPoints.length > 1
      ? (width - padX * 2) / (validPoints.length - 1)
      : 0;

  const toY = (score: number) =>
    height - padY - ((score - 1) / 4) * (height - padY * 2);

  const buildPath = (key: "mood_score" | "energy_score") => {
    const pts: string[] = [];
    validPoints.forEach((p, idx) => {
      const val = p[key];
      if (typeof val === "number") {
        const x = padX + idx * stepX;
        const y = toY(val);
        pts.push(
          `${pts.length === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`,
        );
      }
    });
    return pts.join(" ");
  };

  return (
    <div className="rounded-xl bg-[var(--bg-subtle)]/60 border border-[var(--border-subtle)] p-4 space-y-2.5">
      <div className="flex items-center justify-between text-[11.5px] text-[var(--text-tertiary)]">
        <span>情绪 & 精力变化趋势（1~5 分）</span>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
            <span className="w-2 h-2 rounded-full bg-sky-500 inline-block" />
            情绪
          </span>
          <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
            <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
            精力
          </span>
        </div>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-36">
        {[1, 2, 3, 4, 5].map((lv) => (
          <line
            key={lv}
            x1={padX}
            x2={width - padX}
            y1={toY(lv)}
            y2={toY(lv)}
            stroke="currentColor"
            strokeOpacity="0.09"
            strokeDasharray="3 3"
          />
        ))}
        <path
          d={buildPath("mood_score")}
          fill="none"
          stroke="#0ea5e9"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={buildPath("energy_score")}
          fill="none"
          stroke="#10b981"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {validPoints.map((p, idx) => {
          const x = padX + idx * stepX;
          return (
            <g key={p.date}>
              {typeof p.mood_score === "number" && (
                <circle
                  cx={x}
                  cy={toY(p.mood_score)}
                  r="3.5"
                  fill="#0ea5e9"
                />
              )}
              {typeof p.energy_score === "number" && (
                <circle
                  cx={x}
                  cy={toY(p.energy_score)}
                  r="3.5"
                  fill="#10b981"
                />
              )}
              <text
                x={x}
                y={height - 2}
                textAnchor="middle"
                fontSize="9.5"
                fill="currentColor"
                opacity="0.45"
              >
                {p.date.slice(5)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function ReportsView({
  sidebarOpen,
  onToggleSidebar,
}: DashboardViewProps) {
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [selected, setSelected] = useState<ReportItem | null>(null);
  const [generating, setGenerating] = useState<"weekly" | "monthly" | null>(
    null,
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadReports = useCallback(async () => {
    try {
      const res = await api.listReports();
      setReports(res.reports);
      if (res.reports.length > 0) {
        setSelected((prev) => prev ?? res.reports[0]);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  const handleGenerate = async (periodType: "weekly" | "monthly") => {
    setGenerating(periodType);
    setErrorMsg(null);
    try {
      const created = await api.generateReport(periodType);
      setSelected(created);
      const res = await api.listReports();
      setReports(res.reports);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "生成报告失败");
    } finally {
      setGenerating(null);
    }
  };

  return (
    <div className="h-full flex flex-col bg-[var(--bg-canvas)]">
      {/* 顶部 52px 极简栏 */}
      <header className="h-[52px] px-4 flex items-center justify-between gap-3 shrink-0 select-none">
        <div className="flex items-center gap-2">
          {!sidebarOpen && (
            <button
              type="button"
              onClick={onToggleSidebar}
              title="展开侧边栏 (Ctrl+\)"
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              <IconSidebar className="w-[17px] h-[17px]" />
            </button>
          )}
          <span className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)] px-1">
            周报与月报
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={generating !== null}
            onClick={() => void handleGenerate("weekly")}
            className="h-8 px-3.5 rounded-full bg-[var(--ink-primary)] hover:bg-[var(--ink-primary-hover)] disabled:opacity-40 text-[var(--ink-primary-fg)] text-[12.5px] font-medium transition-colors cursor-pointer"
          >
            {generating === "weekly" ? "生成周报中..." : "生成本周周报"}
          </button>
          <button
            type="button"
            disabled={generating !== null}
            onClick={() => void handleGenerate("monthly")}
            className="h-8 px-3.5 rounded-full bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] disabled:opacity-40 text-[var(--text-primary)] text-[12.5px] font-medium transition-colors cursor-pointer"
          >
            {generating === "monthly" ? "生成月报中..." : "生成本月月报"}
          </button>
        </div>
      </header>

      {/* 主内容区域 */}
      <div className="flex-1 overflow-y-auto px-5 sm:px-8 pb-10 pt-2">
        <div className="max-w-[960px] mx-auto space-y-6">
          {/* 历史报告横向切换条 */}
          {reports.length > 0 && (
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
              {reports.map((rep) => {
                const active = selected?.id === rep.id;
                return (
                  <button
                    key={rep.id}
                    type="button"
                    onClick={() => setSelected(rep)}
                    className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors shrink-0 cursor-pointer tabular-nums ${
                      active
                        ? "bg-[var(--ink-primary)] text-[var(--ink-primary-fg)]"
                        : "bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {rep.period_type === "weekly" ? "周报" : "月报"} ·{" "}
                    {rep.start_date} ~ {rep.end_date}
                  </button>
                );
              })}
            </div>
          )}

          {errorMsg && (
            <div className="px-4 py-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-[13px]">
              {errorMsg}
            </div>
          )}

          {selected ? (
            <div className="space-y-6 animate-fade-up">
              {/* 4 宫格极简 KPI 指标栏 */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
                <div className="rounded-2xl bg-[var(--bg-surface)] p-4.5 border border-[var(--border-subtle)] space-y-1">
                  <span className="text-[12px] text-[var(--text-tertiary)]">
                    综合习惯达成率
                  </span>
                  <div className="text-[28px] font-semibold tracking-tight text-emerald-500 tabular-nums">
                    {selected.stats.overall_completion_rate ?? 0}%
                  </div>
                  <span className="text-[11.5px] text-[var(--text-tertiary)] tabular-nums">
                    记录 {selected.stats.logged_days}/{selected.stats.total_days}{" "}
                    天
                  </span>
                </div>

                <div className="rounded-2xl bg-[var(--bg-surface)] p-4.5 border border-[var(--border-subtle)] space-y-1">
                  <span className="text-[12px] text-[var(--text-tertiary)]">
                    平均情绪分
                  </span>
                  <div className="text-[28px] font-semibold tracking-tight text-[var(--text-primary)] tabular-nums">
                    {selected.stats.avg_mood ?? "--"}
                  </div>
                  <span className="text-[11.5px] text-[var(--text-tertiary)]">
                    满分 5.0
                  </span>
                </div>

                <div className="rounded-2xl bg-[var(--bg-surface)] p-4.5 border border-[var(--border-subtle)] space-y-1">
                  <span className="text-[12px] text-[var(--text-tertiary)]">
                    平均精力分
                  </span>
                  <div className="text-[28px] font-semibold tracking-tight text-[var(--text-primary)] tabular-nums">
                    {selected.stats.avg_energy ?? "--"}
                  </div>
                  <span className="text-[11.5px] text-[var(--text-tertiary)]">
                    满分 5.0
                  </span>
                </div>

                <div className="rounded-2xl bg-[var(--bg-surface)] p-4.5 border border-[var(--border-subtle)] space-y-1">
                  <span className="text-[12px] text-[var(--text-tertiary)]">
                    小确幸收获
                  </span>
                  <div className="text-[28px] font-semibold tracking-tight text-amber-500 tabular-nums">
                    {selected.stats.highlights?.length ?? 0}
                  </div>
                  <span className="text-[11.5px] text-[var(--text-tertiary)] tabular-nums">
                    {selected.start_date} ~ {selected.end_date}
                  </span>
                </div>
              </div>

              {/* 暖心编辑感点评 + 趋势明细 */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                <section className="lg:col-span-7 rounded-2xl bg-[var(--bg-surface)] p-6 border border-[var(--border-subtle)] space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[15.5px] font-semibold text-[var(--text-primary)] flex items-center gap-2">
                      <IconSparkles className="w-4 h-4 text-[var(--text-secondary)]" />
                      <span>灵儿的台湾腔暖心点评</span>
                    </h3>
                    <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-[var(--bg-subtle)] text-[var(--text-secondary)] font-medium">
                      {selected.period_type === "weekly" ? "周报" : "月报"}
                    </span>
                  </div>

                  <div className="text-[14.5px] leading-[1.8] text-[var(--text-primary)] whitespace-pre-wrap">
                    {selected.ai_analysis}
                  </div>

                  <p className="pt-3 border-t border-[var(--border-subtle)] text-[11px] font-mono text-[var(--text-tertiary)] break-all">
                    Markdown 导出：{selected.md_path}
                  </p>
                </section>

                <section className="lg:col-span-5 rounded-2xl bg-[var(--bg-surface)] p-5 border border-[var(--border-subtle)] space-y-5">
                  <h3 className="text-[15px] font-semibold text-[var(--text-primary)]">
                    趋势与习惯达成明细
                  </h3>

                  <MoodEnergyChart trend={selected.stats.trend || []} />

                  <div className="space-y-3">
                    {(selected.stats.habit_breakdown || []).map((h) => (
                      <div key={h.habit_id} className="space-y-1.5">
                        <div className="flex justify-between text-[12.5px]">
                          <span className="font-medium text-[var(--text-primary)]">
                            {h.title}
                          </span>
                          <span className="text-[var(--text-tertiary)] tabular-nums">
                            {h.completion_rate}% · {h.done} 天
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-[var(--bg-subtle)] overflow-hidden">
                          <div
                            className="h-full rounded-full bg-[var(--ink-primary)] transition-all duration-500"
                            style={{ width: `${h.completion_rate}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-14 text-center space-y-2.5">
              <div className="w-10 h-10 rounded-full bg-[var(--bg-subtle)] mx-auto flex items-center justify-center text-[var(--text-secondary)]">
                <IconSparkles className="w-5 h-5" />
              </div>
              <h3 className="text-[16px] font-semibold text-[var(--text-primary)]">
                还没有生成过周期报告
              </h3>
              <p className="text-[13px] text-[var(--text-tertiary)] max-w-md mx-auto">
                点击右上角「生成本周周报」即可汇总你最近的打卡、情绪曲线与小确幸，由灵儿为你写出暖心周期点评。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
