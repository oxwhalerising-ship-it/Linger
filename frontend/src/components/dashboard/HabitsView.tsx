/**
 * ChatGPT Desktop 风格习惯清单与今日打卡管理页（HabitsView）
 * ---------------------------------------------------------
 * 管理用户预设的每日习惯与关注事项，支持一键标记「完成 / 部分 / 未做」，
 * 实时同步本地 Obsidian Markdown 日记。
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  api,
  formatLocalDate,
  type HabitItem,
  type HabitRecordItem,
} from "../../services/api";
import type { DashboardViewProps } from "./DashboardLayout";
import {
  IconCheck,
  IconPlus,
  IconSidebar,
  IconTrash,
} from "./AppleIcons";

const CATEGORIES = ["生活习惯", "作息睡眠", "运动健康", "学习成长", "情绪自我"];

export default function HabitsView({
  sidebarOpen,
  onToggleSidebar,
}: DashboardViewProps) {
  const [habits, setHabits] = useState<HabitItem[]>([]);
  const [todayRecords, setTodayRecords] = useState<
    Record<number, HabitRecordItem>
  >({});
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("生活习惯");
  const [targetDesc, setTargetDesc] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const today = formatLocalDate();

  const loadData = useCallback(async () => {
    try {
      const [habitList, dailyLog] = await Promise.all([
        api.listHabits(false),
        api.getDailyLog(today),
      ]);
      setHabits(habitList);
      const map: Record<number, HabitRecordItem> = {};
      for (const rec of dailyLog.habit_records) {
        map[rec.habit_id] = rec;
      }
      setTodayRecords(map);
    } catch {
      setToast("加载习惯数据失败，请检查后端连接");
    }
  }, [today]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  };

  const handleCreateHabit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      await api.createHabit({
        title: title.trim(),
        category,
        target_desc: targetDesc.trim(),
      });
      setTitle("");
      setTargetDesc("");
      setShowAddForm(false);
      await loadData();
      showToast("已添加到灵儿的每日关注清单");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCheckIn = async (
    habitId: number,
    status: "done" | "partial" | "missed",
  ) => {
    try {
      const updated = await api.recordDailyHabit(today, {
        habit_id: habitId,
        status,
        note: "面板快捷打卡",
      });
      const map: Record<number, HabitRecordItem> = {};
      for (const rec of updated.habit_records) {
        map[rec.habit_id] = rec;
      }
      setTodayRecords(map);
      showToast("今日状态已同步到 Markdown 日记");
    } catch {
      showToast("打卡更新失败");
    }
  };

  const handleToggleActive = async (habit: HabitItem) => {
    try {
      await api.updateHabit(habit.id, { is_active: !habit.is_active });
      await loadData();
    } catch {
      showToast("切换状态失败");
    }
  };

  const handleDelete = async (habitId: number) => {
    try {
      await api.deleteHabit(habitId);
      await loadData();
      showToast("已删除该习惯项");
    } catch {
      showToast("删除失败");
    }
  };

  const activeHabits = habits.filter((h) => h.is_active);
  const doneCount = activeHabits.filter(
    (h) => todayRecords[h.id]?.status === "done",
  ).length;
  const progressPct =
    activeHabits.length > 0
      ? Math.round((doneCount / activeHabits.length) * 100)
      : 0;

  return (
    <div className="h-full flex flex-col bg-[var(--bg-canvas)] relative">
      {/* 顶部 52px 极简栏 */}
      <header className="h-[52px] px-4 flex items-center justify-between shrink-0 select-none">
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
            习惯清单
          </span>
          <span className="text-[12px] text-[var(--text-tertiary)] tabular-nums">
            {today}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setShowAddForm((v) => !v)}
          className="h-8 px-3 rounded-full bg-[var(--ink-primary)] hover:bg-[var(--ink-primary-hover)] text-[var(--ink-primary-fg)] text-[12.5px] font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
        >
          <IconPlus className="w-3.5 h-3.5" />
          <span>{showAddForm ? "收起" : "新增习惯"}</span>
        </button>
      </header>

      {/* 主内容区 */}
      <div className="flex-1 overflow-y-auto px-5 sm:px-8 pb-10 pt-2">
        <div className="max-w-[800px] mx-auto space-y-6">
          {/* 今日完成率极简概览 */}
          <section className="rounded-2xl bg-[var(--bg-subtle)]/70 border border-[var(--border-subtle)] px-5 py-4 space-y-3">
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <h2 className="text-[14px] font-medium text-[var(--text-primary)]">
                  今日完成进度
                </h2>
                <p className="text-[12px] text-[var(--text-tertiary)] mt-0.5">
                  灵儿会在白天随聊中静默记录，并在晚间复盘时按启用项逐一核对
                </p>
              </div>
              <div className="text-right shrink-0">
                <span className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)] tabular-nums">
                  {progressPct}%
                </span>
                <span className="text-[12px] text-[var(--text-tertiary)] ml-2 tabular-nums">
                  {doneCount} / {activeHabits.length}
                </span>
              </div>
            </div>
            <div className="h-1.5 rounded-full bg-[var(--border-subtle)] overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-500 ease-out"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </section>

          {/* 可展开的新增习惯表单 */}
          {(showAddForm || habits.length === 0) && (
            <form
              onSubmit={handleCreateHabit}
              className="rounded-2xl bg-[var(--bg-surface)] p-5 border border-[var(--border-subtle)] space-y-4 animate-fade-up"
              style={{ boxShadow: "var(--composer-shadow)" }}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                {CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={`px-2.5 py-1 rounded-full text-[11.5px] font-medium transition-colors cursor-pointer ${
                      category === c
                        ? "bg-[var(--ink-primary)] text-[var(--ink-primary-fg)]"
                        : "bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-active)]"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>

              <div className="space-y-2.5">
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="习惯名称，例如：喝水 2000ml / 23:30 前放下手机"
                  className="w-full h-10 px-3.5 rounded-xl bg-[var(--bg-subtle)] border border-transparent focus:border-[var(--border-strong)] focus:bg-[var(--bg-canvas)] text-[13.5px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none transition-colors"
                />
                <div className="flex flex-col sm:flex-row gap-2.5">
                  <input
                    type="text"
                    value={targetDesc}
                    onChange={(e) => setTargetDesc(e.target.value)}
                    placeholder="补充说明（可选，供灵儿提问和鼓励时参考）"
                    className="flex-1 h-10 px-3.5 rounded-xl bg-[var(--bg-subtle)] border border-transparent focus:border-[var(--border-strong)] focus:bg-[var(--bg-canvas)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none transition-colors"
                  />
                  <button
                    type="submit"
                    disabled={submitting || !title.trim()}
                    className="h-10 px-5 rounded-xl bg-[var(--ink-primary)] hover:bg-[var(--ink-primary-hover)] disabled:opacity-30 text-[var(--ink-primary-fg)] text-[13px] font-medium transition-colors cursor-pointer shrink-0"
                  >
                    {submitting ? "添加中..." : "添加到清单"}
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* 习惯清单列表 */}
          <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden">
            {habits.length === 0 ? (
              <div className="p-12 text-center text-[13px] text-[var(--text-tertiary)]">
                还没有建立习惯喔～先在上方添加 2~3 个最容易开始的小习惯吧。
              </div>
            ) : (
              <ul className="divide-y divide-[var(--border-subtle)]">
                {habits.map((h) => {
                  const rec = todayRecords[h.id];
                  const isDone = rec?.status === "done";
                  return (
                    <li
                      key={h.id}
                      className={`group px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 transition-colors hover:bg-[var(--bg-hover)] ${
                        h.is_active ? "" : "opacity-55"
                      }`}
                    >
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() =>
                            void handleCheckIn(h.id, isDone ? "missed" : "done")
                          }
                          title={isDone ? "取消完成" : "快速标记完成"}
                          className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center border transition-colors shrink-0 cursor-pointer ${
                            isDone
                              ? "bg-emerald-500 border-emerald-500 text-white"
                              : "border-[var(--border-strong)] hover:border-[var(--text-secondary)]"
                          }`}
                        >
                          {isDone && <IconCheck className="w-3 h-3" />}
                        </button>

                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`text-[14.5px] font-medium ${
                                isDone
                                  ? "text-[var(--text-tertiary)] line-through"
                                  : "text-[var(--text-primary)]"
                              }`}
                            >
                              {h.title}
                            </span>
                            <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--bg-subtle)] text-[var(--text-tertiary)]">
                              {h.category}
                            </span>
                            {!h.is_active && (
                              <span className="text-[11px] px-2 py-0.5 rounded-full border border-[var(--border-subtle)] text-[var(--text-tertiary)]">
                                已暂停
                              </span>
                            )}
                          </div>
                          {h.target_desc && (
                            <p className="text-[12px] text-[var(--text-tertiary)] truncate">
                              {h.target_desc}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* 右侧三态打卡胶囊 + 悬停管理操作 */}
                      <div className="flex items-center gap-1.5">
                        <div className="inline-flex p-0.5 rounded-full bg-[var(--bg-subtle)] border border-[var(--border-subtle)]">
                          {(
                            [
                              [
                                "done",
                                "完成",
                                "bg-emerald-500 text-white",
                              ],
                              [
                                "partial",
                                "部分",
                                "bg-amber-500 text-white",
                              ],
                              [
                                "missed",
                                "未做",
                                "bg-[var(--ink-primary)] text-[var(--ink-primary-fg)]",
                              ],
                            ] as const
                          ).map(([statusKey, label, activeCls]) => {
                            const isSelected = rec?.status === statusKey;
                            return (
                              <button
                                key={statusKey}
                                type="button"
                                onClick={() => void handleCheckIn(h.id, statusKey)}
                                className={`px-2.5 py-1 rounded-full text-[11.5px] font-medium transition-colors cursor-pointer ${
                                  isSelected
                                    ? activeCls
                                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                                }`}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>

                        <div className="flex items-center gap-0.5 ml-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                          <button
                            type="button"
                            onClick={() => void handleToggleActive(h)}
                            className="h-7 px-2 rounded-lg text-[11.5px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-active)] transition-colors cursor-pointer"
                          >
                            {h.is_active ? "暂停" : "恢复"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(h.id)}
                            title="删除习惯"
                            className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-tertiary)] hover:text-rose-500 hover:bg-rose-500/10 transition-colors cursor-pointer"
                          >
                            <IconTrash className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>

      {/* 底部居中悬浮轻提示 Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-full bg-[var(--ink-primary)] text-[var(--ink-primary-fg)] text-[12.5px] font-medium shadow-lg animate-fade-up">
          {toast}
        </div>
      )}
    </div>
  );
}
