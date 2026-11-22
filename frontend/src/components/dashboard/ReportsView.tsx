import { useState, useEffect } from "react";
import { api, formatLocalDate, type ReportItem } from "../../services/api";
import { isNetworkFetchError } from "../../services/api/client";
import { Trend } from "./CompanionPages";
export default function ReportsView({ endDate, initialPeriod }: {
  endDate: string;
  initialPeriod: "weekly" | "monthly";
}) {
  const [reports, setReports] = useState<ReportItem[]>([]), [selected, setSelected] = useState<ReportItem | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const label = initialPeriod === "weekly" ? "周报" : "月报";
  useEffect(() => {
    let live = true;
    const load = () => {
      api.listReports().then(({ reports }) => {
        if (live) {
          setError("");
          setReports(reports);
          setSelected(current => current ?? reports.find(r => r.end_date === endDate && r.period_type === initialPeriod) ?? null);
        }
      }).catch(e => {
        if (live && !isNetworkFetchError(e))
          setError(String(e));
      });
    };
    load();
    window.addEventListener("linger-backend-ready", load);
    return () => {
      live = false;
      window.removeEventListener("linger-backend-ready", load);
    };
  }, [endDate, initialPeriod]);
  async function generate() {
    setBusy(true);
    setError("");
    try {
      const r = await api.generateReport(initialPeriod, endDate);
      setSelected(r);
      setReports(list => [r, ...list.filter(v => v.id !== r.id)]);
    }
    catch (e) {
      setError(String(e));
    }
    finally {
      setBusy(false);
    }
  }
  async function download() {
    if (!selected)
      return;
    try {
      const { text } = await api.reportMarkdown(selected.id);
      const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = selected.start_date + "-成长报告.md";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    catch (e) {
      setError(String(e));
    }
  }
  const days = selected ? Array.from({ length: selected.stats.total_days }, (_, i) => {
    const d = new Date(selected.start_date + "T12:00:00");
    d.setDate(d.getDate() + i);
    return formatLocalDate(d);
  }) : [];
  return <div className="l-page">
    <header className="l-head">
      <h1>成长
        {label}
      </h1>
      <div className="l-actions">
        <button disabled={busy} onClick={generate}>{busy ? "正在生成…" : "生成所选" + label}</button>
        {selected && <button onClick={download}>导出 Markdown</button>}
      </div>
    </header>

    <div className="l-subhead">
      <time>统计截止
        {endDate}
      </time>
      <select aria-label="历史报告" value={selected?.id ?? ""} onChange={e => setSelected(reports.find(r => r.id === Number(e.target.value)) ?? null)}>
        <option value="">选择历史报告</option>
        {reports.map(r => <option key={r.id} value={r.id}>
          {r.period_type === "weekly" ? "周报" : "月报"} ·
          {r.start_date} —
          {r.end_date}
        </option>)}
      </select>
    </div>

    {error && <p className="l-error" role="alert">{error}</p>}

    {selected ? <article className="l-card l-report">
      <header>
        <h2>成长
          {selected.period_type === "weekly" ? "周报" : "月报"}
        </h2>
        <time>
          {selected.start_date} —
          {selected.end_date}
        </time>
      </header>

      <div className="l-report-body">
        <nav aria-label="报告章节">{[["overview", "概览"], ["habits", "习惯"], ["mood", "情绪与精力"], ["joys", "小确幸"]].map(([id, label]) => <button key={id} onClick={() => document.getElementById("report-" + id)?.scrollIntoView({ block: "start" })}>{label}</button>)}</nav>

        <div>
          <section id="report-overview">
            <h2>灵儿的观察</h2>
            {selected.ai_analysis.split("\n").filter(Boolean).map((line, i) => line.startsWith("#") ? <h3 key={i}>{line.replace(/^#+\s*/, "")}</h3> : <p key={i}>{line}</p>)}
          </section>

          <section id="report-habits">
            <h2>习惯完成情况</h2>
            {selected.stats.daily_done && <div className="l-columns" aria-label="每日习惯完成数">{days.map(d => <div key={d} title={d + " · " + (selected.stats.daily_done?.[d] || 0) + " 项"} style={{ height: Math.max(3, (selected.stats.daily_done?.[d] || 0) / Math.max(1, ...Object.values(selected.stats.daily_done || {})) * 100) + "%" }} />)}</div>}
            {selected.stats.habit_breakdown.map(h => <label className="l-bar" key={h.habit_id}>
              {h.title}
              <progress value={h.completion_rate} max={100} />
              {h.completion_rate}%
            </label>)}
          </section>

          <section id="report-mood">
            <h2>情绪与精力</h2>
            <Trend stats={selected.stats} />
            <p>平均心情
              {selected.stats.avg_mood ?? "—"}　平均精力
              {selected.stats.avg_energy ?? "—"}
            </p>
          </section>
          <section id="report-joys">
            <h2>小确幸 ·
              {selected.stats.highlights.length} 件
            </h2>
            {selected.stats.highlights.map((v, i) => <p key={i}>
              {v.date}
              {v.text}
            </p>)}
          </section>
        </div>
      </div>
    </article> : <div className="l-card">
      <h2>这一期的成长记录</h2>
      <p>点击「生成所选
        {label}」，查看这段时间的习惯、心情与小确幸。
      </p>
    </div>}
  </div>;
}
