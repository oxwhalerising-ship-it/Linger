/**
 * 前端通用格式化工具与共享选项常量
 */

export interface SpeedOption {
  label: string;
  rate: string;
  shortLabel: string;
}

export const VOICE_SPEED_OPTIONS: SpeedOption[] = [
  { label: "慢速", rate: "-10%", shortLabel: "0.9x" },
  { label: "标准", rate: "+0%", shortLabel: "1.0x" },
  { label: "轻快", rate: "+15%", shortLabel: "1.15x" },
  { label: "快速", rate: "+25%", shortLabel: "1.25x" },
  { label: "极速", rate: "+38%", shortLabel: "1.38x" },
];

export function formatElapsedSec(sec: number): string {
  const safe = Math.max(0, Math.floor(sec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatDurationMs(ms?: number | null): string {
  if (!ms || ms <= 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
