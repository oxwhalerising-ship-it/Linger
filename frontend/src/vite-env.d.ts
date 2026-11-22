/// <reference types="vite/client" />

// 桌宠预览事件载荷类型
interface PetPreviewPayload {
  emotion?: import("./types/pet").PetEmotion;
  bubble?: string;
}

// 桌宠与主面板之间的实时通话同步载荷类型
interface VoiceCallTurnSyncPayload {
  turnId: number;
  userText: string;
  assistantReply: string;
  durationMs: number;
  timestampMs: number;
  tags?: string[];
  pendingHabits?: Array<{ id: number; title: string; category: string }>;
}

// 唤起主控面板时的可选目标页载荷
interface DashboardNavigateTarget {
  page?: string;
  planSection?: "tasks" | "focus" | "habits";
  date?: string;
}

// 声明 Electron preload.cjs 暴露在 window 上的全局桌面 API 类型
interface TaiwanBotEnv {
  platform: string;
  backendBaseUrl: string;
  setIgnoreMouseEvents: (
    ignore: boolean,
    options?: { forward?: boolean },
  ) => void;
  startPetDrag: () => void;
  updatePetDrag: () => void;
  endPetDrag: () => void;
  setPetExpanded: (expanded: boolean) => void;
  setPetMode?: (
    mode: "compact" | "quick-chat" | "call" | "focus-setup" | "focus" | "focus-alert",
  ) => void;
  flyPetToFocus?: () => Promise<{
    ok: boolean;
    direction: "none" | "fly-right" | "fly-left";
  }>;
  flyPetBackOrigin?: () => Promise<{
    ok: boolean;
    direction: "none" | "fly-right" | "fly-left";
  }>;
  syncFocusState?: (payload: Record<string, unknown>) => void;
  onPetFlightState?: (
    callback: (payload: {
      active: boolean;
      direction: "none" | "fly-right" | "fly-left";
    }) => void,
  ) => () => void;
  onFocusStateSynced?: (
    callback: (payload: Record<string, unknown>) => void,
  ) => () => void;
  setPetPeekRevealed?: (revealed: boolean) => void;
  notifyPetReady?: () => void;
  notifyVoiceCallOwner?: (owner: "pet" | "dashboard" | "none") => void;
  syncVoiceCallTurn?: (payload: VoiceCallTurnSyncPayload) => void;
  movePetWindow: (deltaX: number, deltaY: number) => void;
  showPetContextMenu: () => void;
  openDashboard: (target?: DashboardNavigateTarget) => void;
  onDashboardNavigate?: (
    callback: (target: DashboardNavigateTarget) => void,
  ) => () => void;
  togglePetVisibility: () => void;
  setPetDnd?: (enabled: boolean) => void;
  quitApp?: () => void;
  sendPetPreviewState: (payload: PetPreviewPayload) => void;
  getAutoStart: () => Promise<boolean>;
  setAutoStart: (enabled: boolean) => Promise<boolean>;
  onPetPreviewState: (callback: (payload: PetPreviewPayload) => void) => () => void;
  onPetDndChanged: (callback: (enabled: boolean) => void) => () => void;
  onOpenQuickChat: (callback: () => void) => () => void;
  onTogglePetVoiceCall?: (callback: () => void) => () => void;
  onForceStopVoiceCall?: (callback: () => void) => () => void;
  onVoiceCallTurnSynced?: (
    callback: (payload: VoiceCallTurnSyncPayload) => void,
  ) => () => void;
  onPetDockStateChanged?: (
    callback: (payload: {
      pose: import("./types/pet").PetDockPose;
      isPeeking?: boolean;
    }) => void,
  ) => () => void;
  onPetSummoned?: (
    callback: (payload: { shortcut?: string }) => void,
  ) => () => void;
  getAuthToken?: () => Promise<string>;
  getBackendStatus?: () => Promise<BackendStatus>;
  onBackendStatus?: (callback: (status: BackendStatus) => void) => () => void;
}

interface BackendStatus {
  state: "starting" | "installing" | "ready" | "down";
  detail: string;
}

interface Window {
  taiwanBotEnv?: TaiwanBotEnv;
  lingerEnv?: TaiwanBotEnv;
}
