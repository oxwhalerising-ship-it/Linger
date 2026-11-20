/**
 * ChatGPT Desktop 风格极简线性图标集（1.5px 精细描边）
 * ---------------------------------------------------
 * 统一 24x24 视口、1.6px 圆角描边与克制几何比例，
 * 覆盖侧边栏导航、对话输入胶囊、语音交互、日历、报表与系统设置。
 */

interface IconProps {
  className?: string;
  filled?: boolean;
}

const baseProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.65,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconChat({
  className = "w-[18px] h-[18px]",
  filled = false,
}: IconProps) {
  if (filled) {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M12.5 3C7.25 3 3 7.03 3 12c0 1.48.38 2.88 1.05 4.11L3 21l4.97-1.08A9.77 9.77 0 0 0 12.5 21c5.25 0 9.5-4.03 9.5-9s-4.25-9-9.5-9Z" />
      </svg>
    );
  }
  return (
    <svg {...baseProps} className={className}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

export function IconChecklist({
  className = "w-[18px] h-[18px]",
  filled = false,
}: IconProps) {
  if (filled) {
    return (
      <svg viewBox="0 0 24 24" className={className}>
        <rect
          x="3"
          y="3"
          width="18"
          height="18"
          rx="5"
          fill="currentColor"
        />
        <path
          d="m8.2 12.2 2.5 2.5 5.1-5.4"
          fill="none"
          stroke="var(--bg-sidebar)"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg {...baseProps} className={className}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
      <path d="m8.5 12 2.4 2.4 4.8-5.2" />
    </svg>
  );
}

export function IconCalendar({
  className = "w-[18px] h-[18px]",
  filled = false,
}: IconProps) {
  if (filled) {
    return (
      <svg viewBox="0 0 24 24" className={className}>
        <path
          d="M8 3v3M16 3v3"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <rect
          x="3"
          y="5"
          width="18"
          height="16"
          rx="4"
          fill="currentColor"
        />
        <path
          d="M3 10h18"
          stroke="var(--bg-sidebar)"
          strokeWidth="1.6"
        />
        <circle cx="8.5" cy="14" r="1.15" fill="var(--bg-sidebar)" />
        <circle cx="12" cy="14" r="1.15" fill="var(--bg-sidebar)" />
        <circle cx="15.5" cy="14" r="1.15" fill="var(--bg-sidebar)" />
      </svg>
    );
  }
  return (
    <svg {...baseProps} className={className}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="3.5" />
      <path d="M8 3.2v3.2M16 3.2v3.2M3.5 9.8h17" />
    </svg>
  );
}

export function IconAnalytics({
  className = "w-[18px] h-[18px]",
  filled = false,
}: IconProps) {
  if (filled) {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <rect x="5" y="11.5" width="3.8" height="7" rx="1.2" />
        <rect x="10.1" y="7.5" width="3.8" height="11" rx="1.2" />
        <rect x="15.2" y="4" width="3.8" height="14.5" rx="1.2" />
        <rect x="4" y="19.5" width="16" height="1.6" rx="0.8" />
      </svg>
    );
  }
  return (
    <svg {...baseProps} className={className}>
      <path d="M4.5 19.5h15" />
      <rect x="6" y="12" width="3" height="5" rx="1" />
      <rect x="10.5" y="8" width="3" height="9" rx="1" />
      <rect x="15" y="5" width="3" height="12" rx="1" />
    </svg>
  );
}

export function IconSettings({
  className = "w-[18px] h-[18px]",
  filled = false,
}: IconProps) {
  if (filled) {
    return (
      <svg viewBox="0 0 24 24" className={className}>
        <path
          fill="currentColor"
          d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        />
        <circle cx="12" cy="12" r="3.2" fill="var(--bg-sidebar)" />
      </svg>
    );
  }
  return (
    <svg {...baseProps} className={className}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function IconSparkles({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
      <path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z" />
    </svg>
  );
}

export function IconSidebar({ className = "w-[18px] h-[18px]" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16" />
    </svg>
  );
}

export function IconArrowUp({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} strokeWidth={2} className={className}>
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </svg>
  );
}

export function IconMic({ className = "w-[17px] h-[17px]" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21" />
      <path d="M9 21h6" />
    </svg>
  );
}

export function IconStop({ className = "w-3.5 h-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  );
}

export function IconVolumeOn({ className = "w-[17px] h-[17px]" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}

export function IconVolumeOff({ className = "w-[17px] h-[17px]" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="m21 9-6 6" />
      <path d="m15 9 6 6" />
    </svg>
  );
}

export function IconChevronDown({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function IconChevronLeft({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function IconChevronRight({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function IconCopy({ className = "w-3.5 h-3.5" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function IconCheck({ className = "w-3.5 h-3.5" }: IconProps) {
  return (
    <svg {...baseProps} strokeWidth={2} className={className}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

export function IconPlus({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconTrash({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    </svg>
  );
}

export function IconSun({
  className = "w-4 h-4",
  filled = false,
}: IconProps) {
  if (filled) {
    return (
      <svg viewBox="0 0 24 24" className={className}>
        <circle cx="12" cy="12" r="4.5" fill="currentColor" />
        <path
          d="M12 2.5v2.2M12 19.3v2.2M4.93 4.93l1.55 1.55M17.52 17.52l1.55 1.55M2.5 12h2.2M19.3 12h2.2M4.93 19.07l1.55-1.55M17.52 6.48l1.55-1.55"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg {...baseProps} className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2.5 12h2M19.5 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

export function IconMoon({
  className = "w-4 h-4",
  filled = false,
}: IconProps) {
  if (filled) {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M20.35 14.7A8.5 8.5 0 1 1 9.3 3.65a.6.6 0 0 1 .76.76 6.6 6.6 0 0 0 9.53 9.53.6.6 0 0 1 .76.76Z" />
      </svg>
    );
  }
  return (
    <svg {...baseProps} className={className}>
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </svg>
  );
}

export function IconEye({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  );
}

export function IconEyeOff({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="M1 1l22 22" />
      <path d="M6.61 6.61A13.52 13.52 0 0 0 2 12s3.5 6.5 10 6.5a9.74 9.74 0 0 0 5.39-1.61" />
    </svg>
  );
}

export function IconClock({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  );
}

export function IconBrain({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="M9.5 4a3.5 3.5 0 0 0-3.3 4.6A3.5 3.5 0 0 0 5 15a3.5 3.5 0 0 0 4.5 4.8V4Z" />
      <path d="M14.5 4a3.5 3.5 0 0 1 3.3 4.6A3.5 3.5 0 0 1 19 15a3.5 3.5 0 0 1-4.5 4.8V4Z" />
      <path d="M12 4v16" />
    </svg>
  );
}

export function IconSmile({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 14.2s1.2 1.8 3.5 1.8 3.5-1.8 3.5-1.8" />
      <circle cx="9.2" cy="10" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="14.8" cy="10" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconWindow({
  className = "w-4 h-4",
  filled = false,
}: IconProps) {
  if (filled) {
    return (
      <svg viewBox="0 0 24 24" className={className}>
        <rect
          x="3"
          y="4.5"
          width="18"
          height="15"
          rx="3"
          fill="currentColor"
        />
        <path
          d="M3 9.2h18"
          stroke="var(--bg-sidebar)"
          strokeWidth="1.5"
        />
        <circle cx="6.5" cy="6.9" r="0.85" fill="var(--bg-sidebar)" />
        <circle cx="9.2" cy="6.9" r="0.85" fill="var(--bg-sidebar)" />
      </svg>
    );
  }
  return (
    <svg {...baseProps} className={className}>
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="M3 9h18" />
      <circle cx="6.5" cy="6.8" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="9" cy="6.8" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconSliders({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="2" fill="var(--bg-canvas)" />
      <circle cx="15" cy="17" r="2" fill="var(--bg-canvas)" />
    </svg>
  );
}

export function IconWaveform({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />
    </svg>
  );
}

export function IconPhone({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

export function IconPhoneOff({ className = "w-5 h-5" }: IconProps) {
  return (
    <svg {...baseProps} strokeWidth={1.85} className={className}>
      <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67" />
      <path d="M6.34 10.66A19.48 19.48 0 0 1 2.08 4.18 2 2 0 0 1 4.06 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91" />
      <path d="M23 1 1 23" />
    </svg>
  );
}

export function IconMicOff({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="M1 1l22 22" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
      <path d="M15 9.34V6a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2" />
      <path d="M19 10v2a7 7 0 0 1-.11 1.23" />
      <path d="M12 19v3" />
      <path d="M8 22h8" />
    </svg>
  );
}

export function IconCaptions({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M7 13h4M13 13h4M7 16h6" />
    </svg>
  );
}

export function IconHand({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="M18 11V6a2 2 0 0 0-4 0" />
      <path d="M14 10V4a2 2 0 0 0-4 0v6" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  );
}

export function IconHistory({
  className = "w-[18px] h-[18px]",
  filled = false,
}: IconProps) {
  if (filled) {
    return (
      <svg viewBox="0 0 24 24" className={className}>
        <circle cx="12" cy="12" r="9" fill="currentColor" />
        <path
          d="M12 7.5V12l3.2 2"
          fill="none"
          stroke="var(--bg-sidebar)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg {...baseProps} className={className}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  );
}

export function IconSearch({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.8-3.8" />
    </svg>
  );
}

export function IconEdit({ className = "w-3.5 h-3.5" }: IconProps) {
  return (
    <svg {...baseProps} className={className}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
