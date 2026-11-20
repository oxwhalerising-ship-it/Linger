/**
 * 历史消息管理中心（HistoryView）
 * -----------------------------
 * 统一存储于本地 SQLite（data/taiwanbot.db），并按「文本对话 (text)」与「语音对话 (voice)」清晰分区：
 * - 查（Read & Search）：按渠道（全部 / 文本对话 / 语音对话）、日期、角色（我 / 灵儿）、关键词模糊搜索与正/倒序切换
 * - 增（Create）：支持手动补录一条文本或语音历史消息到任意日期
 * - 改（Update）：每条记录均支持行内编辑内容、切换发言角色、修改文本/语音分类与归属日期
 * - 删（Delete & Batch Delete）：单条删除带行内二次确认，支持批量勾选删除与按当前视图一键清理
 * - 同步：所有修改即时生效于本地数据库，切换回聊天室或下次对话时灵儿会自动读取最新上下文
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  formatLocalDate,
  type ChatMessageItem,
  type MessageChannel,
  type MessagesSummaryData,
} from "../../services/api";
import {
  playTaiwanSentences,
  splitSentencesForSpeech,
} from "../../services/petApi";
import AvatarRenderer from "../pet/AvatarRenderer";
import Tooltip from "./Tooltip";
import type { DashboardViewProps } from "./DashboardLayout";
import {
  IconCheck,
  IconCopy,
  IconEdit,
  IconPhone,
  IconPlus,
  IconSearch,
  IconSidebar,
  IconTrash,
  IconVolumeOn,
} from "./AppleIcons";

const PAGE_SIZE = 80;

function formatDurationBadge(durationMs?: number | null): string | null {
  if (typeof durationMs !== "number" || durationMs <= 0) return null;
  const sec = durationMs / 1000;
  return sec < 60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s`;
}

export default function HistoryView({
  sidebarOpen,
  onToggleSidebar,
}: DashboardViewProps) {
  const [summary, setSummary] = useState<MessagesSummaryData>({
    totals: { all: 0, text: 0, voice: 0 },
    dates: [],
  });
  const [channel, setChannel] = useState<MessageChannel>("all");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<"all" | "user" | "assistant">(
    "all",
  );
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const [items, setItems] = useState<ChatMessageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // 新增记录表单
  const [createOpen, setCreateOpen] = useState(false);
  const [newChannel, setNewChannel] = useState<"text" | "voice">("text");
  const [newRole, setNewRole] = useState<"user" | "assistant">("user");
  const [newDate, setNewDate] = useState(() => formatLocalDate());
  const [newContent, setNewContent] = useState("");
  const [creating, setCreating] = useState(false);

  // 行内编辑状态
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editRole, setEditRole] = useState<"user" | "assistant">("user");
  const [editChannel, setEditChannel] = useState<"text" | "voice">("text");
  const [editDate, setEditDate] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // 删除确认 & 批量管理
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmBatchAction, setConfirmBatchAction] = useState<
    null | "selected" | "clear_view"
  >(null);
  const [deletingBatch, setDeletingBatch] = useState(false);

  // 复制 / 语音重播 / 轻提示
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [replayingId, setReplayingId] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const audioAbortRef = useRef<AbortController | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  // 搜索词防抖（220ms）
  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedQuery(searchInput.trim());
    }, 220);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    return () => {
      audioAbortRef.current?.abort();
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const fetchSummary = useCallback(async () => {
    try {
      const data = await api.getMessagesSummary();
      setSummary(data);
    } catch {
      // ignore transient error
    }
  }, []);

  const fetchMessages = useCallback(
    async (offset = 0, append = false) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      try {
        const res = await api.listMessages({
          channel,
          date: selectedDate,
          role: roleFilter === "all" ? null : roleFilter,
          q: debouncedQuery || undefined,
          order: sortOrder,
          limit: PAGE_SIZE,
          offset,
        });
        setTotal(res.total);
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
      } catch (err) {
        showToast(err instanceof Error ? err.message : "加载历史消息失败");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [channel, debouncedQuery, roleFilter, selectedDate, showToast, sortOrder],
  );

  useEffect(() => {
    void fetchSummary();
  }, [fetchSummary]);

  useEffect(() => {
    setSelectedIds(new Set());
    setConfirmBatchAction(null);
    setConfirmDeleteId(null);
    void fetchMessages(0, false);
  }, [fetchMessages]);

  /** 新增历史消息 */
  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cleaned = newContent.trim();
    if (!cleaned || creating) return;
    setCreating(true);
    try {
      await api.createMessage({
        session_date: newDate || formatLocalDate(),
        channel: newChannel,
        role: newRole,
        content: cleaned,
      });
      setNewContent("");
      setCreateOpen(false);
      await Promise.all([fetchSummary(), fetchMessages(0, false)]);
      showToast("已新增历史对话记录");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "新增失败");
    } finally {
      setCreating(false);
    }
  };

  /** 进入行内编辑 */
  const startEditing = (msg: ChatMessageItem) => {
    setConfirmDeleteId(null);
    setEditingId(msg.id);
    setEditContent(msg.content);
    setEditRole(msg.role === "assistant" ? "assistant" : "user");
    setEditChannel(
      msg.channel === "voice" || msg.trigger_type === "voice_call"
        ? "voice"
        : "text",
    );
    setEditDate(msg.session_date);
  };

  /** 保存编辑 */
  const handleSaveEdit = async (id: number) => {
    const cleaned = editContent.trim();
    if (!cleaned || savingEdit) return;
    setSavingEdit(true);
    try {
      const updated = await api.updateMessage(id, {
        content: cleaned,
        role: editRole,
        channel: editChannel,
        session_date: editDate,
      });
      setEditingId(null);
      // 若修改了渠道或日期且不再符合当前筛选，刷新列表与统计；否则原地更新
      const outOfFilter =
        (channel !== "all" && updated.channel !== channel) ||
        (selectedDate !== null && updated.session_date !== selectedDate) ||
        (roleFilter !== "all" && updated.role !== roleFilter);
      if (outOfFilter) {
        await Promise.all([fetchSummary(), fetchMessages(0, false)]);
      } else {
        setItems((prev) => prev.map((m) => (m.id === id ? updated : m)));
        void fetchSummary();
      }
      showToast("已保存修改");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存修改失败");
    } finally {
      setSavingEdit(false);
    }
  };

  /** 单条删除 */
  const handleConfirmDeleteOne = async (id: number) => {
    try {
      await api.deleteMessage(id);
      setConfirmDeleteId(null);
      setItems((prev) => prev.filter((m) => m.id !== id));
      setTotal((prev) => Math.max(0, prev - 1));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      void fetchSummary();
      showToast("已删除该条消息");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "删除失败");
    }
  };

  /** 批量删除所选或清理当前视图 */
  const handleExecuteBatchDelete = async () => {
    if (!confirmBatchAction || deletingBatch) return;
    setDeletingBatch(true);
    try {
      if (confirmBatchAction === "selected") {
        const ids = Array.from(selectedIds);
        const res = await api.batchDeleteMessages({ ids });
        showToast(`已批量删除 ${res.deleted_count} 条消息`);
      } else {
        const res = await api.batchDeleteMessages({
          date: selectedDate,
          channel,
        });
        showToast(`已清理 ${res.deleted_count} 条消息`);
      }
      setSelectedIds(new Set());
      setConfirmBatchAction(null);
      setBatchMode(false);
      await Promise.all([fetchSummary(), fetchMessages(0, false)]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "批量删除失败");
    } finally {
      setDeletingBatch(false);
    }
  };

  const toggleSelectId = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllLoaded = () => {
    if (selectedIds.size === items.length && items.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((m) => m.id)));
    }
  };

  const handleCopy = async (msg: ChatMessageItem) => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopiedId(msg.id);
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === msg.id ? null : prev));
      }, 1400);
    } catch {
      showToast("复制失败");
    }
  };

  const handleReplay = async (msg: ChatMessageItem) => {
    if (replayingId === msg.id) {
      audioAbortRef.current?.abort();
      setReplayingId(null);
      return;
    }
    audioAbortRef.current?.abort();
    const controller = new AbortController();
    audioAbortRef.current = controller;
    setReplayingId(msg.id);
    try {
      await playTaiwanSentences(splitSentencesForSpeech(msg.content), {
        signal: controller.signal,
      });
    } finally {
      setReplayingId((prev) => (prev === msg.id ? null : prev));
    }
  };

  const canClearCurrentView = Boolean(selectedDate || channel !== "all");

  return (
    <div className="h-full flex flex-col bg-[var(--bg-canvas)] relative">
      {/* 顶部 52px 极简栏：标题 + 文本/语音分区切换 + 新增记录按钮 */}
      <header className="h-[52px] px-4 flex items-center justify-between gap-3 shrink-0 select-none border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2 min-w-0">
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
          <span className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)] px-1 truncate">
            历史消息
          </span>
          <span className="text-[12px] text-[var(--text-tertiary)] tabular-nums hidden sm:inline">
            共 {summary.totals.all} 条
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* 核心分区切换：全部 / 文本对话 / 语音对话 */}
          <div className="inline-flex p-0.5 rounded-full bg-[var(--bg-subtle)] border border-[var(--border-subtle)]">
            {(
              [
                { id: "all", label: "全部", count: summary.totals.all },
                { id: "text", label: "文本对话", count: summary.totals.text },
                { id: "voice", label: "语音对话", count: summary.totals.voice },
              ] as const
            ).map((tab) => {
              const active = channel === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setChannel(tab.id)}
                  className={`px-3 py-1 rounded-full text-[12px] font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                    active
                      ? "bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-xs"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <span>{tab.label}</span>
                  <span className="text-[11px] tabular-nums opacity-65">
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => {
              setNewChannel(channel === "voice" ? "voice" : "text");
              setNewDate(selectedDate || formatLocalDate());
              setCreateOpen((v) => !v);
            }}
            className="h-8 px-3.5 rounded-full bg-[var(--ink-primary)] hover:bg-[var(--ink-primary-hover)] text-[var(--ink-primary-fg)] text-[12px] font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <IconPlus className="w-3.5 h-3.5" />
            <span>新增记录</span>
          </button>
        </div>
      </header>

      {/* 可展开的「手动新增历史记录」表单 */}
      {createOpen && (
        <div className="px-5 py-3.5 border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)]/55 animate-fade-up shrink-0">
          <form
            onSubmit={handleCreateSubmit}
            className="max-w-[920px] mx-auto space-y-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="font-medium text-[var(--text-primary)]">
                  新增历史消息
                </span>
                <div className="inline-flex p-0.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
                  {(
                    [
                      { id: "text", label: "文本对话" },
                      { id: "voice", label: "语音对话" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setNewChannel(opt.id)}
                      className={`px-2.5 py-0.5 rounded-md text-[11.5px] font-medium transition-colors cursor-pointer ${
                        newChannel === opt.id
                          ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                          : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                <div className="inline-flex p-0.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
                  {(
                    [
                      { id: "user", label: "我" },
                      { id: "assistant", label: "灵儿" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setNewRole(opt.id)}
                      className={`px-2.5 py-0.5 rounded-md text-[11.5px] font-medium transition-colors cursor-pointer ${
                        newRole === opt.id
                          ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                          : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                <input
                  type="date"
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                  className="h-7 px-2.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--border-strong)]"
                />
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="h-7 px-3 rounded-lg text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={creating || !newContent.trim()}
                  className="h-7 px-3.5 rounded-lg bg-[var(--ink-primary)] hover:bg-[var(--ink-primary-hover)] disabled:opacity-40 text-[var(--ink-primary-fg)] text-[12px] font-medium cursor-pointer"
                >
                  {creating ? "保存中..." : "保存记录"}
                </button>
              </div>
            </div>

            <textarea
              rows={2}
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="输入想补录的历史对话内容..."
              className="w-full px-3 py-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] focus:border-[var(--border-strong)] text-[13.5px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none resize-y"
            />
          </form>
        </div>
      )}

      {/* 主体双栏：左侧日期会话列表 + 右侧检索与增删改查列表 */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
        {/* 左侧日期导航栏 */}
        <aside className="w-full md:w-[228px] shrink-0 border-b md:border-b-0 md:border-r border-[var(--border-subtle)] overflow-y-auto p-3 space-y-1 bg-[var(--bg-canvas)]">
          <button
            type="button"
            onClick={() => setSelectedDate(null)}
            className={`w-full text-left px-3 py-2 rounded-xl flex items-center justify-between text-[13px] transition-colors cursor-pointer ${
              selectedDate === null
                ? "bg-[var(--bg-active)] text-[var(--text-primary)] font-medium"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            }`}
          >
            <span>全部日期</span>
            <span className="text-[11.5px] tabular-nums text-[var(--text-tertiary)]">
              {channel === "text"
                ? summary.totals.text
                : channel === "voice"
                  ? summary.totals.voice
                  : summary.totals.all}
            </span>
          </button>

          {summary.dates.length > 0 && (
            <div className="pt-2 pb-1 px-2 text-[11px] font-medium text-[var(--text-tertiary)] select-none">
              按日期浏览（{summary.dates.length} 天）
            </div>
          )}

          {summary.dates.map((d) => {
            const active = selectedDate === d.date;
            const visibleCount =
              channel === "text"
                ? d.text_count
                : channel === "voice"
                  ? d.voice_count
                  : d.total_count;
            return (
              <button
                key={d.date}
                type="button"
                onClick={() => {
                  setSelectedDate(d.date);
                  setSortOrder("asc");
                }}
                className={`w-full text-left px-3 py-2 rounded-xl transition-colors cursor-pointer space-y-1 ${
                  active
                    ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium tabular-nums">
                    {d.date}
                  </span>
                  <span className="text-[11px] tabular-nums text-[var(--text-tertiary)]">
                    {visibleCount} 条
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-tertiary)] tabular-nums">
                  <span className="px-1.5 py-0.5 rounded-md bg-[var(--bg-subtle)]">
                    文 {d.text_count}
                  </span>
                  <span className="px-1.5 py-0.5 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400">
                    语 {d.voice_count}
                  </span>
                </div>
                {d.last_preview && (
                  <p className="text-[11.5px] text-[var(--text-tertiary)] truncate">
                    {d.last_preview}
                  </p>
                )}
              </button>
            );
          })}
        </aside>

        {/* 右侧搜索栏 + 消息列表 */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* 搜索、角色筛选、排序与批量操作条 */}
          <div className="px-5 py-3 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2.5 shrink-0">
            <div className="relative flex-1 min-w-[200px] max-w-[380px]">
              <IconSearch className="w-4 h-4 text-[var(--text-tertiary)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="搜索历史对话关键词..."
                className="w-full h-8 pl-9 pr-7 rounded-xl bg-[var(--bg-subtle)] border border-transparent focus:border-[var(--border-strong)] focus:bg-[var(--bg-surface)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none transition-colors"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => setSearchInput("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[12px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-1 cursor-pointer"
                >
                  ×
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {/* 角色筛选 */}
              <div className="inline-flex p-0.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[11.5px]">
                {(
                  [
                    { id: "all", label: "全部角色" },
                    { id: "user", label: "我" },
                    { id: "assistant", label: "灵儿" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setRoleFilter(opt.id)}
                    className={`px-2 py-1 rounded-md font-medium transition-colors cursor-pointer ${
                      roleFilter === opt.id
                        ? "bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-2xs"
                        : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* 正序/倒序 */}
              <button
                type="button"
                onClick={() =>
                  setSortOrder((o) => (o === "desc" ? "asc" : "desc"))
                }
                className="h-7 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] text-[12px] text-[var(--text-secondary)] cursor-pointer"
              >
                {sortOrder === "desc" ? "最新优先" : "时间正序"}
              </button>

              {/* 批量管理切换 */}
              <button
                type="button"
                onClick={() => {
                  setBatchMode((v) => !v);
                  setSelectedIds(new Set());
                  setConfirmBatchAction(null);
                }}
                className={`h-7 px-2.5 rounded-lg border text-[12px] font-medium transition-colors cursor-pointer ${
                  batchMode
                    ? "bg-[var(--ink-primary)] text-[var(--ink-primary-fg)] border-transparent"
                    : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                {batchMode ? "退出批量" : "批量管理"}
              </button>
            </div>
          </div>

          {/* 批量操作浮条 */}
          {batchMode && (
            <div className="px-5 py-2 border-b border-[var(--border-subtle)] bg-amber-500/8 flex flex-wrap items-center justify-between gap-2 text-[12px] shrink-0">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={toggleSelectAllLoaded}
                  className="font-medium text-[var(--text-primary)] hover:underline cursor-pointer"
                >
                  {selectedIds.size === items.length && items.length > 0
                    ? "取消全选"
                    : `全选当前 (${items.length})`}
                </button>
                <span className="text-[var(--text-secondary)] tabular-nums">
                  已勾选 {selectedIds.size} 条
                </span>
              </div>

              <div className="flex items-center gap-2">
                {confirmBatchAction ? (
                  <>
                    <span className="text-rose-600 dark:text-rose-400 font-medium">
                      {confirmBatchAction === "selected"
                        ? `确定永久删除选中的 ${selectedIds.size} 条记录？`
                        : `确定永久清空当前筛选条件下的记录？`}
                    </span>
                    <button
                      type="button"
                      disabled={deletingBatch}
                      onClick={() => void handleExecuteBatchDelete()}
                      className="h-7 px-3 rounded-lg bg-rose-500 hover:bg-rose-600 text-white font-medium cursor-pointer disabled:opacity-40"
                    >
                      {deletingBatch ? "删除中..." : "确认删除"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmBatchAction(null)}
                      className="h-7 px-2.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)] cursor-pointer"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={selectedIds.size === 0}
                      onClick={() => setConfirmBatchAction("selected")}
                      className="h-7 px-3 rounded-lg bg-rose-500 hover:bg-rose-600 disabled:opacity-35 text-white font-medium cursor-pointer"
                    >
                      删除所选 ({selectedIds.size})
                    </button>
                    {canClearCurrentView && total > 0 && (
                      <button
                        type="button"
                        onClick={() => setConfirmBatchAction("clear_view")}
                        className="h-7 px-3 rounded-lg border border-rose-500/35 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 font-medium cursor-pointer"
                      >
                        清空当前分类/日期
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* 消息记录流 */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <div className="max-w-[780px] mx-auto space-y-2.5">
              <div className="flex items-center justify-between text-[12px] text-[var(--text-tertiary)] pb-1">
                <span>
                  {selectedDate ? `${selectedDate} · ` : "全部日期 · "}
                  {channel === "text"
                    ? "文本对话库"
                    : channel === "voice"
                      ? "语音对话库"
                      : "文本 + 语音全部记录"}
                  {debouncedQuery ? ` · 搜索「${debouncedQuery}」` : ""}
                </span>
                <span className="tabular-nums">匹配 {total} 条</span>
              </div>

              {loading ? (
                <div className="py-16 text-center text-[13px] text-[var(--text-tertiary)]">
                  正在加载历史记录...
                </div>
              ) : items.length === 0 ? (
                <div className="py-16 text-center space-y-2">
                  <p className="text-[14px] text-[var(--text-secondary)]">
                    当前筛选条件下暂无历史消息
                  </p>
                  <p className="text-[12px] text-[var(--text-tertiary)]">
                    你可以切换上方的「文本对话 / 语音对话」分类，或点击右上角「新增记录」手动补录。
                  </p>
                </div>
              ) : (
                <>
                  {items.map((msg) => {
                    const isVoice =
                      msg.channel === "voice" || msg.trigger_type === "voice_call";
                    const isUser = msg.role === "user";
                    const isEditing = editingId === msg.id;
                    const isChecked = selectedIds.has(msg.id);
                    const durBadge = formatDurationBadge(msg.duration_ms);

                    return (
                      <div
                        key={msg.id}
                        className={`rounded-2xl border p-3.5 transition-colors ${
                          isChecked
                            ? "border-blue-500/45 bg-blue-500/6"
                            : "border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)]"
                        }`}
                      >
                        {isEditing ? (
                          /* 行内编辑态 */
                          <div className="space-y-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="inline-flex p-0.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)]">
                                  {(
                                    [
                                      { id: "text", label: "文本" },
                                      { id: "voice", label: "语音" },
                                    ] as const
                                  ).map((opt) => (
                                    <button
                                      key={opt.id}
                                      type="button"
                                      onClick={() => setEditChannel(opt.id)}
                                      className={`px-2 py-0.5 rounded-md text-[11.5px] font-medium cursor-pointer ${
                                        editChannel === opt.id
                                          ? "bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-2xs"
                                          : "text-[var(--text-tertiary)]"
                                      }`}
                                    >
                                      {opt.label}
                                    </button>
                                  ))}
                                </div>

                                <div className="inline-flex p-0.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)]">
                                  {(
                                    [
                                      { id: "user", label: "我" },
                                      { id: "assistant", label: "灵儿" },
                                    ] as const
                                  ).map((opt) => (
                                    <button
                                      key={opt.id}
                                      type="button"
                                      onClick={() => setEditRole(opt.id)}
                                      className={`px-2 py-0.5 rounded-md text-[11.5px] font-medium cursor-pointer ${
                                        editRole === opt.id
                                          ? "bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-2xs"
                                          : "text-[var(--text-tertiary)]"
                                      }`}
                                    >
                                      {opt.label}
                                    </button>
                                  ))}
                                </div>

                                <input
                                  type="date"
                                  value={editDate}
                                  onChange={(e) => setEditDate(e.target.value)}
                                  className="h-7 px-2 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[12px] text-[var(--text-primary)] outline-none"
                                />
                              </div>

                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setEditingId(null)}
                                  className="h-7 px-2.5 rounded-lg text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] cursor-pointer"
                                >
                                  取消
                                </button>
                                <button
                                  type="button"
                                  disabled={savingEdit || !editContent.trim()}
                                  onClick={() => void handleSaveEdit(msg.id)}
                                  className="h-7 px-3 rounded-lg bg-[var(--ink-primary)] hover:bg-[var(--ink-primary-hover)] disabled:opacity-40 text-[var(--ink-primary-fg)] text-[12px] font-medium cursor-pointer"
                                >
                                  {savingEdit ? "保存中..." : "保存"}
                                </button>
                              </div>
                            </div>

                            <textarea
                              rows={3}
                              value={editContent}
                              onChange={(e) => setEditContent(e.target.value)}
                              onKeyDown={(e) => {
                                if (
                                  (e.ctrlKey || e.metaKey) &&
                                  e.key === "Enter"
                                ) {
                                  e.preventDefault();
                                  void handleSaveEdit(msg.id);
                                } else if (e.key === "Escape") {
                                  setEditingId(null);
                                }
                              }}
                              autoFocus
                              className="w-full px-3 py-2 rounded-xl bg-[var(--bg-subtle)] border border-[var(--border-strong)] text-[13.5px] leading-relaxed text-[var(--text-primary)] outline-none resize-y"
                            />
                          </div>
                        ) : (
                          /* 展示态 */
                          <div className="flex items-start gap-3">
                            {batchMode && (
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleSelectId(msg.id)}
                                className="mt-1.5 w-4 h-4 rounded accent-blue-600 cursor-pointer shrink-0"
                              />
                            )}

                            <div className="shrink-0 mt-0.5">
                              {isUser ? (
                                <div className="w-7 h-7 rounded-full bg-[var(--bg-subtle)] border border-[var(--border-subtle)] flex items-center justify-center text-[11.5px] font-semibold text-[var(--text-secondary)]">
                                  我
                                </div>
                              ) : (
                                <div className="w-7 h-7 rounded-full bg-[#FFF7E6] dark:bg-amber-500/15 border border-[var(--border-subtle)] flex items-center justify-center overflow-hidden">
                                  <AvatarRenderer emotion="happy" size={26} />
                                </div>
                              )}
                            </div>

                            <div className="flex-1 min-w-0 space-y-1.5">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                                  <span className="font-semibold text-[var(--text-primary)]">
                                    {isUser ? "我" : "灵儿"}
                                  </span>

                                  {/* 渠道标签：语音对话 vs 文本对话 */}
                                  <span
                                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium ${
                                      isVoice
                                        ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20"
                                        : "bg-[var(--bg-subtle)] text-[var(--text-secondary)] border border-[var(--border-subtle)]"
                                    }`}
                                  >
                                    {isVoice && (
                                      <IconPhone className="w-2.5 h-2.5" />
                                    )}
                                    {isVoice ? "语音对话" : "文本对话"}
                                  </span>

                                  <span className="text-[var(--text-tertiary)] tabular-nums">
                                    {msg.session_date}{" "}
                                    {msg.created_at.slice(11, 16)}
                                  </span>

                                  {durBadge && (
                                    <span className="text-[var(--text-tertiary)] tabular-nums">
                                      · {durBadge}
                                    </span>
                                  )}

                                  {msg.updated_at && (
                                    <span className="text-[10.5px] text-amber-600 dark:text-amber-400">
                                      · 已编辑
                                    </span>
                                  )}
                                </div>

                                {/* 单条快捷操作：编辑 / 朗读 / 复制 / 删除 */}
                                <div className="flex items-center gap-0.5 text-[var(--text-tertiary)]">
                                  {confirmDeleteId === msg.id ? (
                                    <div className="flex items-center gap-1 text-[11.5px]">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          void handleConfirmDeleteOne(msg.id)
                                        }
                                        className="px-2 py-0.5 rounded-md bg-rose-500 hover:bg-rose-600 text-white font-medium cursor-pointer"
                                      >
                                        确认删除
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setConfirmDeleteId(null)}
                                        className="px-2 py-0.5 rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer"
                                      >
                                        取消
                                      </button>
                                    </div>
                                  ) : (
                                    <>
                                      <Tooltip label="编辑内容与分类" side="top">
                                        <button
                                          type="button"
                                          onClick={() => startEditing(msg)}
                                          className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                                        >
                                          <IconEdit className="w-3.5 h-3.5" />
                                        </button>
                                      </Tooltip>
                                      <Tooltip
                                        label={
                                          replayingId === msg.id
                                            ? "停止朗读"
                                            : "朗读此条消息"
                                        }
                                        side="top"
                                      >
                                        <button
                                          type="button"
                                          onClick={() => void handleReplay(msg)}
                                          className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
                                            replayingId === msg.id
                                              ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                                              : "hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                                          }`}
                                        >
                                          <IconVolumeOn className="w-3.5 h-3.5" />
                                        </button>
                                      </Tooltip>
                                      <Tooltip
                                        label={
                                          copiedId === msg.id ? "已复制" : "复制"
                                        }
                                        side="top"
                                      >
                                        <button
                                          type="button"
                                          onClick={() => void handleCopy(msg)}
                                          className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                                        >
                                          {copiedId === msg.id ? (
                                            <IconCheck className="w-3.5 h-3.5 text-emerald-500" />
                                          ) : (
                                            <IconCopy className="w-3.5 h-3.5" />
                                          )}
                                        </button>
                                      </Tooltip>
                                      <Tooltip label="删除此条记录" side="top">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setConfirmDeleteId(msg.id)
                                          }
                                          className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-rose-500/10 hover:text-rose-500 transition-colors cursor-pointer"
                                        >
                                          <IconTrash className="w-3.5 h-3.5" />
                                        </button>
                                      </Tooltip>
                                    </>
                                  )}
                                </div>
                              </div>

                              <p className="text-[14px] leading-[1.68] text-[var(--text-primary)] whitespace-pre-wrap break-words">
                                {msg.content}
                              </p>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {items.length < total && (
                    <div className="pt-3 flex justify-center">
                      <button
                        type="button"
                        disabled={loadingMore}
                        onClick={() => void fetchMessages(items.length, true)}
                        className="h-8 px-4 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] text-[12.5px] text-[var(--text-secondary)] cursor-pointer disabled:opacity-45"
                      >
                        {loadingMore
                          ? "加载中..."
                          : `加载更多（剩余 ${total - items.length} 条）`}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 底部轻提示胶囊 */}
      {toast && (
        <div className="fixed bottom-5 right-6 z-50 px-3.5 py-2 rounded-full bg-[#141414] text-white text-[12.5px] shadow-lg animate-fade-up">
          {toast}
        </div>
      )}
    </div>
  );
}
