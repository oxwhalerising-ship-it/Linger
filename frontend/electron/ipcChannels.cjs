/**
 * Electron 主进程与渲染进程共享 IPC 通道常量
 * 统一管理通道名称，避免硬编码字符串漂移与死通道残留。
 */
module.exports = {
  // Pet -> Main
  PET_DRAG_START: "pet:drag-start",
  PET_DRAG_MOVE: "pet:drag-move",
  PET_DRAG_END: "pet:drag-end",
  PET_PEEK_HOVER: "pet:peek-hover",
  PET_SET_EXPANDED: "pet:set-expanded",
  PET_SET_MODE: "pet:set-mode",
  PET_TOGGLE_VISIBILITY: "pet:toggle-visibility",
  PET_PREVIEW_STATE: "pet:preview-state",
  PET_SET_DND: "pet:set-dnd",
  PET_READY: "pet:ready",

  // Main -> Pet
  PET_DOCK_STATE_CHANGED: "pet:dock-state-changed",
  PET_SUMMONED: "pet:summoned",
  PET_DND_CHANGED: "pet:dnd-changed",
  PET_TOGGLE_VOICE_CALL: "pet:toggle-voice-call",

  // Voice call cross-window sync & mutex
  VOICE_CALL_NOTIFY_OWNER: "voice-call:notify-owner",
  VOICE_CALL_FORCE_STOP: "voice-call:force-stop",
  VOICE_CALL_SYNC_TURN: "voice-call:sync-turn",
  VOICE_CALL_TURN_SYNCED: "voice-call:turn-synced",

  // App lifecycle
  APP_OPEN_DASHBOARD: "app:open-dashboard",
  APP_QUIT: "app:quit",
  APP_GET_AUTOSTART: "app:get-autostart",
  APP_SET_AUTOSTART: "app:set-autostart",
};
