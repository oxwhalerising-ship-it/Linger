/**
 * ChatGPT Desktop 风格主控面板壳层（DashboardLayout）
 * --------------------------------------------------
 * 视觉与交互参考 ChatGPT Desktop（macOS / Windows 原生客户端）：
 * - 固定图标列几何锚点：无论展开还是收缩为 60px 图标条，所有图标 X 坐标对齐，零闪屏
 * - 收缩状态下完整保留「灵儿管家」品牌图标与「展开侧边栏」按钮，悬停图标弹出黑色圆角自定义气泡提示
 * - 支持左右拖拽调宽（184px ~ 380px），左拉带缓动吸附为图标功能条；右拉自动展开
 * - 支持 Ctrl+\ / Cmd+\ 快捷键切换与浅色/深色主题一键切换
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { api, type HealthData } from "../../services/api";
import {
  IconAnalytics,
  IconCalendar,
  IconChat,
  IconChecklist,
  IconHistory,
  IconMoon,
  IconSettings,
  IconSidebar,
  IconSparkles,
  IconSun,
  IconWindow,
} from "./AppleIcons";
import ChatView from "./ChatView";
import HabitsView from "./HabitsView";
import HistoryView from "./HistoryView";
import JournalView from "./JournalView";
import ReportsView from "./ReportsView";
import SettingsView from "./SettingsView";

export type TabId =
  | "chat"
  | "history"
  | "habits"
  | "journal"
  | "reports"
  | "settings";

export interface DashboardViewProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

interface NavItem {
  id: TabId;
  label: string;
  renderIcon: (active: boolean) => ReactNode;
}

interface HoverTooltip {
  label: string;
  top: number;
}

const PRIMARY_NAV: NavItem[] = [
  { id: "chat", label: "灵儿对话", renderIcon: (active) => <IconChat filled={active} /> },
  { id: "history", label: "历史消息", renderIcon: (active) => <IconHistory filled={active} /> },
  { id: "habits", label: "习惯清单", renderIcon: (active) => <IconChecklist filled={active} /> },
  { id: "journal", label: "日历与小确幸", renderIcon: (active) => <IconCalendar filled={active} /> },
];

const SECONDARY_NAV: NavItem[] = [
  { id: "reports", label: "周报与月报", renderIcon: (active) => <IconAnalytics filled={active} /> },
  { id: "settings", label: "设置与记忆", renderIcon: (active) => <IconSettings filled={active} /> },
];

const COMPACT_RAIL_WIDTH = 60;
const DEFAULT_SIDEBAR_WIDTH = 252;
const MIN_EXPANDED_WIDTH = 184;
const MAX_SIDEBAR_WIDTH = 380;
const SNAP_TO_COMPACT_THRESHOLD = 148;
const SNAP_TO_EXPAND_THRESHOLD = 118;

function getInitialSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem("taiwanbot_sidebar_width");
    if (raw) {
      const parsed = Number(raw);
      if (
        Number.isFinite(parsed) &&
        parsed >= MIN_EXPANDED_WIDTH &&
        parsed <= MAX_SIDEBAR_WIDTH
      ) {
        return parsed;
      }
    }
  } catch {
    // ignore storage errors
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

function getInitialCompact(): boolean {
  try {
    return window.localStorage.getItem("taiwanbot_sidebar_compact") === "1";
  } catch {
    return false;
  }
}

function getInitialTheme(): "light" | "dark" {
  try {
    const saved = window.localStorage.getItem("taiwanbot_theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // ignore storage errors
  }
  return "light";
}

export default function DashboardLayout() {
  const [activeTab, setActiveTab] = useState<TabId>("chat");
  const [isCompact, setIsCompact] = useState<boolean>(getInitialCompact);
  const [sidebarWidth, setSidebarWidth] = useState<number>(
    getInitialSidebarWidth,
  );
  const [isResizing, setIsResizing] = useState(false);
  const [isSnapping, setIsSnapping] = useState(false);
  const [hoverTip, setHoverTip] = useState<HoverTooltip | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(getInitialTheme);
  const [petActive, setPetActive] = useState(true);
  const [health, setHealth] = useState<HealthData | null>(null);
  const isElectron = Boolean(window.taiwanBotEnv);

  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const isCompactRef = useRef(isCompact);
  isCompactRef.current = isCompact;
  const snapTimerRef = useRef<number | null>(null);

  const triggerSnapTransition = useCallback(() => {
    setIsSnapping(true);
    if (snapTimerRef.current) {
      window.clearTimeout(snapTimerRef.current);
    }
    snapTimerRef.current = window.setTimeout(() => {
      setIsSnapping(false);
      snapTimerRef.current = null;
    }, 240);
  }, []);

  useEffect(() => {
    return () => {
      if (snapTimerRef.current) {
        window.clearTimeout(snapTimerRef.current);
      }
    };
  }, []);

  // 展开侧边栏或拖拽时自动清除悬停提示
  useEffect(() => {
    if (!isCompact || isResizing) {
      setHoverTip(null);
    }
  }, [isCompact, isResizing]);

  const showCompactTip = (
    e: ReactMouseEvent<HTMLElement>,
    label: string,
  ) => {
    if (!isCompact || isResizing) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setHoverTip({
      label,
      top: rect.top + rect.height / 2,
    });
  };

  const hideCompactTip = () => setHoverTip(null);

  // 持久化浅色 / 深色主题
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    try {
      window.localStorage.setItem("taiwanbot_theme", theme);
    } catch {
      // ignore
    }
  }, [theme]);

  // 持久化侧边栏宽度与收缩状态
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "taiwanbot_sidebar_width",
        String(sidebarWidth),
      );
      window.localStorage.setItem(
        "taiwanbot_sidebar_compact",
        isCompact ? "1" : "0",
      );
    } catch {
      // ignore
    }
  }, [sidebarWidth, isCompact]);

  // 快捷键 Ctrl+\ / Cmd+\ 在完整侧边栏与图标功能条间切换
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        triggerSnapTransition();
        setIsCompact((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [triggerSnapTransition]);

  // 鼠标拖拽调整侧边栏宽度（左拉丝滑缓动吸附为图标栏，右拉自动展开）
  const handleResizeStart = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragStartXRef.current = e.clientX;
      dragStartWidthRef.current = isCompact
        ? COMPACT_RAIL_WIDTH
        : sidebarWidth;
      setIsResizing(true);
    },
    [isCompact, sidebarWidth],
  );

  useEffect(() => {
    if (!isResizing) return;

    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (e: MouseEvent) => {
      const targetWidth =
        dragStartWidthRef.current + (e.clientX - dragStartXRef.current);

      if (!isCompactRef.current) {
        if (targetWidth < SNAP_TO_COMPACT_THRESHOLD) {
          triggerSnapTransition();
          setIsCompact(true);
        } else {
          setSidebarWidth(
            Math.min(
              MAX_SIDEBAR_WIDTH,
              Math.max(MIN_EXPANDED_WIDTH, targetWidth),
            ),
          );
        }
      } else {
        if (targetWidth > SNAP_TO_EXPAND_THRESHOLD) {
          triggerSnapTransition();
          setIsCompact(false);
          setSidebarWidth(
            Math.min(
              MAX_SIDEBAR_WIDTH,
              Math.max(MIN_EXPANDED_WIDTH, targetWidth),
            ),
          );
        }
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, triggerSnapTransition]);

  // 健康检查
  useEffect(() => {
    void api
      .getHealth()
      .then((h) => setHealth(h))
      .catch(() => setHealth(null));
  }, []);

  const currentWidth = isCompact ? COMPACT_RAIL_WIDTH : sidebarWidth;
  const shouldAnimateWidth = !isResizing || isSnapping;

  const renderNavGroup = (title: string, items: NavItem[]) => (
    <div className="space-y-0.5">
      <div
        className={`overflow-hidden transition-[height,opacity] duration-200 ease-out ${
          isCompact ? "h-0 opacity-0" : "h-6 opacity-100"
        }`}
      >
        <div className="px-2.5 pt-1 text-[11px] font-medium tracking-wide text-[var(--text-tertiary)] whitespace-nowrap">
          {title}
        </div>
      </div>

      {items.map((item) => {
        const active = activeTab === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onMouseEnter={(e) => showCompactTip(e, item.label)}
            onMouseLeave={hideCompactTip}
            onClick={() => setActiveTab(item.id)}
            className={`group w-full h-9 flex items-center rounded-[10px] text-[13.5px] transition-colors cursor-pointer overflow-hidden ${
              active
                ? "bg-[var(--bg-active)] text-[var(--text-primary)] font-medium"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] font-normal"
            }`}
          >
            <span
              className={`w-9 h-9 flex items-center justify-center shrink-0 transition-colors ${
                active
                  ? "text-[var(--ink-primary)]"
                  : "text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]"
              }`}
            >
              {item.renderIcon(active)}
            </span>
            <span
              className={`truncate whitespace-nowrap pr-2.5 transition-[opacity,transform] duration-150 ease-out ${
                isCompact
                  ? "opacity-0 -translate-x-1 pointer-events-none"
                  : "opacity-100 translate-x-0"
              }`}
            >
              {item.label}
            </span>
          </button>
        );
      })}
    </div>
  );

  const viewProps: DashboardViewProps = {
    sidebarOpen: true,
    onToggleSidebar: () => {
      triggerSnapTransition();
      setIsCompact((v) => !v);
    },
  };

  return (
    <div className="h-screen w-screen flex bg-[var(--bg-canvas)] text-[var(--text-primary)] overflow-hidden transition-colors duration-200 relative">
      {/* 左侧 ChatGPT Desktop 风格侧边栏：温和质感灰 + 固定图标锚点 + 丝滑吸附 */}
      <aside
        style={{ width: `${currentWidth}px` }}
        className={`relative shrink-0 bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)] flex flex-col justify-between overflow-hidden select-none will-change-[width] ${
          shouldAnimateWidth
            ? "transition-[width] duration-220 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]"
            : "transition-none"
        }`}
      >
        <div className="flex flex-col flex-1 min-h-0 px-3 pt-3 pb-3">
          {/* 顶部品牌行：始终保留「灵儿管家」Icon；展开时右侧显示收起按钮，收缩时下方显示展开按钮 */}
          <div className="mb-3 space-y-1">
            <div className="flex items-center justify-between h-9">
              <button
                type="button"
                onMouseEnter={(e) => showCompactTip(e, "灵儿管家")}
                onMouseLeave={hideCompactTip}
                onClick={() => setActiveTab("chat")}
                className="flex items-center h-9 rounded-[10px] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer overflow-hidden min-w-9"
              >
                <span className="w-9 h-9 flex items-center justify-center shrink-0">
                  <span className="w-7 h-7 rounded-[8px] bg-[var(--ink-primary)] text-[var(--ink-primary-fg)] flex items-center justify-center">
                    <IconSparkles className="w-4 h-4" />
                  </span>
                </span>
                {!isCompact && (
                  <span className="text-[14px] font-semibold tracking-tight text-[var(--text-primary)] truncate whitespace-nowrap pr-2">
                    灵儿管家
                  </span>
                )}
              </button>

              {!isCompact && (
                <button
                  type="button"
                  onClick={() => {
                    triggerSnapTransition();
                    setIsCompact(true);
                  }}
                  title="收缩为图标栏 (Ctrl+\)"
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer shrink-0"
                >
                  <IconSidebar className="w-[17px] h-[17px]" />
                </button>
              )}
            </div>

            {/* 收缩态专属：在品牌图标下方保留「展开侧边栏」按钮 */}
            <div
              className={`overflow-hidden transition-[height,opacity] duration-200 ease-out ${
                isCompact ? "h-9 opacity-100" : "h-0 opacity-0"
              }`}
            >
              <button
                type="button"
                onMouseEnter={(e) => showCompactTip(e, "展开侧边栏 (Ctrl+\\)")}
                onMouseLeave={hideCompactTip}
                onClick={() => {
                  triggerSnapTransition();
                  setIsCompact(false);
                }}
                className="w-9 h-9 rounded-[10px] flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
              >
                <IconSidebar className="w-[17px] h-[17px]" />
              </button>
            </div>
          </div>

          {/* 导航分组列表 */}
          <nav className="flex-1 overflow-y-auto no-scrollbar space-y-2.5">
            {renderNavGroup("日常陪伴", PRIMARY_NAV)}
            <div
              className={`mx-2 h-px bg-[var(--border-subtle)] transition-opacity duration-200 ${
                isCompact ? "opacity-100" : "opacity-0 h-0"
              }`}
            />
            {renderNavGroup("洞察与配置", SECONDARY_NAV)}
          </nav>

          {/* 底部实用工具与连接状态 */}
          <div className="pt-3 mt-2 border-t border-[var(--border-subtle)] space-y-1">
            {isElectron && (
              <button
                type="button"
                onMouseEnter={(e) => showCompactTip(e, "显示 / 隐藏桌宠")}
                onMouseLeave={hideCompactTip}
                onClick={() => {
                  setPetActive((v) => !v);
                  window.taiwanBotEnv?.togglePetVisibility();
                }}
                className={`group w-full h-9 flex items-center rounded-[10px] text-[13px] transition-colors cursor-pointer overflow-hidden ${
                  petActive
                    ? "text-[var(--text-primary)] hover:bg-[var(--bg-hover)] font-medium"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                }`}
              >
                <span
                  className={`w-9 h-9 flex items-center justify-center shrink-0 transition-colors ${
                    petActive
                      ? "text-[var(--ink-primary)]"
                      : "text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]"
                  }`}
                >
                  <IconWindow className="w-[18px] h-[18px]" filled={petActive} />
                </span>
                <span
                  className={`truncate whitespace-nowrap pr-2.5 transition-[opacity,transform] duration-150 ${
                    isCompact
                      ? "opacity-0 -translate-x-1 pointer-events-none"
                      : "opacity-100 translate-x-0"
                  }`}
                >
                  显示 / 隐藏桌宠
                </span>
              </button>
            )}

            <button
              type="button"
              onMouseEnter={(e) =>
                showCompactTip(
                  e,
                  theme === "light" ? "切换深色外观" : "切换浅色外观",
                )
              }
              onMouseLeave={hideCompactTip}
              onClick={() =>
                setTheme((t) => (t === "light" ? "dark" : "light"))
              }
              className={`group w-full h-9 flex items-center rounded-[10px] text-[13px] transition-colors cursor-pointer overflow-hidden ${
                theme === "dark"
                  ? "text-[var(--text-primary)] hover:bg-[var(--bg-hover)] font-medium"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              }`}
            >
              <span
                className={`w-9 h-9 flex items-center justify-center shrink-0 transition-colors ${
                  theme === "dark"
                    ? "text-[var(--ink-primary)]"
                    : "text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]"
                }`}
              >
                {theme === "light" ? (
                  <IconMoon className="w-[18px] h-[18px]" filled={false} />
                ) : (
                  <IconSun className="w-[18px] h-[18px]" filled={true} />
                )}
              </span>
              <span
                className={`flex-1 flex items-center justify-between min-w-0 pr-2.5 transition-[opacity,transform] duration-150 ${
                  isCompact
                    ? "opacity-0 -translate-x-1 pointer-events-none"
                    : "opacity-100 translate-x-0"
                }`}
              >
                <span className="truncate whitespace-nowrap">
                  {theme === "light" ? "深色外观" : "浅色外观"}
                </span>
                <span className="text-[11px] text-[var(--text-tertiary)] shrink-0 ml-2">
                  {theme === "light" ? "Light" : "Dark"}
                </span>
              </span>
            </button>

            <div
              onMouseEnter={(e) =>
                showCompactTip(
                  e,
                  health
                    ? `本地大脑在线 · v${health.version}`
                    : "后端未连接",
                )
              }
              onMouseLeave={hideCompactTip}
              className="h-7 flex items-center text-[11px] text-[var(--text-tertiary)] overflow-hidden"
            >
              <span className="w-9 h-7 flex items-center justify-center shrink-0">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    health ? "bg-emerald-500" : "bg-rose-500"
                  }`}
                />
              </span>
              <span
                className={`flex-1 flex items-center justify-between min-w-0 pr-2.5 transition-opacity duration-150 whitespace-nowrap ${
                  isCompact
                    ? "opacity-0 pointer-events-none"
                    : "opacity-100"
                }`}
              >
                <span className="truncate">
                  {health ? "本地大脑在线" : "后端未连接"}
                </span>
                <span className="font-mono text-[10.5px] opacity-80 shrink-0 ml-2">
                  v{health?.version ?? "0.2"}
                </span>
              </span>
            </div>
          </div>
        </div>

        {/* 右侧极简拖拽调宽热区 */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖拽调整侧边栏宽度"
          onMouseDown={handleResizeStart}
          onDoubleClick={() => {
            triggerSnapTransition();
            setIsCompact(false);
            setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
          }}
          className="group absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize z-20 flex justify-end"
        >
          <span
            className={`w-[2px] h-full transition-colors ${
              isResizing
                ? "bg-[var(--text-tertiary)]"
                : "bg-transparent group-hover:bg-[var(--border-strong)]"
            }`}
          />
        </div>
      </aside>

      {/* 图标功能条悬停自定义黑色圆角 Tooltip（挂在 aside 外层，绝不被裁切） */}
      {isCompact && hoverTip && (
        <div
          style={{
            top: `${hoverTip.top}px`,
            left: `${COMPACT_RAIL_WIDTH + 8}px`,
          }}
          className="fixed -translate-y-1/2 z-50 px-2.5 py-1.5 rounded-lg bg-[#141414] text-white text-[12px] font-medium tracking-tight shadow-[0_6px_20px_rgba(0,0,0,0.22)] border border-white/10 pointer-events-none whitespace-nowrap"
        >
          {hoverTip.label}
        </div>
      )}

      {/* 右侧主画布 */}
      <main className="flex-1 min-w-0 h-full overflow-hidden bg-[var(--bg-canvas)]">
        {activeTab === "chat" && <ChatView {...viewProps} />}
        {activeTab === "history" && <HistoryView {...viewProps} />}
        {activeTab === "habits" && <HabitsView {...viewProps} />}
        {activeTab === "journal" && <JournalView {...viewProps} />}
        {activeTab === "reports" && <ReportsView {...viewProps} />}
        {activeTab === "settings" && <SettingsView {...viewProps} />}
      </main>
    </div>
  );
}
