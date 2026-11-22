/**
 * 可插拔桌宠形象渲染器（AvatarRenderer）
 * --------------------------------------
 * 设计模式：策略渲染（Strategy Renderer）
 * - builtin-sprite：默认内置「灵儿 3D 分层可交互桌宠」（保留 3D 公仔正面原貌与左深右浅晶体蓝眼）
 * - custom-image：支持用户上传自定义 PNG/GIF/WebP 形象图片（保留呼吸/互动微动效）
 * - live2d：预留后续接入 pixi-live2d-display（.model3.json）的标准接口
 */

import type { RefObject } from "react";
import type { AvatarConfig, PetDockPose, PetEmotion } from "../../types/pet";
import LingerAvatar, { type TomatoClockProp } from "./LingerAvatar";

export type { TomatoClockProp };

interface AvatarRendererProps {
  emotion: PetEmotion;
  config?: AvatarConfig;
  size?: number;
  dndEnabled?: boolean;
  /** 是否正在被摸头（驱动三段式「进入 → 保持 → 回落」动画） */
  isPatting?: boolean;
  /** 摸头反应情绪偏好 */
  patMood?: "shy" | "happy";
  /** 是否正在被拖起 */
  isDragging?: boolean;
  /** 展开环绕按钮时的撒向天空手势 */
  isCastingMenu?: boolean;
  /** 番茄时钟飞行姿态 */
  flightPose?: "none" | "fly-right" | "fly-left";
  /** 迷你灵儿托着番茄圆环姿态 */
  holdingFocus?: boolean;
  /** 怀抱立体番茄造型倒计时时钟状态 */
  tomatoClock?: TomatoClockProp | null;
  /** 边缘躲藏偷看 / 应用窗口边框倚靠与坐下姿态 */
  dockPose?: PetDockPose;
  /** 鼠标视线与头部追踪目标 */
  lookTarget?: { x: number; y: number } | null;
  /** 纯净验证模式（关闭装饰光环/角标，仅看脸部与动作） */
  cleanMode?: boolean;
  /** 静态快照模式 */
  staticFrame?: boolean;
  /** 可选 SVG 引用（用于导出表情包） */
  svgRef?: RefObject<SVGSVGElement | null>;
}

/** 根据当前情绪返回自定义图片模式下的 CSS 微动效类名 */
function getMotionClass(emotion: PetEmotion): string {
  switch (emotion) {
    case "happy":
    case "excited":
    case "laughing":
    case "surprised":
      return "animate-pet-bounce";
    case "encouraging":
    case "proud":
      return "animate-pet-encourage";
    case "speaking":
      return "animate-pet-talk";
    case "sleepy":
    case "bored":
      return "animate-pet-sleepy";
    default:
      return "animate-pet-float";
  }
}

/**
 * 可插拔入口：根据 AvatarConfig 自动路由到灵儿 3D 分层形象、自定义图片或 Live2D 占位器
 */
export default function AvatarRenderer({
  emotion,
  config = { provider: "builtin-sprite" },
  size = 148,
  dndEnabled = false,
  isPatting = false,
  patMood = "shy",
  isDragging = false,
  isCastingMenu = false,
  flightPose = "none",
  holdingFocus = false,
  tomatoClock = null,
  dockPose = "none",
  lookTarget = null,
  cleanMode = false,
  staticFrame = false,
  svgRef,
}: AvatarRendererProps) {
  // 1. 自定义图片模式（若用户已上传对应表情图或默认图）
  if (config.provider === "custom-image") {
    const imgSrc =
      config.customImageMap?.[emotion] ?? config.customImageMap?.idle;
    if (imgSrc) {
      return (
        <div
          className="relative flex items-center justify-center select-none"
          style={{ width: size, height: size }}
        >
          <img
            src={imgSrc}
            alt={`自定义桌宠形象（${emotion}）`}
            draggable={false}
            className={`w-full h-full object-contain ${getMotionClass(emotion)} drop-shadow-[0_8px_12px_rgba(0,0,0,0.18)]`}
          />
          {!cleanMode && dndEnabled && (
            <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded-full bg-slate-800/85 text-sky-100 text-[10px]">
              静音
            </span>
          )}
        </div>
      );
    }
  }

  // 2. 预留 Live2D 扩展口（后续接入 pixi-live2d-display 加载 .model3.json）
  if (config.provider === "live2d") {
    return (
      <div
        className="relative flex flex-col items-center justify-center rounded-3xl bg-sky-50/90 border border-sky-200 p-3 text-center shadow-md"
        style={{ width: size, height: size }}
      >
        <span className="text-2xl">✨</span>
        <span className="text-xs font-semibold text-sky-950 mt-1">
          Live2D 扩展位
        </span>
        <span className="text-[10px] text-slate-500 mt-0.5 break-all line-clamp-2">
          {config.live2dModelPath || "待导入 .model3.json"}
        </span>
      </div>
    );
  }

  // 3. 迷你头像快速路径（聊天气泡/历史列表 size <= 40）：
  // 直接渲染灵儿 3D 头像 PNG，避免每条消息挂载 11 层 <image> + 12 个 SVG <defs> 滤镜，DOM 节点减少 90%+
  if (size <= 40 && !svgRef) {
    return (
      <div
        className="relative flex items-center justify-center rounded-full overflow-hidden bg-sky-50/90 border border-sky-200/70 select-none shrink-0"
        style={{ width: size, height: size }}
      >
        <img
          src="./linger/avatar_3d.png"
          alt="灵儿"
          draggable={false}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
        />
      </div>
    );
  }

  // 4. 默认使用内置「灵儿」3D 分层可交互形象
  return (
    <LingerAvatar
      emotion={emotion}
      size={size}
      dndEnabled={dndEnabled}
      isPatting={isPatting}
      patMood={patMood}
      isDragging={isDragging}
      isCastingMenu={isCastingMenu}
      flightPose={flightPose}
      holdingFocus={holdingFocus}
      tomatoClock={tomatoClock}
      dockPose={dockPose}
      lookTarget={lookTarget}
      cleanMode={cleanMode}
      staticFrame={staticFrame}
      svgRef={svgRef}
    />
  );
}
