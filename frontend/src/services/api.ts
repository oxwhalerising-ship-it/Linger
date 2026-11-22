/**
 * 主控面板全量后端 API 客户端（Step 5）
 * --------------------------------------
 * 统一封装与本地 Python FastAPI（127.0.0.1:8765）的所有数据通信，
 * 包括健康检查、聊天历史、习惯、每日复盘/热力图、长期记忆、周月报与系统设置。
 */

import {
  buildAuthHeaders,
  getBackendBaseUrl,
  getWebSocketUrl,
  requestJson,
} from "./api/client";

export { getBackendBaseUrl };

export interface HealthData {
  status: string;
  service: string;
  version: string;
  greeting: string;
  server_time: string;
}

export type MessageChannel = "all" | "text" | "voice";

export interface ChatMessageItem {
  reply_to?:number|null;
  receipt?:string|null;
  id: number;
  session_date: string;
  channel?: "text" | "voice";
  role: "user" | "assistant" | "system";
  content: string;
  trigger_type: string;
  created_at: string;
  updated_at?: string | null;
  duration_ms?: number | null;
}

export interface MessageSummaryDate {
  date: string;
  total_count: number;
  text_count: number;
  voice_count: number;
  last_at: string;
  last_preview: string;
}

export interface MessagesSummaryData {
  totals: {
    all: number;
    text: number;
    voice: number;
  };
  dates: MessageSummaryDate[];
}

export interface MessageListResponse {
  total: number;
  items: ChatMessageItem[];
  channel: MessageChannel;
  date: string | null;
  q: string;
  limit: number;
  offset: number;
}

export interface HabitItem {
  id: number;
  title: string;
  category: string;
  frequency: string;
  target_desc: string;
  is_active: boolean;
  created_at: string;
}

export interface HabitBoardItem extends HabitItem {
  today_status: "done" | "partial" | "missed" | null;
  streak: number;
  week: Array<{ date: string; status: "done" | "partial" | "missed" | null }>;
}

export interface TaskItem {
  id: number;
  title: string;
  notes: string;
  important: boolean;
  due_date: string | null;
  status: "open" | "done";
  completed_at: string | null;
  created_at: string;
}

export interface FocusSessionItem {
  id: number;
  task_id: number | null;
  task_title: string | null;
  kind: "focus" | "break";
  planned_seconds: number;
  actual_seconds: number;
  started_at: string;
  ended_at: string;
  session_date: string;
  completed: boolean;
}

export interface FocusDay {
  date: string;
  focus_count: number;
  focus_minutes: number;
  sessions: FocusSessionItem[];
}

export interface FocusOverview {
  today_count: number;
  today_seconds: number;
  total_count: number;
  total_seconds: number;
  days: Array<{ date: string; sessions: FocusSessionItem[] }>;
}

export interface HabitRecordItem {
  habit_id: number;
  habit_title: string;
  category: string;
  status: "done" | "partial" | "missed";
  note: string;
  recorded_at: string;
}

export interface DailyLogDetail {
  date: string;
  summary: string;
  mood_score: number | null;
  energy_score: number | null;
  highlights: string[];
  md_path: string;
  updated_at: string;
  habit_records: HabitRecordItem[];
  markdown_content: string;
}

export interface MonthlyHeatmapDay {
  date: string;
  summary: string;
  mood_score: number | null;
  energy_score: number | null;
  highlights: string[];
  done_count: number;
  recorded_count: number;
  md_path: string;
  updated_at: string;
}

export interface MemoryItem {
  source_message_id?:number | null;
  id: number;
  memory_type: "preference" | "ongoing_event" | "highlight";
  content: string;
  follow_up_date: string | null;
  is_resolved: boolean;
  created_at: string;
}

export interface ReportStats {
  daily_done?:Record<string,number>;
  start_date: string;
  end_date: string;
  total_days: number;
  logged_days: number;
  overall_completion_rate: number;
  avg_mood: number | null;
  avg_energy: number | null;
  habit_breakdown: Array<{
    habit_id: number;
    title: string;
    category: string;
    done: number;
    partial: number;
    missed: number;
    completion_rate: number;
  }>;
  trend: Array<{
    date: string;
    mood_score: number | null;
    energy_score: number | null;
  }>;
  highlights: Array<{ date: string; text: string }>;
}

export interface ReportItem {
  id: number;
  period_type: "weekly" | "monthly";
  start_date: string;
  end_date: string;
  stats: ReportStats;
  ai_analysis: string;
  used_llm?: boolean;
  md_path: string;
  created_at: string;
}

export interface VoiceOption {
  id: string;
  name: string;
  style?: string;
}

export interface SttStatusData {
  ready: boolean;
  engine: string;
  model_dir: string;
  message: string;
  setup_hints?: string[];
}

export interface ModelStatusData {
  items: Array<{ id: string; name: string; ready: boolean; description: string }>;
  missing: string[];
  downloading: boolean;
  error?: string | null;
  started?: boolean;
}

export interface WakewordStatusData {
  enabled: boolean;
  listening: boolean;
  keyword: string;
  ready: boolean;
  privacy_mode: string;
  model_dir: string;
  last_triggered_at: string | null;
  last_error: string | null;
  setup_hints?: string[];
  blocked_by_dnd?: boolean;
}

export type ScheduleEventType =
  | "morning_plan"
  | "noon_checkin"
  | "evening_review"
  | "bedtime_nudge"
  | "random_bubble";

export interface ScheduleNodeConfig {
  enabled: boolean;
  time: string;
  label: string;
}

export interface ScheduleConfig {
  morning_plan: ScheduleNodeConfig;
  noon_checkin: ScheduleNodeConfig;
  evening_review: ScheduleNodeConfig;
  bedtime_nudge: ScheduleNodeConfig;
  random_bubble: {
    enabled: boolean;
    start_time: string;
    end_time: string;
    daily_count: number;
  };
  dnd_enabled: boolean;
}

export interface ScheduleStatusData {
  running: boolean;
  dnd_enabled: boolean;
  connected_clients: number;
  schedule: ScheduleConfig;
  jobs: Array<{
    id: string;
    name: string;
    next_run_time: string | null;
  }>;
}

/** 构造后端 WebSocket 实时事件推送地址（ws://127.0.0.1:8765/ws/events） */
export function getEventsWebSocketUrl(): string {
  return getWebSocketUrl("/ws/events");
}

/** 构造后端一对一实时语音通话 WebSocket 地址（ws://127.0.0.1:8765/ws/voice-call） */
export function getVoiceCallWebSocketUrl(): string {
  return getWebSocketUrl("/ws/voice-call");
}

/** 格式化本地日期为 YYYY-MM-DD */
export function formatLocalDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface Highlight {id:number; date:string; content:string; favorite:boolean}
export type Insights = ReportStats & {activity: Record<string,number>; streak:number};
export const api = {
  retryArchive:(id:number)=>requestJson<import("./petApi").ChatResponseData["extracted"]>(`/api/chat/messages/${id}/archive`,{method:"POST"}),
  message:(id:number)=>requestJson<ChatMessageItem & {thread_id?:string}>(`/api/chat/messages/${id}`),
  threads: () => requestJson<{id:string; title:string}[]>("/api/chat/threads"),
  thread: (id:string) => requestJson<{messages:ChatMessageItem[]}>(`/api/chat/threads/${encodeURIComponent(id)}`),
  insights: (period:string, end:string) => requestJson<Insights>(`/api/reports/insights?period_type=${period}&end_date=${end}`),
  highlights: (month:string) => requestJson<Highlight[]>(`/api/logs/highlights/list?month=${month}`),
  favorite: (id:number, value:boolean) => requestJson(`/api/logs/highlights/${id}/favorite?favorite=${value}`,{method:"PUT"}),
  appendHighlight: (date:string,content:string) => requestJson<DailyLogDetail>(`/api/logs/${date}/highlights`,{method:"POST",body:JSON.stringify({content})}),
  editMemory: (item:MemoryItem) => requestJson<MemoryItem>(`/api/memories/${item.id}`,{method:"PATCH",body:JSON.stringify(item)}),
  reportMarkdown: (id:number) => requestJson<{text:string}>(`/api/reports/${id}/markdown`),

  // 健康检查
  getHealth: () => requestJson<HealthData>("/api/health"),

  // 对话历史与全量增删改查（文本 / 语音分区）
  getChatHistory: (date?: string) =>
    requestJson<{ date: string; messages: ChatMessageItem[] }>(
      `/api/chat/history${date ? `?date=${encodeURIComponent(date)}` : ""}`,
    ),
  getMessagesSummary: () =>
    requestJson<MessagesSummaryData>("/api/chat/messages/summary"),
  listMessages: (params?: {
    channel?: MessageChannel;
    date?: string | null;
    role?: "user" | "assistant" | "system" | null;
    q?: string;
    order?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }) => {
    const sp = new URLSearchParams();
    if (params?.channel) sp.set("channel", params.channel);
    if (params?.date) sp.set("date", params.date);
    if (params?.role) sp.set("role", params.role);
    if (params?.q?.trim()) sp.set("q", params.q.trim());
    if (params?.order) sp.set("order", params.order);
    if (typeof params?.limit === "number") sp.set("limit", String(params.limit));
    if (typeof params?.offset === "number") sp.set("offset", String(params.offset));
    const qs = sp.toString();
    return requestJson<MessageListResponse>(
      `/api/chat/messages${qs ? `?${qs}` : ""}`,
    );
  },
  createMessage: (payload: {
    session_date?: string;
    channel: "text" | "voice";
    role: "user" | "assistant";
    content: string;
  }) =>
    requestJson<ChatMessageItem>("/api/chat/messages", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateMessage: (
    id: number,
    payload: Partial<{
      content: string;
      role: "user" | "assistant";
      channel: "text" | "voice";
      session_date: string;
    }>,
  ) =>
    requestJson<ChatMessageItem>(`/api/chat/messages/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteMessage: (id: number) =>
    requestJson<{ deleted: boolean; id: number }>(`/api/chat/messages/${id}`, {
      method: "DELETE",
    }),
  batchDeleteMessages: (payload: {
    ids?: number[];
    date?: string | null;
    channel?: MessageChannel;
  }) =>
    requestJson<{ deleted_count: number }>("/api/chat/messages/batch-delete", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // 习惯管理
  listHabits: (activeOnly = false) =>
    requestJson<HabitItem[]>(`/api/habits?active_only=${activeOnly}`),
  createHabit: (payload: {
    title: string;
    category: string;
    target_desc: string;
  }) =>
    requestJson<HabitItem>("/api/habits", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateHabit: (
    id: number,
    payload: Partial<{
      title: string;
      category: string;
      target_desc: string;
      is_active: boolean;
    }>,
  ) =>
    requestJson<HabitItem>(`/api/habits/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteHabit: (id: number) =>
    requestJson<{ deleted: boolean }>(`/api/habits/${id}`, {
      method: "DELETE",
    }),
  habitBoard: (date: string) =>
    requestJson<{ date: string; items: HabitBoardItem[] }>(
      `/api/habits/board?date=${encodeURIComponent(date)}`,
    ),

  listTasks: (scope: "today" | "later" | "done" = "today", on?: string) =>
    requestJson<TaskItem[]>(
      `/api/tasks?scope=${scope}${on ? `&on=${encodeURIComponent(on)}` : ""}`,
    ),
  createTask: (payload: { title: string; due_date?: string | null; important?: boolean }) =>
    requestJson<TaskItem>("/api/tasks", { method: "POST", body: JSON.stringify(payload) }),
  updateTask: (
    id: number,
    payload: Partial<{
      title: string;
      important: boolean;
      due_date: string | null;
      status: "open" | "done";
    }>,
  ) =>
    requestJson<TaskItem>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  postponeTask: (id: number, on?: string) =>
    requestJson<TaskItem>(`/api/tasks/${id}/postpone${on ? `?on=${encodeURIComponent(on)}` : ""}`, {
      method: "POST",
    }),
  deleteTask: (id: number) =>
    requestJson<{ deleted: boolean }>(`/api/tasks/${id}`, { method: "DELETE" }),

  focusOverview: (on?: string) =>
    requestJson<FocusOverview>(`/api/focus/overview${on ? `?on=${encodeURIComponent(on)}` : ""}`),
  focusDay: (date: string) =>
    requestJson<FocusDay>(`/api/focus/days/${encodeURIComponent(date)}`),
  recordFocus: (payload: {
    client_id: string;
    task_id: number | null;
    kind: "focus" | "break";
    planned_seconds: number;
    actual_seconds: number;
    started_at: string;
    session_date: string;
    completed: boolean;
  }) =>
    requestJson<FocusSessionItem>("/api/focus/sessions", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  focusCompanionMessage: (payload: {
    event: "focus_completed" | "break_completed";
    task_title?: string;
    focus_minutes?: number;
    round?: number;
    break_type?: "short" | "long";
    mode?: "pomodoro" | "stopwatch";
  }) =>
    requestJson<{
      reply: string;
      sentences: string[];
      emotion: string;
      suggestion_tag: string;
      used_fallback: boolean;
    }>("/api/focus/companion-message", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // 每日复盘与月度热力图
  getMonthlyLogs: (month: string) =>
    requestJson<{ month: string; days: MonthlyHeatmapDay[] }>(
      `/api/logs?month=${encodeURIComponent(month)}`,
    ),
  getDailyLog: (dateStr: string) =>
    requestJson<DailyLogDetail>(`/api/logs/${encodeURIComponent(dateStr)}`),
  upsertDailyLog: (
    dateStr: string,
    payload: {
      summary?: string;
      mood_score?: number;
      energy_score?: number;
      highlights?: string[];
    },
  ) =>
    requestJson<DailyLogDetail>(`/api/logs/${encodeURIComponent(dateStr)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  recordDailyHabit: (
    dateStr: string,
    payload: {
      habit_id: number;
      status: "done" | "partial" | "missed";
      note?: string;
    },
  ) =>
    requestJson<DailyLogDetail>(
      `/api/logs/${encodeURIComponent(dateStr)}/habits`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),

  // 长期记忆
  listMemories: (memoryType?: string) =>
    requestJson<MemoryItem[]>(
      `/api/memories${memoryType ? `?memory_type=${encodeURIComponent(memoryType)}` : ""}`,
    ),
  createMemory: (payload: {
    memory_type: "preference" | "ongoing_event" | "highlight";
    content: string;
    follow_up_date?: string | null;
  }) =>
    requestJson<MemoryItem>("/api/memories", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deleteMemory: (id: number) =>
    requestJson<{ deleted: boolean }>(`/api/memories/${id}`, {
      method: "DELETE",
    }),

  // 周报与月报
  listReports: () => requestJson<{ reports: ReportItem[] }>("/api/reports"),
  generateReport: (periodType: "weekly" | "monthly", endDate?: string) =>
    requestJson<ReportItem>("/api/reports/generate", {
      method: "POST",
      body: JSON.stringify({ period_type: periodType, end_date: endDate }),
    }),

  // 语音与设置
  getVoices: () =>
    requestJson<{
      voices: VoiceOption[];
      fish_models?: VoiceOption[];
      current: Record<string, unknown>;
    }>("/api/voice/voices"),
  getSttStatus: () => requestJson<SttStatusData>("/api/voice/stt/status"),
  getModelStatus: () => requestJson<ModelStatusData>("/api/voice/models/status"),
  transcribeAudioWav: async (wavBlob: Blob): Promise<{ text: string }> => {
    const form = new FormData();
    form.append("audio", wavBlob, "speech.wav");
    const headers = await buildAuthHeaders();
    const res = await fetch(`${getBackendBaseUrl()}/api/voice/stt`, {
      method: "POST",
      headers,
      body: form,
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.detail) detail = String(body.detail);
      } catch {
        // ignore
      }
      throw new Error(detail);
    }
    return (await res.json()) as { text: string };
  },
  testModel:(model:string,base_url:string,api_key:string)=>requestJson("/api/settings/test-model",{method:"POST",body:JSON.stringify({model,base_url,api_key})}),
  getSettings: () => requestJson<Record<string, unknown>>("/api/settings"),
  updateSettings: (settings: Record<string, unknown>) =>
    requestJson<Record<string, unknown>>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ settings }),
    }),

  // 全天作息调度与主动陪伴（Step 6）
  getScheduleStatus: () => requestJson<ScheduleStatusData>("/api/schedule/status"),
  triggerScheduleEvent: (eventType: ScheduleEventType) =>
    requestJson<{ sent: boolean; delivered_clients?: number }>(
      "/api/schedule/trigger",
      {
        method: "POST",
        body: JSON.stringify({ event_type: eventType }),
      },
    ),
  snoozeScheduleEvent: (eventType: ScheduleEventType, delayMinutes = 15) =>
    requestJson<{ snoozed: boolean; resume_at: string }>("/api/schedule/snooze", {
      method: "POST",
      body: JSON.stringify({
        event_type: eventType,
        delay_minutes: delayMinutes,
      }),
    }),
  toggleDnd: (enabled: boolean) =>
    requestJson<{ dnd_enabled: boolean }>("/api/schedule/dnd", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),

  // 纯本地离线语音唤醒（Step 7）
  getWakewordStatus: () =>
    requestJson<WakewordStatusData>("/api/voice/wakeword/status"),
  toggleWakeword: (enabled: boolean, keyword?: string) =>
    requestJson<WakewordStatusData>("/api/voice/wakeword/toggle", {
      method: "POST",
      body: JSON.stringify({ enabled, keyword }),
    }),
  simulateWakeword: () =>
    requestJson<{
      triggered: boolean;
      delivered_clients: number;
      reason?: string;
    }>(
      "/api/voice/wakeword/simulate",
      { method: "POST" },
    ),
};
