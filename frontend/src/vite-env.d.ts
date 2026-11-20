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
  setPetMode?: (mode: "compact" | "quick-chat" | "call") => void;
  setPetPeekRevealed?: (revealed: boolean) => void;
  notifyVoiceCallOwner?: (owner: "pet" | "dashboard" | "none") => void;
  syncVoiceCallTurn?: (payload: VoiceCallTurnSyncPayload) => void;
  movePetWindow: (deltaX: number, deltaY: number) => void;
  showPetContextMenu: () => void;
  openDashboard: () => void;
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
}

interface Window {
  taiwanBotEnv?: TaiwanBotEnv;
}
