/**
 * 灵儿专属环绕水晶道具菜单（PetRadialMenu）
 * -----------------------------------------
 * 当鼠标悬浮在灵儿身上时，配合灵儿「双手张开撒向天空」的施法动效，
 * 7 枚与灵儿蓝白水晶人设高度契合的定制道具按钮沿弧线丝滑弹射并环绕四周：
 * 1. 打电话（水晶海螺话筒）
 * 2. 文本交流（蓝缎带星语气泡）
 * 3. 显示主控制板（星辉水晶棱镜）
 * 4. 灵儿表情（标志晶体蓝花）
 * 5. 免打扰模式（云月静音铃）
 * 6. 隐藏至托盘（云隐小云朵）
 * 7. 退出（星门开关）
 *
 * 性能与防遮挡保障：
 * - 纯 GPU transform (translate3d / scale) + 弹性贝塞尔缓动 + 28ms 错峰展开，60fps 无卡顿
 * - 轨道半径精准适配 312×300 舞台，按钮与悬浮标签绝不裁切、绝不遮挡灵儿面部
 */

import { useState } from "react";
import { playPetSound } from "../../services/petSoundEffects";
import { PET_EMOTION_META, type PetEmotion } from "../../types/pet";

export interface PetRadialMenuProps {
  open: boolean;
  callOpen: boolean;
  dndEnabled: boolean;
  emotionPickerOpen: boolean;
  currentEmotion: PetEmotion;
  onToggleCall: () => void;
  onToggleEmotionPicker: () => void;
  onSelectEmotion: (emotion: PetEmotion) => void;
  onToggleDnd: () => void;
  onHideToTray: () => void;
  onQuitApp: () => void;
  onHoverChange?: (hovering: boolean) => void;
}

const QUICK_EMOTIONS: Array<{ id: PetEmotion; short: string }> = [
  { id: "idle", short: "待机" },
  { id: "happy", short: "开心" },
  { id: "curious", short: "好奇" },
  { id: "aggrieved", short: "委屈" },
  { id: "shy", short: "害羞" },
  { id: "startled", short: "受惊" },
  { id: "sleepy", short: "云朵睡" },
];

interface OrbitItem {
  id: string;
  label: string;
  angleDeg: number;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}

/** 定制水晶/蓝白少女风道具图标 */
function PropCrystalPhone({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 28 28" className="w-[21px] h-[21px]">
      <defs>
        <linearGradient id="propPhoneG" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={active ? "#FB7185" : "#60A5FA"} />
          <stop offset="100%" stopColor={active ? "#E11D48" : "#2563EB"} />
        </linearGradient>
      </defs>
      <path
        d="M8.5 5.8c.7-.7 1.8-.6 2.4.1l1.9 2.4c.5.7.4 1.6-.2 2.2l-1.1 1.1c.9 1.9 2.4 3.4 4.3 4.3l1.1-1.1c.6-.6 1.5-.7 2.2-.2l2.4 1.9c.7.6.8 1.7.1 2.4l-1.3 1.3c-1.1 1.1-2.8 1.5-4.3.9-4.5-1.8-8.2-5.5-10-10-.6-1.5-.2-3.2.9-4.3l1.6-1.6z"
        fill="url(#propPhoneG)"
        stroke="#FFFFFF"
        strokeWidth="1.2"
      />
      <path d="M16.5 6.5a5 5 0 0 1 5 5" fill="none" stroke="#93C5FD" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="19.5" cy="8.5" r="1.4" fill="#E0F2FE" />
    </svg>
  );
}

function PropCrystalFlower() {
  return (
    <svg viewBox="0 0 28 28" className="w-[22px] h-[22px]">
      <g transform="translate(14,14)">
        {[0, 72, 144, 216, 288].map((deg) => (
          <path
            key={deg}
            d="M0,-2 C2.8,-5 3.6,-9.5 0,-11.2 C-3.6,-9.5 -2.8,-5 0,-2 Z"
            fill="#60A5FA"
            stroke="#FFFFFF"
            strokeWidth="0.9"
            transform={`rotate(${deg})`}
          />
        ))}
        <circle cx="0" cy="0" r="3" fill="#E0F2FE" stroke="#2563EB" strokeWidth="1" />
      </g>
    </svg>
  );
}

function PropMoonBell({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 28 28" className="w-[21px] h-[21px]">
      <path
        d="M16.8 6.2a7.8 7.8 0 1 0 5 11.4 6.2 6.2 0 1 1-5-11.4z"
        fill={active ? "#818CF8" : "#60A5FA"}
        stroke="#FFFFFF"
        strokeWidth="1.2"
      />
      {active ? (
        <line x1="6" y1="6" x2="22" y2="22" stroke="#F43F5E" strokeWidth="2.4" strokeLinecap="round" />
      ) : (
        <path d="M19.5 7l.8 1.8 1.8.8-1.8.8-.8 1.8-.8-1.8-1.8-.8 1.8-.8z" fill="#FDE047" />
      )}
    </svg>
  );
}

function PropCloudHide() {
  return (
    <svg viewBox="0 0 28 28" className="w-[21px] h-[21px]">
      <path
        d="M8.5 19.5h11.2a4.3 4.3 0 0 0 .8-8.5A5.8 5.8 0 0 0 9.4 9.5a4.5 4.5 0 0 0-.9 10z"
        fill="#93C5FD"
        stroke="#FFFFFF"
        strokeWidth="1.3"
      />
      <path d="M14 14.5v6m0 0l-2.4-2.2M14 20.5l2.4-2.2" fill="none" stroke="#1D4ED8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PropStarExit() {
  return (
    <svg viewBox="0 0 28 28" className="w-[20px] h-[20px]">
      <path
        d="M14 5.5v7"
        fill="none"
        stroke="#F43F5E"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M9.2 8.8a7.4 7.4 0 1 0 9.6 0"
        fill="none"
        stroke="#FB7185"
        strokeWidth="2.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function PetRadialMenu({
  open,
  callOpen,
  dndEnabled,
  emotionPickerOpen,
  currentEmotion,
  onToggleCall,
  onToggleEmotionPicker,
  onSelectEmotion,
  onToggleDnd,
  onHideToTray,
  onQuitApp,
  onHoverChange,
}: PetRadialMenuProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // 5 枚水晶道具沿正圆轨道以 40° 等距对称环绕灵儿（双击灵儿即可打开主控面板）
  const items: OrbitItem[] = [
    {
      id: "dnd",
      label: dndEnabled ? "关闭免打扰" : "免打扰模式",
      angleDeg: -170,
      active: dndEnabled,
      onClick: onToggleDnd,
      icon: <PropMoonBell active={dndEnabled} />,
    },
    {
      id: "emotions",
      label: "灵儿表情",
      angleDeg: -130,
      active: emotionPickerOpen,
      onClick: onToggleEmotionPicker,
      icon: <PropCrystalFlower />,
    },
    {
      id: "call",
      label: callOpen ? "挂断通话" : "打电话",
      angleDeg: -90,
      active: callOpen,
      onClick: onToggleCall,
      icon: <PropCrystalPhone active={callOpen} />,
    },
    {
      id: "hide",
      label: "隐藏至托盘",
      angleDeg: -50,
      onClick: onHideToTray,
      icon: <PropCloudHide />,
    },
    {
      id: "quit",
      label: "退出",
      angleDeg: -10,
      danger: true,
      onClick: onQuitApp,
      icon: <PropStarExit />,
    },
  ];

  // 正圆轨道半径（背景环与 7 枚水晶道具严格落在同一标准正圆上）
  const orbitRadius = 104;

  return (
    <div
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
      aria-hidden={!open}
    >
      {/* 灵儿撒向天空时的淡蓝星辉正圆环绕光圈 */}
      <div
        className="absolute rounded-full border border-sky-300/50 transition-all duration-500 ease-out"
        style={{
          width: orbitRadius * 2,
          height: orbitRadius * 2,
          opacity: open ? 0.88 : 0,
          transform: open ? "scale(1) rotate(0deg)" : "scale(0.35) rotate(-32deg)",
          boxShadow: open
            ? "0 0 24px rgba(96, 165, 250, 0.24) inset, 0 0 18px rgba(56, 189, 248, 0.16)"
            : "none",
        }}
      />

      {/* 7 枚水晶道具环绕按钮 */}
      {items.map((item, idx) => {
        const rad = (item.angleDeg * Math.PI) / 180;
        const tx = Math.cos(rad) * orbitRadius;
        const ty = Math.sin(rad) * orbitRadius;
        const isHovered = hoveredId === item.id;
        const delayMs = open ? idx * 28 : (items.length - 1 - idx) * 18;

        return (
          <div
            key={item.id}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              transform: open
                ? `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) translate(-50%, -50%) scale(${isHovered ? 1.14 : 1})`
                : "translate3d(0px, 14px, 0) translate(-50%, -50%) scale(0.22) rotate(-25deg)",
              opacity: open ? 1 : 0,
              transition: `transform 420ms cubic-bezier(0.34, 1.48, 0.64, 1) ${delayMs}ms, opacity 240ms ease-out ${delayMs}ms`,
              pointerEvents: open ? "auto" : "none",
              zIndex: isHovered ? 40 : 20,
            }}
            onPointerEnter={() => {
              setHoveredId(item.id);
              onHoverChange?.(true);
              if (open) {
                playPetSound("pulse", { muted: dndEnabled });
              }
            }}
            onPointerLeave={() => {
              setHoveredId((prev) => (prev === item.id ? null : prev));
            }}
          >
            <button
              type="button"
              tabIndex={open ? 0 : -1}
              onClick={(e) => {
                e.stopPropagation();
                playPetSound("notch", { muted: dndEnabled });
                item.onClick();
              }}
              aria-label={item.label}
              className={`relative w-10 h-10 rounded-full flex items-center justify-center cursor-pointer border backdrop-blur-md transition-shadow duration-200 ${
                item.active
                  ? "bg-sky-500/90 border-white shadow-[0_6px_18px_rgba(59,130,246,0.48)]"
                  : item.danger
                    ? "bg-white/92 hover:bg-rose-50 border-rose-200/90 shadow-[0_6px_16px_rgba(244,63,94,0.2)]"
                    : "bg-white/92 hover:bg-sky-50 border-sky-200/90 shadow-[0_6px_16px_rgba(59,130,246,0.24)]"
              }`}
            >
              {item.icon}
            </button>

            {/* 悬浮清晰文字提示胶囊（智能避让灵儿头部不遮挡） */}
            <div
              className="pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap px-2 py-0.5 rounded-full text-[10.5px] font-semibold tracking-wide bg-slate-900/88 text-sky-50 shadow-md transition-all duration-150"
              style={{
                top: ty < -40 ? "-24px" : "44px",
                opacity: isHovered && open ? 1 : 0,
                transform: `translateY(${isHovered && open ? "0px" : "4px"})`,
              }}
            >
              {item.label}
            </div>
          </div>
        );
      })}

      {/* 点击「灵儿表情」道具后在底部展开的紧凑水晶表情快选条 */}
      {open && emotionPickerOpen && (
        <div
          className="pointer-events-auto absolute bottom-1 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1 px-2 py-1.5 rounded-full bg-white/94 backdrop-blur-md border border-sky-200/90 shadow-[0_8px_24px_rgba(37,99,235,0.22)] animate-bubble-pop"
          onPointerEnter={() => onHoverChange?.(true)}
          onClick={(e) => e.stopPropagation()}
        >
          {QUICK_EMOTIONS.map((item) => {
            const active = currentEmotion === item.id;
            return (
              <button
                key={item.id}
                type="button"
                title={PET_EMOTION_META[item.id].label}
                onPointerEnter={() => {
                  playPetSound("pulse", { muted: dndEnabled });
                }}
                onClick={() => {
                  playPetSound("notch", { muted: dndEnabled });
                  onSelectEmotion(item.id);
                }}
                className={`px-2 py-0.5 rounded-full text-[10.5px] font-medium whitespace-nowrap cursor-pointer transition-colors ${
                  active
                    ? "bg-sky-500 text-white shadow-sm"
                    : "text-slate-600 hover:bg-sky-100 hover:text-sky-700"
                }`}
              >
                {item.short}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
