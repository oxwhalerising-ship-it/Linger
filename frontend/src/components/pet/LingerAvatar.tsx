/**
 * 灵儿（Ling'er）V2 全身骨骼 + 自然单睫毛眨眼 + 符号道具可交互桌宠
 * -------------------------------------------------------------------
 * 1. 全身父子骨骼树（基于无损 3D 正面母版拆分）：
 *    Root -> Leg_L / Leg_R + Torso -> Arm_L / Arm_R + Head -> Ahoge + FaceRig + Bangs + Pendant
 * 2. 自然单层跟随式眼睑与睫毛：
 *    原画固定上睫毛已无痕移除，仅保留一条随上眼睑自然下压的弧形深蓝睫毛，
 *    开心/大笑时上扬为弯月 ⌒，彻底告别双睫毛僵硬感（已移除 ◡ ◡ 向下闭眼变形）。
 * 3. 特色符号与互动场景：
 *    - 困倦/长待机：自动拿出云朵蕾丝枕头与星月小毛毯，骨架侧躺盖被入睡 + 漂浮 Zzz
 *    - 无聊：懒洋洋晃手玩虹彩小泡泡
 *    - 好奇 / 委屈 / 害羞 / 受惊 / 开心 / 生气：专属蓝白水晶风格符号增强辨识度
 * 4. 完整保留摸头三段式（0-0.2s 眨眼缩头 → 0.2-0.7s 看手躲视线渐红 → 保持偷看 → 松手 0.8s 依次回落）
 *    与水晶花坠二阶阻尼摆钟物理。
 */

import { useEffect, useId, useRef, useState } from "react";
import type { PetDockPose, PetEmotion } from "../../types/pet";
import {
  LINGER_POSES,
  type LingerMouthShape,
  type LingerPose,
  type LingerSymbolType,
} from "./lingerExpressions";

export interface LingerAvatarProps {
  emotion: PetEmotion;
  size?: number;
  dndEnabled?: boolean;
  isPatting?: boolean;
  patMood?: "shy" | "happy";
  isDragging?: boolean;
  /** 展开环绕功能按钮时的「双手张开撒向天空」短暂施法动作 */
  isCastingMenu?: boolean;
  /** 靠显示器边缘躲藏偷看 / 靠应用窗口左右边框倚靠 / 上下边框坐下姿态 */
  dockPose?: PetDockPose;
  /** 鼠标视线与头部追踪目标（归一化坐标 x,y ∈ [-1, 1]，null 表示回到自然视线） */
  lookTarget?: { x: number; y: number } | null;
  /** 纯净验证模式：隐藏外部符号与道具，仅看骨架与面部表情 */
  cleanMode?: boolean;
  staticFrame?: boolean;
  svgRef?: React.RefObject<SVGSVGElement | null>;
}

interface LiveRigState {
  gazeX: number;
  gazeY: number;
  irisScale: number;
  upperLid: number;
  upperLidTilt: number;
  closedEyeStyle: "arc-up" | "arc-down";
  lowerLid: number;
  browLY: number;
  browLTilt: number;
  browRY: number;
  browRTilt: number;
  blush: number;
  tear: number;
  headTiltDeg: number;
  headY: number;
  torsoTiltDeg: number;
  bodyY: number;
  bodyScaleX: number;
  bodyScaleY: number;
  armLDeg: number;
  armRDeg: number;
  legLDeg: number;
  legRDeg: number;
  ahogeDeg: number;
  pendantDeg: number;
  /** 侧躺睡觉进度 0（站立）~ 1（躺上云朵枕头盖被睡觉） */
  sleepLay: number;
  mouth: LingerMouthShape;
  mouthOpen: number;
  symbol: LingerSymbolType;
  animTime: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function poseToInitialState(pose: LingerPose): LiveRigState {
  const isSleep = pose.motion === "sleep-pillow";
  return {
    gazeX: pose.gazeX,
    gazeY: pose.gazeY,
    irisScale: pose.irisScale,
    upperLid: pose.upperLid,
    upperLidTilt: pose.upperLidTilt,
    closedEyeStyle: pose.closedEyeStyle,
    lowerLid: pose.lowerLid,
    browLY: pose.browLY,
    browLTilt: pose.browLTilt,
    browRY: pose.browRY,
    browRTilt: pose.browRTilt,
    blush: pose.blush,
    tear: pose.tear,
    headTiltDeg: pose.headTiltDeg,
    headY: pose.headY,
    torsoTiltDeg: pose.torsoTiltDeg,
    bodyY: pose.bodyY,
    bodyScaleX: pose.bodyScaleX,
    bodyScaleY: pose.bodyScaleY,
    armLDeg: pose.armLDeg,
    armRDeg: pose.armRDeg,
    legLDeg: pose.legLDeg,
    legRDeg: pose.legRDeg,
    ahogeDeg: pose.ahogeDeg,
    pendantDeg: -pose.headTiltDeg * 0.6,
    sleepLay: isSleep ? 1 : 0,
    mouth: pose.mouth,
    mouthOpen: 0.45,
    symbol: pose.symbol,
    animTime: 0,
  };
}

/**
 * 渲染单只自然跟随式眼睛（无双睫毛！）
 * 仅有一条优美渐细的 3D 深蓝弧形上睫毛直接跟随上眼睑运动并在闭合时自然弯曲变形。
 */
function renderNaturalEye(opts: {
  side: "L" | "R";
  cx: number;
  cy: number;
  irisHref: string;
  clipId: string;
  uid: string;
  gazeX: number;
  gazeY: number;
  irisScale: number;
  upperLid: number;
  upperLidTilt: number;
  closedEyeStyle: "arc-up" | "arc-down";
  lowerLid: number;
  tear: number;
}) {
  const {
    side,
    cx,
    cy,
    irisHref,
    clipId,
    uid,
    gazeX,
    gazeY,
    irisScale,
    upperLid,
    upperLidTilt,
    closedEyeStyle,
    lowerLid,
    tear,
  } = opts;

  const lid = clamp(upperLid, -0.15, 1.0);
  const tilt = side === "L" ? upperLidTilt : -upperLidTilt;
  const closedT = clamp((lid - 0.65) / 0.35, 0, 1);

  // 上眼睑边缘中心 Y：睁眼时在眼眶上缘 (cy - 35)，闭合时沿自然上拱弧线下压（已移除 ◡ ◡ 向下反弯变形）
  const edgeY = cy - 35 + lid * 52;
  const openArch = -18;
  const closedArch = -16;
  const ctrlOffset = lerp(openArch, closedArch, Math.pow(Math.max(0, lid), 1.3));
  const cornerY = edgeY + lerp(16, 8, Math.max(0, lid));

  const leftX = cx - 44;
  const rightX = cx + 44;
  const wingX = side === "L" ? leftX - 11 : rightX + 11;
  const wingY = cornerY - lerp(5, 3, Math.max(0, lid));

  // 闭合时下眼皮自然向上迎合（彻底遮住眼底，绝无闭眼露蓝瞳！）
  const blinkLowerMeet = closedT * 1.15;
  const effectiveLower = Math.max(clamp(lowerLid, 0, 0.6), blinkLowerMeet);
  const lowerEdgeY = cy + 37 - effectiveLower * 34;

  return (
    <g>
      {/* 1. 眼眶内部裁剪区：晶体虹膜 + 委屈薄泪 + 上下柔肤眼睑 */}
      <g clipPath={`url(#${clipId})`}>
        {/* 锁定原貌的左深/右浅晶体蓝虹膜 */}
        <g
          transform={`translate(${(cx + gazeX).toFixed(2)}, ${(cy + gazeY).toFixed(2)}) scale(${irisScale.toFixed(3)}) translate(${-cx}, ${-cy})`}
        >
          <image href={irisHref} x={cx - 42} y={cy - 42} width="84" height="84" />
        </g>

        {/* 委屈/难过：下眼眶晶莹薄泪层 */}
        {tear > 0.04 && closedT < 0.7 && (
          <g opacity={(tear * (1 - closedT)).toFixed(2)}>
            <path
              d={`M ${cx - 40} ${lowerEdgeY - 3} Q ${cx} ${lowerEdgeY + 8} ${cx + 40} ${lowerEdgeY - 3} L ${cx + 40} ${cy + 40} L ${cx - 40} ${cy + 40} Z`}
              fill={`url(#tearGrad-${uid})`}
            />
            <ellipse cx={cx - 16} cy={lowerEdgeY - 3} rx="9" ry="3.2" fill="#FFFFFF" opacity="0.92" />
            <circle cx={cx + 15} cy={lowerEdgeY - 1} r="2.8" fill="#FFFFFF" opacity="0.85" />
          </g>
        )}

        {/* 上眼睑皮肤遮罩（完全跟随单条睫毛弧线无缝下压） */}
        <g transform={`rotate(${tilt.toFixed(1)}, ${cx}, ${cy})`}>
          <path
            d={`M ${leftX - 12} ${cy - 68} L ${rightX + 12} ${cy - 68} L ${rightX + 12} ${cornerY.toFixed(1)} Q ${cx} ${(edgeY + ctrlOffset).toFixed(1)} ${leftX - 12} ${cornerY.toFixed(1)} Z`}
            fill={`url(#lidSkin-${uid})`}
          />
          {/* 上眼睑柔和双眼皮褶线 */}
          <path
            d={`M ${leftX + 6} ${(cornerY - 10).toFixed(1)} Q ${cx} ${(edgeY + ctrlOffset - 11).toFixed(1)} ${rightX - 6} ${(cornerY - 10).toFixed(1)}`}
            fill="none"
            stroke="#CEB2B4"
            strokeWidth="1.9"
            strokeLinecap="round"
            opacity="0.65"
          />
        </g>

        {/* 下眼睑柔化笑肌 + 闭眼时无缝向上迎合（完全遮盖眼白与虹膜） */}
        {effectiveLower > 0.04 && (
          <g>
            <path
              d={`M ${leftX - 8} ${lowerEdgeY.toFixed(1)} Q ${cx} ${(lowerEdgeY - 11 * clamp(lowerLid, 0, 0.6)).toFixed(1)} ${rightX + 8} ${lowerEdgeY.toFixed(1)} L ${rightX + 8} ${cy + 54} L ${leftX - 8} ${cy + 54} Z`}
              fill={`url(#lidSkin-${uid})`}
            />
            {closedT < 0.5 && lowerLid > 0.04 && (
              <path
                d={`M ${cx - 26} ${(lowerEdgeY + 2).toFixed(1)} Q ${cx} ${(lowerEdgeY - 9 * lowerLid + 2).toFixed(1)} ${cx + 26} ${(lowerEdgeY + 2).toFixed(1)}`}
                fill="none"
                stroke="#D8B3B5"
                strokeWidth="2.2"
                strokeLinecap="round"
                opacity="0.6"
              />
            )}
          </g>
        )}
      </g>

      {/* 2. 单条主上睫毛（位于裁剪区外，拥有自然外翘眼尾与优雅弧度，绝无双睫毛！） */}
      <g transform={`rotate(${tilt.toFixed(1)}, ${cx}, ${cy})`}>
        {/* 主弧形厚睫毛 */}
        <path
          d={`M ${leftX + 2} ${cornerY.toFixed(1)} Q ${cx} ${(edgeY + ctrlOffset).toFixed(1)} ${rightX - 2} ${cornerY.toFixed(1)}`}
          fill="none"
          stroke="#1B2246"
          strokeWidth={lerp(7.5, 6.2, lid).toFixed(1)}
          strokeLinecap="round"
        />
        {/* 俏皮外眼角睫毛尾翼 */}
        <path
          d={
            side === "L"
              ? `M ${leftX + 5} ${(cornerY - 1).toFixed(1)} Q ${leftX - 4} ${(cornerY - 2).toFixed(1)} ${wingX} ${wingY.toFixed(1)}`
              : `M ${rightX - 5} ${(cornerY - 1).toFixed(1)} Q ${rightX + 4} ${(cornerY - 2).toFixed(1)} ${wingX} ${wingY.toFixed(1)}`
          }
          fill="none"
          stroke="#1B2246"
          strokeWidth="4.4"
          strokeLinecap="round"
        />
        {/* 几根精致纤细小睫毛丝（睁眼时自然可见） */}
        {lid < 0.65 && (
          <g stroke="#1B2246" strokeWidth="2.4" strokeLinecap="round" opacity={(1 - lid).toFixed(2)}>
            <line
              x1={side === "L" ? cx - 22 : cx + 22}
              y1={(edgeY + ctrlOffset * 0.55).toFixed(1)}
              x2={side === "L" ? cx - 27 : cx + 27}
              y2={(edgeY + ctrlOffset * 0.55 - 8).toFixed(1)}
            />
            <line
              x1={cx}
              y1={(edgeY + ctrlOffset * 0.6).toFixed(1)}
              x2={cx}
              y2={(edgeY + ctrlOffset * 0.6 - 8).toFixed(1)}
            />
          </g>
        )}
      </g>
    </g>
  );
}

/** 渲染匹配 3D 原画质感的嘴部矢量 */
function renderMouth(shape: LingerMouthShape, mouthOpen: number, uid: string) {
  const cx = 267;
  const cy = 388;

  switch (shape) {
    case "open-happy":
      return (
        <g>
          <path
            d={`M ${cx - 19} ${cy - 4} Q ${cx} ${cy - 1} ${cx + 19} ${cy - 4} Q ${cx + 18} ${cy + 16} ${cx} ${cy + 16} Q ${cx - 18} ${cy + 16} ${cx - 19} ${cy - 4} Z`}
            fill={`url(#mouthGrad-${uid})`}
            stroke="#C97E7B"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <ellipse cx={cx} cy={cy + 9} rx="10" ry="5" fill="#F8B1B0" opacity="0.7" />
        </g>
      );
    case "big-laugh":
      return (
        <g>
          <path
            d={`M ${cx - 24} ${cy - 6} Q ${cx} ${cy - 2} ${cx + 24} ${cy - 6} Q ${cx + 23} ${cy + 22} ${cx} ${cy + 22} Q ${cx - 23} ${cy + 22} ${cx - 24} ${cy - 6} Z`}
            fill={`url(#mouthGrad-${uid})`}
            stroke="#C47471"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <ellipse cx={cx} cy={cy + 13} rx="13" ry="6.5" fill="#FCA5A5" opacity="0.75" />
        </g>
      );
    case "small-o":
      return (
        <ellipse
          cx={cx}
          cy={cy + 2}
          rx="8.5"
          ry="9.5"
          fill={`url(#mouthGrad-${uid})`}
          stroke="#C98380"
          strokeWidth="1.8"
        />
      );
    case "startled-o":
      return (
        <g>
          <ellipse
            cx={cx}
            cy={cy + 3}
            rx="12.5"
            ry="15"
            fill={`url(#mouthGrad-${uid})`}
            stroke="#BA706E"
            strokeWidth="2.1"
          />
          <ellipse cx={cx} cy={cy + 10} rx="6.5" ry="4" fill="#F8A8A8" opacity="0.6" />
        </g>
      );
    case "pout-aggrieved":
      return (
        <g>
          <path
            d={`M ${cx - 14} ${cy + 7} Q ${cx - 5} ${cy - 1} ${cx} ${cy + 1} Q ${cx + 5} ${cy - 1} ${cx + 14} ${cy + 7}`}
            fill="none"
            stroke="#C27876"
            strokeWidth="3.2"
            strokeLinecap="round"
          />
          <ellipse cx={cx} cy={cy + 10} rx="8" ry="2.6" fill="#E3A5A3" opacity="0.55" />
        </g>
      );
    case "sad-frown":
      return (
        <path
          d={`M ${cx - 15} ${cy + 9} Q ${cx} ${cy - 2} ${cx + 15} ${cy + 9}`}
          fill="none"
          stroke="#C27B79"
          strokeWidth="3.1"
          strokeLinecap="round"
        />
      );
    case "shy-smile":
      return (
        <g>
          <path
            d={`M ${cx - 14} ${cy + 1} Q ${cx} ${cy + 11} ${cx + 14} ${cy + 1}`}
            fill="none"
            stroke="#C97C7A"
            strokeWidth="3.1"
            strokeLinecap="round"
          />
          <ellipse cx={cx} cy={cy + 7} rx="7" ry="2.2" fill="#F4A4A4" opacity="0.4" />
        </g>
      );
    case "smirk-proud":
      return (
        <path
          d={`M ${cx - 13} ${cy + 4} Q ${cx + 3} ${cy + 9} ${cx + 16} ${cy - 2}`}
          fill="none"
          stroke="#C57B78"
          strokeWidth="3.2"
          strokeLinecap="round"
        />
      );
    case "wavy-awkward":
      return (
        <path
          d={`M ${cx - 16} ${cy + 4} Q ${cx - 8} ${cy - 2} ${cx} ${cy + 4} Q ${cx + 8} ${cy + 10} ${cx + 16} ${cy + 3}`}
          fill="none"
          stroke="#C57B78"
          strokeWidth="3"
          strokeLinecap="round"
        />
      );
    case "puffed-cheek":
      return (
        <g>
          <path
            d={`M ${cx - 11} ${cy + 4} Q ${cx} ${cy + 1} ${cx + 11} ${cy + 4}`}
            fill="none"
            stroke="#C47876"
            strokeWidth="3.2"
            strokeLinecap="round"
          />
          <path
            d={`M ${cx - 13} ${cy + 1} Q ${cx - 16} ${cy + 5} ${cx - 12} ${cy + 8}`}
            fill="none"
            stroke="#D99492"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d={`M ${cx + 13} ${cy + 1} Q ${cx + 16} ${cy + 5} ${cx + 12} ${cy + 8}`}
            fill="none"
            stroke="#D99492"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </g>
      );
    case "angry-frown":
      return (
        <path
          d={`M ${cx - 16} ${cy + 8} Q ${cx} ${cy - 4} ${cx + 16} ${cy + 8} Q ${cx} ${cy + 11} ${cx - 16} ${cy + 8} Z`}
          fill={`url(#mouthGrad-${uid})`}
          stroke="#BC6D6A"
          strokeWidth="1.9"
          strokeLinejoin="round"
        />
      );
    case "sleepy-o":
      return (
        <ellipse
          cx={cx}
          cy={cy + 4}
          rx="6.5"
          ry="7.5"
          fill={`url(#mouthGrad-${uid})`}
          stroke="#CF8D8A"
          strokeWidth="1.6"
          opacity="0.92"
        />
      );
    case "speaking": {
      const ry = 4.5 + mouthOpen * 10.5;
      const rx = 11 + mouthOpen * 5.5;
      return (
        <g>
          <ellipse
            cx={cx}
            cy={cy + 2}
            rx={rx}
            ry={ry}
            fill={`url(#mouthGrad-${uid})`}
            stroke="#C77B78"
            strokeWidth="1.9"
          />
          {mouthOpen > 0.35 && (
            <ellipse
              cx={cx}
              cy={cy + ry * 0.45}
              rx={rx * 0.55}
              ry={ry * 0.32}
              fill="#F9B4B4"
              opacity="0.7"
            />
          )}
        </g>
      );
    }
    case "soft-smile":
    default:
      return (
        <g>
          <path
            d={`M ${cx - 17} ${cy - 3} Q ${cx} ${cy} ${cx + 17} ${cy - 3} Q ${cx + 15} ${cy + 12} ${cx} ${cy + 12} Q ${cx - 15} ${cy + 12} ${cx - 17} ${cy - 3} Z`}
            fill={`url(#mouthGrad-${uid})`}
            stroke="#CC8380"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <ellipse cx={cx} cy={cy + 7} rx="8.5" ry="3.8" fill="#F8B5B5" opacity="0.62" />
        </g>
      );
  }
}

/** 渲染富有特色的二次元/水晶风动态符号元素 */
function renderEmotionSymbols(symbol: LingerSymbolType, t: number, uid: string) {
  const bob = Math.sin(t * 3.2) * 8;
  const pulse = 1 + Math.sin(t * 4.5) * 0.1;

  switch (symbol) {
    case "happy-stars":
      return (
        <g className="pointer-events-none">
          {/* 左上闪烁星芒 */}
          <g transform={`translate(56, ${(120 + bob).toFixed(1)}) scale(${pulse.toFixed(2)})`}>
            <path
              d="M 0 -24 L 6 -6 L 24 0 L 6 6 L 0 24 L -6 6 L -24 0 L -6 -6 Z"
              fill="#60A5FA"
              stroke="#FFFFFF"
              strokeWidth="2.5"
            />
          </g>
          {/* 右上暖金小星与跳动音符 */}
          <g transform={`translate(454, ${(96 - bob * 0.8).toFixed(1)}) scale(${(1.05 - (pulse - 1)).toFixed(2)})`}>
            <path
              d="M 0 -17 L 4.5 -4.5 L 17 0 L 4.5 4.5 L 0 17 L -4.5 4.5 L -17 0 L -4.5 -4.5 Z"
              fill="#FBBF24"
              stroke="#FFFFFF"
              strokeWidth="2"
            />
          </g>
          <g transform={`translate(474, ${(165 + bob * 0.9).toFixed(1)}) rotate(${(Math.sin(t * 4) * 10).toFixed(1)})`}>
            <text
              x="0"
              y="0"
              fill="#3B82F6"
              stroke="#FFFFFF"
              strokeWidth="4"
              paintOrder="stroke"
              fontSize="44"
              fontWeight="800"
            >
              ♪
            </text>
          </g>
        </g>
      );

    case "curious-q":
      return (
        <g
          transform={`translate(445, ${(118 + bob).toFixed(1)}) rotate(${(8 + Math.sin(t * 3.5) * 7).toFixed(1)}) scale(${pulse.toFixed(2)})`}
        >
          <text
            x="0"
            y="0"
            textAnchor="middle"
            fill="#3B82F6"
            stroke="#FFFFFF"
            strokeWidth="8"
            paintOrder="stroke"
            fontSize="82"
            fontWeight="900"
            fontFamily="system-ui, sans-serif"
          >
            ?
          </text>
          <circle cx="-36" cy="-42" r="6" fill="#93C5FD" />
        </g>
      );

    case "thought-bubbles":
      return (
        <g className="pointer-events-none">
          <circle cx="412" cy={(160 + bob * 0.4).toFixed(1)} r="9" fill="#FFFFFF" stroke="#60A5FA" strokeWidth="3.5" />
          <circle cx="436" cy={(128 + bob * 0.7).toFixed(1)} r="14" fill="#FFFFFF" stroke="#60A5FA" strokeWidth="3.5" />
          <g transform={`translate(466, ${(84 + bob).toFixed(1)})`}>
            <path
              d="M -26 6 C -38 6 -42 -12 -26 -18 C -22 -34 6 -36 16 -22 C 34 -24 44 -4 30 10 C 26 22 -18 22 -26 6 Z"
              fill="#FFFFFF"
              stroke="#60A5FA"
              strokeWidth="3.5"
            />
            <circle cx="-10" cy="-4" r="3.5" fill="#60A5FA" />
            <circle cx="4" cy="-4" r="3.5" fill="#60A5FA" />
            <circle cx="18" cy="-4" r="3.5" fill="#60A5FA" />
          </g>
        </g>
      );

    case "aggrieved-cloud": {
      const drop1 = (t * 48) % 36;
      const drop2 = (t * 48 + 18) % 36;
      return (
        <g transform={`translate(76, ${(96 + bob * 0.5).toFixed(1)})`}>
          {/* 软萌灰蓝小雨云 */}
          <path
            d="M -36 14 C -50 14 -52 -6 -36 -10 C -32 -28 -2 -32 10 -16 C 28 -20 42 -2 32 14 Z"
            fill="#94A3B8"
            stroke="#FFFFFF"
            strokeWidth="3.5"
          />
          {/* 飘落的晶莹小雨滴 */}
          <path
            d={`M -16 ${(22 + drop1).toFixed(1)} Q -21 ${(32 + drop1).toFixed(1)} -16 ${(36 + drop1).toFixed(1)} Q -11 ${(32 + drop1).toFixed(1)} -16 ${(22 + drop1).toFixed(1)} Z`}
            fill="#60A5FA"
            opacity={(1 - drop1 / 36).toFixed(2)}
          />
          <path
            d={`M 10 ${(22 + drop2).toFixed(1)} Q 5 ${(32 + drop2).toFixed(1)} 10 ${(36 + drop2).toFixed(1)} Q 15 ${(32 + drop2).toFixed(1)} 10 ${(22 + drop2).toFixed(1)} Z`}
            fill="#93C5FD"
            opacity={(1 - drop2 / 36).toFixed(2)}
          />
        </g>
      );
    }

    case "shy-hearts": {
      const rise = (t * 32) % 44;
      return (
        <g className="pointer-events-none">
          {/* 左侧漂浮暖粉小爱心 */}
          <g transform={`translate(72, ${(178 - rise).toFixed(1)}) scale(${(0.9 + pulse * 0.1).toFixed(2)})`} opacity={(1 - rise / 48).toFixed(2)}>
            <path
              d="M 0 14 C -24 -4 -22 -24 0 -10 C 22 -24 24 -4 0 14 Z"
              fill="#FB7185"
              stroke="#FFFFFF"
              strokeWidth="3"
            />
          </g>
          {/* 右上害羞小爱心 + 轻柔暖雾丝 */}
          <g transform={`translate(454, ${(138 + bob * 0.7).toFixed(1)}) rotate(12) scale(0.85)`}>
            <path
              d="M 0 14 C -24 -4 -22 -24 0 -10 C 22 -24 24 -4 0 14 Z"
              fill="#FDA4AF"
              stroke="#FFFFFF"
              strokeWidth="3"
            />
          </g>
          <path
            d={`M 416 ${(210 + bob * 0.4).toFixed(1)} Q 426 196 416 182`}
            fill="none"
            stroke="#FDA4AF"
            strokeWidth="4.5"
            strokeLinecap="round"
            opacity="0.75"
          />
        </g>
      );
    }

    case "startled-shock":
      return (
        <g className="pointer-events-none">
          {/* 右上惊叹号 */}
          <g transform={`translate(452, ${(108 + Math.sin(t * 16) * 4).toFixed(1)}) rotate(12)`}>
            <text
              x="0"
              y="0"
              textAnchor="middle"
              fill="#F43F5E"
              stroke="#FFFFFF"
              strokeWidth="8"
              paintOrder="stroke"
              fontSize="82"
              fontWeight="900"
              fontFamily="system-ui, sans-serif"
            >
              !
            </text>
          </g>
          {/* 左上受惊放射线 */}
          <g stroke="#38BDF8" strokeWidth="6" strokeLinecap="round" transform="translate(54, 124)">
            <line x1="0" y1="0" x2="-22" y2="-18" />
            <line x1="-6" y1="18" x2="-30" y2="12" />
            <line x1="12" y1="-12" x2="2" y2="-36" />
          </g>
          {/* 额侧晶莹小汗滴 */}
          <path
            d="M 406 232 Q 394 256 406 264 Q 418 256 406 232 Z"
            fill="#7DD3FC"
            stroke="#FFFFFF"
            strokeWidth="3"
          />
        </g>
      );

    case "angry-vein":
      return (
        <g transform={`translate(442, ${(116 + Math.sin(t * 12) * 3).toFixed(1)}) scale(${pulse.toFixed(2)})`}>
          {/* 经典二次元井字生气符号 */}
          <g fill="none" stroke="#EF4444" strokeWidth="7" strokeLinecap="round">
            <path d="M -22 -8 Q -6 -6 -8 -22" />
            <path d="M 22 -8 Q 6 -6 8 -22" />
            <path d="M -22 8 Q -6 6 -8 22" />
            <path d="M 22 8 Q 6 6 8 22" />
          </g>
        </g>
      );

    case "proud-sparkle":
      return (
        <g className="pointer-events-none">
          <g transform={`translate(62, ${(128 + bob).toFixed(1)}) scale(${pulse.toFixed(2)})`}>
            <path
              d="M 0 -22 L 5 -5 L 22 0 L 5 5 L 0 22 L -5 5 L -22 0 L -5 -5 Z"
              fill="#FBBF24"
              stroke="#FFFFFF"
              strokeWidth="2.5"
            />
          </g>
          <g transform={`translate(456, ${(112 - bob).toFixed(1)}) scale(${(0.85 * pulse).toFixed(2)})`}>
            <path
              d="M 0 -20 L 5 -5 L 20 0 L 5 5 L 0 20 L -5 5 L -20 0 L -5 -5 Z"
              fill="#38BDF8"
              stroke="#FFFFFF"
              strokeWidth="2.5"
            />
          </g>
        </g>
      );

    case "bored-bubble": {
      const bx = 442 + Math.sin(t * 1.8) * 16;
      const by = 435 - ((t * 28) % 90);
      const bo = clamp(1 - Math.abs(by - 390) / 55, 0.25, 0.95);
      return (
        <g opacity={bo.toFixed(2)}>
          <circle
            cx={bx.toFixed(1)}
            cy={by.toFixed(1)}
            r="24"
            fill={`url(#bubbleGrad-${uid})`}
            stroke="#BAE6FD"
            strokeWidth="2.5"
          />
          <ellipse cx={(bx - 8).toFixed(1)} cy={(by - 8).toFixed(1)} rx="7" ry="4" transform={`rotate(-30 ${bx - 8} ${by - 8})`} fill="#FFFFFF" opacity="0.85" />
          <circle cx={(bx + 18).toFixed(1)} cy={(by + 32).toFixed(1)} r="9" fill={`url(#bubbleGrad-${uid})`} stroke="#BAE6FD" strokeWidth="1.8" />
        </g>
      );
    }

    case "sleep-pillow": {
      const z1 = (t * 26) % 58;
      const z2 = (t * 26 + 29) % 58;
      return (
        <g className="pointer-events-none">
          {/* 漂浮梦幻 Zzz 与弯月 */}
          <text
            x={(352 + Math.sin(t * 1.8) * 8).toFixed(1)}
            y={(260 - z1).toFixed(1)}
            fill="#60A5FA"
            stroke="#FFFFFF"
            strokeWidth="6"
            paintOrder="stroke"
            fontSize="44"
            fontWeight="800"
            opacity={(1 - z1 / 58).toFixed(2)}
          >
            Z
          </text>
          <text
            x={(392 + Math.cos(t * 1.6) * 8).toFixed(1)}
            y={(210 - z2).toFixed(1)}
            fill="#93C5FD"
            stroke="#FFFFFF"
            strokeWidth="5"
            paintOrder="stroke"
            fontSize="30"
            fontWeight="800"
            opacity={(1 - z2 / 58).toFixed(2)}
          >
            z
          </text>
          {/* 弯月小星 */}
          <path
            d="M 92 210 A 24 24 0 1 0 120 238 A 19 19 0 1 1 92 210 Z"
            fill="#FDE047"
            stroke="#FFFFFF"
            strokeWidth="2.5"
            transform={`translate(0, ${(bob * 0.6).toFixed(1)})`}
          />
        </g>
      );
    }

    case "music-notes":
      return (
        <g transform={`translate(446, ${(145 + bob).toFixed(1)}) rotate(${(Math.sin(t * 5) * 10).toFixed(1)})`}>
          <text
            x="0"
            y="0"
            fill="#60A5FA"
            stroke="#FFFFFF"
            strokeWidth="5"
            paintOrder="stroke"
            fontSize="42"
            fontWeight="800"
          >
            ♫
          </text>
        </g>
      );

    case "none":
    default:
      return null;
  }
}

export default function LingerAvatar({
  emotion,
  size = 156,
  dndEnabled = false,
  isPatting = false,
  patMood = "shy",
  isDragging = false,
  isCastingMenu = false,
  dockPose = "none",
  lookTarget = null,
  cleanMode = false,
  staticFrame = false,
  svgRef,
}: LingerAvatarProps) {
  const uid = useId().replace(/:/g, "");
  const effectiveEmotion: PetEmotion = isDragging ? "startled" : emotion;
  const targetPose = LINGER_POSES[effectiveEmotion] ?? LINGER_POSES.idle;
  const shouldAnimate = !staticFrame && size > 40;

  const [rig, setRig] = useState<LiveRigState>(() => poseToInitialState(targetPose));

  const stateRef = useRef<LiveRigState>(poseToInitialState(targetPose));
  const targetRef = useRef<LingerPose>(targetPose);
  const pattingRef = useRef(isPatting);
  const patMoodRef = useRef(patMood);
  const draggingRef = useRef(isDragging);
  const castingMenuRef = useRef(isCastingMenu);
  const dockPoseRef = useRef<PetDockPose>(dockPose);
  const lookTargetRef = useRef<{ x: number; y: number } | null>(lookTarget);

  const patStartMsRef = useRef<number | null>(null);
  const patReleaseMsRef = useRef<number | null>(null);
  const nextBlinkMsRef = useRef<number>(performance.now() + 2500 + Math.random() * 2400);
  const blinkStartMsRef = useRef<number | null>(null);

  // 水晶花坠 & 呆毛独立二阶阻尼弹簧
  const pendAngleRef = useRef(0);
  const pendVelRef = useRef(0);
  const ahogeAngleRef = useRef(0);
  const ahogeVelRef = useRef(0);
  const prevHeadTiltRef = useRef(0);
  const prevBodyYRef = useRef(0);

  useEffect(() => {
    targetRef.current = targetPose;
    if (!shouldAnimate) {
      const next = poseToInitialState(targetPose);
      stateRef.current = next;
      setRig(next);
    }
  }, [targetPose, shouldAnimate]);

  useEffect(() => {
    const now = performance.now();
    if (isPatting && !pattingRef.current) {
      patStartMsRef.current = now;
      patReleaseMsRef.current = null;
    } else if (!isPatting && pattingRef.current) {
      patReleaseMsRef.current = now;
    }
    pattingRef.current = isPatting;
  }, [isPatting]);

  useEffect(() => {
    patMoodRef.current = patMood;
  }, [patMood]);

  useEffect(() => {
    draggingRef.current = isDragging;
  }, [isDragging]);

  useEffect(() => {
    castingMenuRef.current = isCastingMenu;
  }, [isCastingMenu]);

  useEffect(() => {
    dockPoseRef.current = dockPose;
  }, [dockPose]);

  useEffect(() => {
    lookTargetRef.current = lookTarget;
  }, [lookTarget]);

  useEffect(() => {
    if (!shouldAnimate) return;

    let rafId = 0;
    let lastMs = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.004, (now - lastMs) / 1000));
      lastMs = now;
      const tSec = now / 1000;

      const base = targetRef.current;
      const cur = stateRef.current;

      let goalGazeX = base.gazeX;
      let goalGazeY = base.gazeY;
      let goalIrisScale = base.irisScale;
      let goalUpperLid = base.upperLid;
      let goalUpperLidTilt = base.upperLidTilt;
      let goalClosedStyle = base.closedEyeStyle;
      let goalLowerLid = base.lowerLid;
      let goalBrowLY = base.browLY;
      let goalBrowLTilt = base.browLTilt;
      let goalBrowRY = base.browRY;
      let goalBrowRTilt = base.browRTilt;
      let goalBlush = base.blush;
      let goalTear = base.tear;
      let goalHeadTilt = base.headTiltDeg;
      let goalHeadY = base.headY;
      let goalTorsoTilt = base.torsoTiltDeg;
      let goalBodyY = base.bodyY;
      let goalScaleX = base.bodyScaleX;
      let goalScaleY = base.bodyScaleY;
      let goalArmL = base.armLDeg;
      let goalArmR = base.armRDeg;
      let goalLegL = base.legLDeg;
      let goalLegR = base.legRDeg;
      let goalAhoge = base.ahogeDeg;
      let goalMouth: LingerMouthShape = base.mouth;
      let goalSymbol: LingerSymbolType = base.symbol;
      const goalSleepLay = base.motion === "sleep-pillow" ? 1 : 0;

      // 1. 全身骨骼周期性动态编排
      switch (base.motion) {
        case "breathe":
          goalBodyY += Math.sin(tSec * 2.1) * 4;
          goalScaleY *= 1 + Math.sin(tSec * 2.1) * 0.008;
          goalArmL += Math.sin(tSec * 2.1) * 4.5;
          goalArmR -= Math.sin(tSec * 2.1) * 4.5;
          goalHeadTilt += Math.sin(tSec * 1.1) * 1.5;
          break;
        case "bounce":
          goalBodyY += -Math.abs(Math.sin(tSec * 5.0)) * 14;
          goalHeadTilt += Math.sin(tSec * 5.0) * 4.5;
          goalArmL += Math.sin(tSec * 5.0) * 14;
          goalArmR += Math.sin(tSec * 5.0) * 14;
          goalLegL += Math.sin(tSec * 5.0) * 10;
          goalLegR -= Math.sin(tSec * 5.0) * 10;
          break;
        case "excited":
          goalBodyY += -Math.abs(Math.sin(tSec * 7.2)) * 20;
          goalHeadTilt += Math.sin(tSec * 7.2) * 6;
          goalArmL += Math.sin(tSec * 14.4) * 16;
          goalArmR -= Math.sin(tSec * 14.4) * 16;
          goalLegL += Math.sin(tSec * 7.2) * 15;
          goalLegR -= Math.sin(tSec * 7.2) * 15;
          break;
        case "laugh":
          goalBodyY += Math.sin(tSec * 14) * 6;
          goalHeadTilt += Math.sin(tSec * 7) * 4;
          goalArmL += Math.sin(tSec * 14) * 10;
          goalArmR -= Math.sin(tSec * 14) * 10;
          break;
        case "shiver":
          goalHeadTilt += Math.sin(tSec * 20) * (draggingRef.current ? 4.5 : 2.2);
          goalBodyY += Math.sin(tSec * 16) * 3;
          // 拖起悬空时：手忙脚乱挥臂 + 小脚丫可爱乱蹬！
          if (draggingRef.current) {
            goalArmL = 70 + Math.sin(tSec * 18) * 16;
            goalArmR = -70 - Math.sin(tSec * 18) * 16;
            goalLegL = 18 + Math.sin(tSec * 16) * 18;
            goalLegR = -18 + Math.sin(tSec * 16) * 18;
          }
          break;
        case "sway":
          goalTorsoTilt += Math.sin(tSec * 2.0) * 3;
          goalHeadTilt += Math.sin(tSec * 2.0 - 0.4) * 4;
          goalArmL += Math.sin(tSec * 2.0) * 6;
          goalArmR -= Math.sin(tSec * 2.0) * 6;
          break;
        case "curious-lean":
          goalBodyY += Math.sin(tSec * 2.6) * 3;
          goalHeadTilt += Math.sin(tSec * 1.5) * 2.5;
          goalArmR += Math.sin(tSec * 2.6) * 5;
          break;
        case "bored-play":
          goalTorsoTilt += Math.sin(tSec * 1.6) * 3.5;
          goalArmR = -28 + Math.sin(tSec * 2.4) * 14; // 伸手轻戳泡泡
          goalLegL += Math.sin(tSec * 2.2) * 8;
          goalLegR -= Math.sin(tSec * 2.2) * 8;
          break;
        case "sleep-pillow":
          // 躺在云朵枕头上轻柔呼吸起伏
          goalBodyY += Math.sin(tSec * 1.5) * 4.5;
          goalScaleY *= 1 + Math.sin(tSec * 1.5) * 0.012;
          goalArmL += Math.sin(tSec * 1.5) * 3;
          break;
        case "talk":
          goalBodyY += Math.sin(tSec * 7.5) * 3;
          goalHeadTilt += Math.sin(tSec * 3.8) * 3.2;
          goalArmL += Math.sin(tSec * 6.5) * 12;
          goalArmR -= Math.cos(tSec * 6.5) * 12;
          break;
        case "none":
        default:
          break;
      }

      // 2. 摸头三段式交互编排（进入 → 保持 → 回落）
      let gazeLerpRate = 10;
      let headLerpRate = 8.5;

      if (pattingRef.current && patStartMsRef.current !== null) {
        const elapsed = (now - patStartMsRef.current) / 1000;
        const mood = patMoodRef.current;

        if (elapsed < 0.2) {
          const p = elapsed / 0.2;
          goalUpperLid = Math.sin(p * Math.PI) * 0.96;
          goalClosedStyle = "arc-up";
          goalHeadY = 14 * Math.sin(p * Math.PI * 0.5);
          goalScaleY = 0.965;
          goalScaleX = 1.025;
          goalHeadTilt = -3;
          goalArmL = 24;
          goalArmR = -24;
          goalBlush = lerp(0.2, 0.45, p);
          goalMouth = "shy-smile";
          goalSymbol = mood === "shy" ? "shy-hearts" : "happy-stars";
          gazeLerpRate = 20;
          headLerpRate = 18;
        } else if (elapsed < 0.7) {
          const p = (elapsed - 0.2) / 0.5;
          if (p < 0.42) {
            goalGazeX = 0;
            goalGazeY = -9;
          } else {
            goalGazeX = mood === "shy" ? 13 : 0;
            goalGazeY = mood === "shy" ? 2 : -3;
          }
          goalUpperLid = mood === "happy" ? 0.12 : 0.14;
          goalClosedStyle = "arc-up";
          goalLowerLid = mood === "happy" ? 0.48 : 0.3;
          goalBlush = lerp(0.45, mood === "shy" ? 0.95 : 0.72, p);
          goalHeadTilt = lerp(-3, mood === "shy" ? -10 : -6, p);
          goalHeadY = mood === "happy" ? -4 : 6;
          goalBodyY = mood === "happy" ? -9 * p : 3;
          goalArmL = mood === "happy" ? 46 : 34;
          goalArmR = mood === "happy" ? -46 : -34;
          goalAhoge = Math.sin(elapsed * 22) * 18; // 开心/害羞摇呆毛！
          goalMouth = mood === "happy" ? "open-happy" : "shy-smile";
          goalSymbol = mood === "shy" ? "shy-hearts" : "happy-stars";
          goalBrowLY = -4;
          goalBrowRY = -4;
          goalBrowLTilt = -6;
          goalBrowRTilt = 6;
        } else {
          const holdSec = elapsed - 0.7;
          const peekCycle = holdSec % 2.4;
          const isPeekingBack = mood === "shy" && peekCycle > 1.75 && peekCycle < 2.25;

          goalGazeX = mood === "shy" ? (isPeekingBack ? 1 : 13) : 0;
          goalGazeY = isPeekingBack ? -4 : mood === "happy" ? -2 : 2;
          goalUpperLid = mood === "happy" ? 0.14 : 0.14;
          goalClosedStyle = "arc-up";
          goalLowerLid = mood === "happy" ? 0.5 : 0.3;
          goalBlush = mood === "shy" ? 0.95 : 0.72;
          goalHeadTilt = (mood === "shy" ? -10 : -6) + Math.sin(holdSec * 3.2) * 2.5;
          goalBodyY = (mood === "happy" ? -9 : 3) + Math.sin(holdSec * 4.0) * 3.5;
          goalArmL = (mood === "happy" ? 48 : 34) + Math.sin(holdSec * 4) * 6;
          goalArmR = (mood === "happy" ? -48 : -34) - Math.sin(holdSec * 4) * 6;
          goalAhoge = Math.sin(holdSec * 16) * 20;
          goalMouth = mood === "happy" ? "open-happy" : "shy-smile";
          goalSymbol = mood === "shy" ? "shy-hearts" : "happy-stars";
          goalBrowLY = -4;
          goalBrowRY = -4;
          goalBrowLTilt = -6;
          goalBrowRTilt = 6;
        }
      } else if (patReleaseMsRef.current !== null) {
        const rel = (now - patReleaseMsRef.current) / 1000;
        if (rel < 0.85) {
          gazeLerpRate = 14;
          headLerpRate = rel < 0.22 ? 2.5 : 6.5;
          goalBlush = lerp(0.8, base.blush, clamp(rel / 0.7, 0, 1));
        } else {
          patReleaseMsRef.current = null;
        }
      }

      // 2.4 靠显示器边缘躲藏探头探脑偷看 / 靠应用窗口左右边框倚靠 / 上下边框坐下晃脚
      const activeDock = dockPoseRef.current;
      if (
        activeDock !== "none" &&
        !draggingRef.current &&
        !pattingRef.current &&
        !castingMenuRef.current &&
        goalSleepLay < 0.5
      ) {
        const peekWave = Math.sin(tSec * 1.55); // 探出来看一眼 → 微微缩回的偷看节奏
        const scanWave = Math.sin(tSec * 0.95);
        switch (activeDock) {
          case "peek-left":
            goalTorsoTilt = 23 + peekWave * 4.5;
            goalHeadTilt = 19 + peekWave * 5.5;
            goalHeadY = -2 + Math.abs(peekWave) * 3;
            goalGazeX = 12 + scanWave * 2;
            goalGazeY = Math.sin(tSec * 1.25) * 4.5;
            goalBrowLY = -5;
            goalBrowRY = -6;
            goalBrowLTilt = -4;
            goalBrowRTilt = 5;
            goalBlush = 0.42;
            goalArmL = -24;
            goalArmR = -44 + peekWave * 7; // 扶着屏幕边沿探身偷看
            goalAhoge = 22 + Math.sin(tSec * 3.4) * 8;
            goalMouth = peekWave > 0.35 ? "small-o" : "shy-smile";
            break;
          case "peek-right":
            goalTorsoTilt = -23 - peekWave * 4.5;
            goalHeadTilt = -19 - peekWave * 5.5;
            goalHeadY = -2 + Math.abs(peekWave) * 3;
            goalGazeX = -12 - scanWave * 2;
            goalGazeY = Math.sin(tSec * 1.25) * 4.5;
            goalBrowLY = -6;
            goalBrowRY = -5;
            goalBrowLTilt = -5;
            goalBrowRTilt = 4;
            goalBlush = 0.42;
            goalArmR = 24;
            goalArmL = 44 - peekWave * 7;
            goalAhoge = -22 - Math.sin(tSec * 3.4) * 8;
            goalMouth = peekWave > 0.35 ? "small-o" : "shy-smile";
            break;
          case "peek-top":
            goalHeadY = 14 + peekWave * 4.5;
            goalHeadTilt = scanWave * 9;
            goalGazeY = 11;
            goalGazeX = scanWave * 10;
            goalBrowLY = -5;
            goalBrowRY = -5;
            goalBlush = 0.4;
            goalArmL = 58 + peekWave * 4;
            goalArmR = -58 - peekWave * 4;
            goalAhoge = 18 + Math.sin(tSec * 3.2) * 6;
            goalMouth = peekWave > 0.3 ? "small-o" : "shy-smile";
            break;
          case "lean-left":
            // 慵懒地斜靠在左侧边框上
            goalTorsoTilt = -11 + Math.sin(tSec * 1.5) * 1.2;
            goalHeadTilt = 7 + Math.sin(tSec * 1.1) * 2;
            goalArmL = 24;
            goalArmR = -10 + Math.sin(tSec * 1.8) * 5;
            goalLegL = 8;
            goalLegR = -5;
            goalAhoge = -8;
            break;
          case "lean-right":
            // 慵懒地斜靠在右侧边框上
            goalTorsoTilt = 11 - Math.sin(tSec * 1.5) * 1.2;
            goalHeadTilt = -7 - Math.sin(tSec * 1.1) * 2;
            goalArmR = -24;
            goalArmL = 10 - Math.sin(tSec * 1.8) * 5;
            goalLegR = -8;
            goalLegL = 5;
            goalAhoge = 8;
            break;
          case "sit-top":
          case "sit-bottom":
            // 乖巧坐在应用窗口上下边框上，小脚丫轻轻交替晃动
            goalBodyY = 26 + Math.sin(tSec * 2.2) * 2.5;
            goalScaleY = 0.94;
            goalScaleX = 1.04;
            goalTorsoTilt = Math.sin(tSec * 1.4) * 2.5;
            goalHeadTilt = Math.sin(tSec * 1.4 - 0.5) * 4;
            goalArmL = -16 + Math.sin(tSec * 2.2) * 3;
            goalArmR = 16 - Math.sin(tSec * 2.2) * 3;
            goalLegL = 28 + Math.sin(tSec * 2.8) * 12;
            goalLegR = -28 - Math.sin(tSec * 2.8) * 12;
            break;
          default:
            break;
        }
      }

      // 2.5 鼠标悬浮「双手张开撒向天空」展开环绕按钮施法动作
      if (castingMenuRef.current && !draggingRef.current && goalSleepLay < 0.5) {
        goalArmL = 74;
        goalArmR = -74;
        goalBodyY = -10;
        goalHeadY = -4;
        goalLowerLid = Math.max(goalLowerLid, 0.34);
        goalMouth = "open-happy";
        goalAhoge = 18;
      }

      // 2.6 鼠标在灵儿附近时的丝滑眼睛 + 头部追踪环绕效果（睡觉与摸头中不打断）
      const lt = lookTargetRef.current;
      if (lt && !pattingRef.current && !draggingRef.current && goalSleepLay < 0.5) {
        const lx = clamp(lt.x, -1, 1);
        const ly = clamp(lt.y, -1, 1);
        goalGazeX = clamp(goalGazeX + lx * 13, -15, 15);
        goalGazeY = clamp(goalGazeY + ly * 9, -11, 11);
        goalHeadTilt = clamp(goalHeadTilt + lx * 9.5, -18, 18);
        goalHeadY = clamp(goalHeadY + ly * 6, -10, 14);
        goalTorsoTilt = clamp(goalTorsoTilt + lx * 2.5, -8, 8);
      }

      // 3. 自然流畅单睫毛眨眼（先快闭后柔睁，160ms，绝无僵硬停顿）
      if (base.upperLid < 0.7 && !pattingRef.current) {
        if (blinkStartMsRef.current === null && now >= nextBlinkMsRef.current) {
          blinkStartMsRef.current = now;
        }
        if (blinkStartMsRef.current !== null) {
          const bElapsed = (now - blinkStartMsRef.current) / 1000;
          const bDur = 0.17;
          if (bElapsed < bDur) {
            // 非对称眨眼曲线：前 40% 快速闭合，后 60% 柔和睁开
            const p = bElapsed / bDur;
            const blinkAmt = p < 0.4 ? Math.sin((p / 0.4) * Math.PI * 0.5) : Math.cos(((p - 0.4) / 0.6) * Math.PI * 0.5);
            goalUpperLid = Math.max(goalUpperLid, blinkAmt * 0.98);
          } else {
            blinkStartMsRef.current = null;
            nextBlinkMsRef.current = now + 2600 + Math.random() * 2800;
          }
        }
      }

      // 4. 各骨骼平滑插值
      const kGaze = 1 - Math.exp(-gazeLerpRate * dt);
      const kFace = 1 - Math.exp(-12 * dt);
      const kHead = 1 - Math.exp(-headLerpRate * dt);
      const kLimb = 1 - Math.exp(-9.5 * dt);

      const nextHeadTilt = lerp(cur.headTiltDeg, goalHeadTilt, kHead);
      const nextBodyY = lerp(cur.bodyY, goalBodyY, kHead);
      const totalHeadTilt = nextHeadTilt + cur.torsoTiltDeg;

      // 5. 水晶花坠 & 呆毛独立二阶阻尼弹簧（比头部晚半拍晃动）
      const headVel = (totalHeadTilt - prevHeadTiltRef.current) / dt;
      const bodyVelY = (nextBodyY - prevBodyYRef.current) / dt;
      prevHeadTiltRef.current = totalHeadTilt;
      prevBodyYRef.current = nextBodyY;

      const targetPend = clamp(-totalHeadTilt * 1.1 - headVel * 0.15 - bodyVelY * 0.08, -26, 26);
      const pendAccel = (targetPend - pendAngleRef.current) * 38 - pendVelRef.current * 4.2;
      pendVelRef.current += pendAccel * dt;
      pendAngleRef.current = clamp(pendAngleRef.current + pendVelRef.current * dt, -30, 30);

      const targetAhoge = clamp(goalAhoge - headVel * 0.12 - bodyVelY * 0.06, -32, 32);
      const ahogeAccel = (targetAhoge - ahogeAngleRef.current) * 52 - ahogeVelRef.current * 5.2;
      ahogeVelRef.current += ahogeAccel * dt;
      ahogeAngleRef.current = clamp(ahogeAngleRef.current + ahogeVelRef.current * dt, -34, 34);

      const nextMouthOpen =
        goalMouth === "speaking"
          ? 0.25 + 0.75 * Math.abs(Math.sin(tSec * 12.5) * Math.cos(tSec * 5.2))
          : 0.45;

      const nextState: LiveRigState = {
        gazeX: lerp(cur.gazeX, goalGazeX, kGaze),
        gazeY: lerp(cur.gazeY, goalGazeY, kGaze),
        irisScale: lerp(cur.irisScale, goalIrisScale, kFace),
        upperLid: lerp(cur.upperLid, goalUpperLid, 1 - Math.exp(-24 * dt)),
        upperLidTilt: lerp(cur.upperLidTilt, goalUpperLidTilt, kFace),
        closedEyeStyle: goalClosedStyle,
        lowerLid: lerp(cur.lowerLid, goalLowerLid, kFace),
        browLY: lerp(cur.browLY, goalBrowLY, kFace),
        browLTilt: lerp(cur.browLTilt, goalBrowLTilt, kFace),
        browRY: lerp(cur.browRY, goalBrowRY, kFace),
        browRTilt: lerp(cur.browRTilt, goalBrowRTilt, kFace),
        blush: lerp(cur.blush, goalBlush, 1 - Math.exp(-6.5 * dt)),
        tear: lerp(cur.tear, goalTear, 1 - Math.exp(-6.5 * dt)),
        headTiltDeg: nextHeadTilt,
        headY: lerp(cur.headY, goalHeadY, kHead),
        torsoTiltDeg: lerp(cur.torsoTiltDeg, goalTorsoTilt, kHead),
        bodyY: nextBodyY,
        bodyScaleX: lerp(cur.bodyScaleX, goalScaleX, kHead),
        bodyScaleY: lerp(cur.bodyScaleY, goalScaleY, kHead),
        armLDeg: lerp(cur.armLDeg, goalArmL, kLimb),
        armRDeg: lerp(cur.armRDeg, goalArmR, kLimb),
        legLDeg: lerp(cur.legLDeg, goalLegL, kLimb),
        legRDeg: lerp(cur.legRDeg, goalLegR, kLimb),
        ahogeDeg: ahogeAngleRef.current,
        pendantDeg: pendAngleRef.current,
        sleepLay: lerp(cur.sleepLay, goalSleepLay, 1 - Math.exp(-4.5 * dt)),
        mouth: goalMouth,
        mouthOpen: nextMouthOpen,
        symbol: goalSymbol,
        animTime: tSec,
      };

      stateRef.current = nextState;
      setRig(nextState);
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [shouldAnimate]);

  const svgHeight = size;
  const svgWidth = Math.round(size * (516 / 878));
  const showSleepProps = !cleanMode && rig.sleepLay > 0.06;

  // 侧躺睡觉时的平滑过渡变换（居中完整入画，头枕在云朵枕头上）
  const layRot = rig.sleepLay * -54;
  const layShiftX = rig.sleepLay * 22;
  const layShiftY = rig.sleepLay * 116;
  const layScale = 1 - rig.sleepLay * 0.2;

  return (
    <div
      className="relative flex items-center justify-center select-none"
      style={{ width: size, height: size }}
    >
      {!cleanMode && effectiveEmotion === "listening" && (
        <>
          <span className="absolute inset-4 rounded-full border-2 border-sky-400/65 animate-pet-pulse-ring" />
          <span
            className="absolute inset-6 rounded-full border-2 border-blue-300/55 animate-pet-pulse-ring"
            style={{ animationDelay: "0.6s" }}
          />
        </>
      )}

      <svg
        ref={svgRef}
        viewBox="0 0 516 878"
        width={svgWidth}
        height={svgHeight}
        className="overflow-visible drop-shadow-[0_8px_14px_rgba(37,99,235,0.22)]"
        aria-label={`灵儿当前表情：${effectiveEmotion}`}
      >
        <defs>
          <clipPath id={`eyeClipL-${uid}`}>
            <ellipse cx="192" cy="327" rx="39" ry="35" />
          </clipPath>
          <clipPath id={`eyeClipR-${uid}`}>
            <ellipse cx="338" cy="324" rx="39" ry="35" />
          </clipPath>

          <linearGradient id={`mouthGrad-${uid}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#DC8E8D" />
            <stop offset="55%" stopColor="#ECA4A4" />
            <stop offset="100%" stopColor="#F6BCBC" />
          </linearGradient>

          <radialGradient id={`blushGrad-${uid}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#FB7185" stopOpacity="0.62" />
            <stop offset="58%" stopColor="#FDA4AF" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#FDA4AF" stopOpacity="0" />
          </radialGradient>

          <linearGradient id={`tearGrad-${uid}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#E0F2FE" stopOpacity="0.25" />
            <stop offset="55%" stopColor="#BAE6FD" stopOpacity="0.82" />
            <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0.95" />
          </linearGradient>

          <linearGradient id={`lidSkin-${uid}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#EFE0DF" />
            <stop offset="72%" stopColor="#F4E5E4" />
            <stop offset="100%" stopColor="#E9D7D8" />
          </linearGradient>

          <radialGradient id={`bubbleGrad-${uid}`} cx="35%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.88" />
            <stop offset="55%" stopColor="#BAE6FD" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#C4B5FD" stopOpacity="0.55" />
          </radialGradient>

          {/* 3D 立体质感白色蓬松云朵枕头渐变与柔和立体投影 */}
          <filter id={`pillowShadow-${uid}`} x="-18%" y="-18%" width="136%" height="142%">
            <feDropShadow dx="0" dy="14" stdDeviation="12" floodColor="#64748B" floodOpacity="0.24" />
            <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#94A3B8" floodOpacity="0.18" />
          </filter>

          <radialGradient id={`pillowGrad-${uid}`} cx="36%" cy="24%" r="76%">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="46%" stopColor="#FDFEFF" />
            <stop offset="76%" stopColor="#EEF4FB" />
            <stop offset="100%" stopColor="#D6E3F3" />
          </radialGradient>

          <radialGradient id={`pillowLobe-${uid}`} cx="34%" cy="26%" r="68%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.98" />
            <stop offset="62%" stopColor="#F4F8FD" stopOpacity="0.88" />
            <stop offset="100%" stopColor="#D7E4F4" stopOpacity="0.55" />
          </radialGradient>

          <linearGradient id={`pillowRim-${uid}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="55%" stopColor="#E2ECF7" />
            <stop offset="100%" stopColor="#C3D5EA" />
          </linearGradient>

          <linearGradient id={`pillowBowGrad-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#93C5FD" />
            <stop offset="50%" stopColor="#60A5FA" />
            <stop offset="100%" stopColor="#2563EB" />
          </linearGradient>

          <linearGradient id={`blanketGrad-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#93C5FD" />
            <stop offset="50%" stopColor="#60A5FA" />
            <stop offset="100%" stopColor="#3B82F6" />
          </linearGradient>
        </defs>

        {/* === 睡觉场景后景道具：3D 立体质感白色蓬松云朵枕头 === */}
        {showSleepProps && (
          <g opacity={rig.sleepLay.toFixed(2)} transform="translate(0, 14)">
            {/* 柔和漫反射底影 */}
            <ellipse cx="215" cy="760" rx="198" ry="26" fill="rgba(100, 116, 139, 0.16)" />
            <g filter={`url(#pillowShadow-${uid})`}>
              {/* 立体厚边背衬（模拟枕头厚度与柔和暗面） */}
              <path
                d="M 70 714 C 22 714 -2 668 14 624 C -2 576 36 528 86 536 C 106 484 176 472 216 506 C 260 478 326 500 338 552 C 384 562 402 618 372 662 C 384 704 344 736 296 728 C 254 748 178 750 138 728 C 112 736 86 728 70 714 Z"
                fill="#CFDDF0"
              />
              {/* 蓬松 3D 白色云朵枕头主体 */}
              <path
                d="M 70 704 C 22 704 -2 658 14 614 C -2 566 36 518 86 526 C 106 474 176 462 216 496 C 260 468 326 490 338 542 C 384 552 402 608 372 652 C 384 694 344 726 296 718 C 254 738 178 740 138 718 C 112 726 86 718 70 704 Z"
                fill={`url(#pillowGrad-${uid})`}
                stroke={`url(#pillowRim-${uid})`}
                strokeWidth="4.5"
                strokeLinejoin="round"
              />
              {/* 分瓣鼓起 3D 绒感体积光球（塑造棉花般饱满立体感） */}
              <ellipse cx="76" cy="596" rx="58" ry="52" fill={`url(#pillowLobe-${uid})`} />
              <ellipse cx="164" cy="534" rx="64" ry="54" fill={`url(#pillowLobe-${uid})`} />
              <ellipse cx="272" cy="548" rx="60" ry="52" fill={`url(#pillowLobe-${uid})`} />
              <ellipse cx="328" cy="614" rx="52" ry="48" fill={`url(#pillowLobe-${uid})`} />
              <ellipse cx="206" cy="632" rx="116" ry="64" fill={`url(#pillowLobe-${uid})`} />
              {/* 顶部柔光镜面高光弧（3D 丝绒漫反射高光） */}
              <path
                d="M 42 586 C 50 554 84 538 112 548 M 126 510 C 154 488 192 490 212 510 M 252 512 C 284 498 316 516 324 548"
                fill="none"
                stroke="#FFFFFF"
                strokeWidth="9"
                strokeLinecap="round"
                opacity="0.96"
              />
              {/* 底部柔软折痕与环境光遮蔽（AO） */}
              <path
                d="M 52 678 Q 112 710 174 698 Q 246 720 324 696"
                fill="none"
                stroke="#C5D5EA"
                strokeWidth="5"
                strokeLinecap="round"
                opacity="0.6"
              />
              {/* 精致枕边细滚边车缝线 */}
              <path
                d="M 74 696 C 32 694 12 654 24 616 C 12 574 44 530 90 536 C 110 488 174 476 212 506 C 254 482 316 502 328 548 C 370 558 386 608 360 648 C 370 686 336 714 292 708"
                fill="none"
                stroke="#FFFFFF"
                strokeWidth="2.4"
                strokeDasharray="6 6"
                opacity="0.78"
              />
            </g>
            {/* 云朵枕角 3D 缎带蓝蝴蝶结 */}
            <g transform="translate(48, 566) rotate(-20)">
              <path d="M 0 2 L -26 -14 L -19 16 Z" fill={`url(#pillowBowGrad-${uid})`} stroke="#FFFFFF" strokeWidth="2.2" />
              <path d="M 4 2 L 28 -14 L 21 16 Z" fill={`url(#pillowBowGrad-${uid})`} stroke="#FFFFFF" strokeWidth="2.2" />
              <ellipse cx="-11" cy="-2" rx="6" ry="2.6" fill="#E0F2FE" opacity="0.75" transform="rotate(-18 -11 -2)" />
              <ellipse cx="14" cy="-2" rx="6" ry="2.6" fill="#E0F2FE" opacity="0.75" transform="rotate(18 14 -2)" />
              <circle cx="2" cy="1" r="7" fill="#3B82F6" stroke="#FFFFFF" strokeWidth="1.8" />
              <circle cx="0" cy="-1" r="2.2" fill="#E0F2FE" opacity="0.9" />
            </g>
          </g>
        )}

        {/* === 全身父子骨骼树 Root === */}
        <g
          transform={`translate(258, 600) translate(${layShiftX.toFixed(1)}, ${layShiftY.toFixed(1)}) rotate(${layRot.toFixed(1)}) scale(${layScale.toFixed(3)}) translate(-258, -600)`}
        >
          <g
            transform={`translate(258, 860) translate(0, ${rig.bodyY.toFixed(2)}) rotate(${rig.torsoTiltDeg.toFixed(2)}) scale(${rig.bodyScaleX.toFixed(3)}, ${rig.bodyScaleY.toFixed(3)}) translate(-258, -860)`}
          >
            {/* 1. 左右腿骨骼（位于裙摆后方，支持跳跃/悬空乱蹬/蜷腿） */}
            <g transform={`rotate(${rig.legLDeg.toFixed(1)}, 208, 678)`}>
              <image href="./linger/leg_left.png" x="0" y="0" width="516" height="878" />
            </g>
            <g transform={`rotate(${rig.legRDeg.toFixed(1)}, 308, 678)`}>
              <image href="./linger/leg_right.png" x="0" y="0" width="516" height="878" />
            </g>

            {/* 2. 左右手臂骨骼（独立肩关节，支持欢呼举手/托腮/害羞捂脸/受惊扬臂） */}
            <g transform={`rotate(${rig.armLDeg.toFixed(1)}, 176, 502)`}>
              <image href="./linger/arm_left.png" x="0" y="0" width="516" height="878" />
            </g>
            <g transform={`rotate(${rig.armRDeg.toFixed(1)}, 340, 502)`}>
              <image href="./linger/arm_right.png" x="0" y="0" width="516" height="878" />
            </g>

            {/* 3. 躯干与完整百褶裙摆 */}
            <image href="./linger/torso.png" x="0" y="0" width="516" height="878" />

            {/* 4. 独立头部骨骼（以颈部 (258, 434) 为转轴，可自由歪头/低头/点头） */}
            <g
              transform={`translate(0, ${rig.headY.toFixed(1)}) rotate(${rig.headTiltDeg.toFixed(2)}, 258, 434)`}
            >
              {/* 4a. 独立情绪呆毛（二阶弹性晃动） */}
              <g transform={`rotate(${rig.ahogeDeg.toFixed(2)}, 240, 74)`}>
                <image href="./linger/ahoge.png" x="0" y="0" width="516" height="878" />
              </g>

              {/* 4b. 头部底图（已彻底清除原固定睫毛，告别双睫毛） */}
              <image href="./linger/head_rig.png" x="0" y="0" width="516" height="878" />

              {/* 4c. 左右自然单睫毛眼睛（锁死左深右浅晶体蓝虹膜） */}
              {renderNaturalEye({
                side: "L",
                cx: 192,
                cy: 326,
                irisHref: "./linger/iris_left.png",
                clipId: `eyeClipL-${uid}`,
                uid,
                gazeX: rig.gazeX,
                gazeY: rig.gazeY,
                irisScale: rig.irisScale,
                upperLid: rig.upperLid,
                upperLidTilt: rig.upperLidTilt,
                closedEyeStyle: rig.closedEyeStyle,
                lowerLid: rig.lowerLid,
                tear: rig.tear,
              })}
              {renderNaturalEye({
                side: "R",
                cx: 338,
                cy: 323,
                irisHref: "./linger/iris_right.png",
                clipId: `eyeClipR-${uid}`,
                uid,
                gazeX: rig.gazeX,
                gazeY: rig.gazeY,
                irisScale: rig.irisScale,
                upperLid: rig.upperLid,
                upperLidTilt: rig.upperLidTilt,
                closedEyeStyle: rig.closedEyeStyle,
                lowerLid: rig.lowerLid,
                tear: rig.tear,
              })}

              {/* 4d. 腮红与嘴部 */}
              {rig.blush > 0.05 && (
                <g opacity={rig.blush.toFixed(2)}>
                  <ellipse cx="176" cy="382" rx="34" ry="18" fill={`url(#blushGrad-${uid})`} />
                  <ellipse cx="352" cy="379" rx="34" ry="18" fill={`url(#blushGrad-${uid})`} />
                </g>
              )}
              {renderMouth(rig.mouth, rig.mouthOpen, uid)}

              {/* 4e. 前景半透明蓝白刘海层 */}
              <image href="./linger/bangs_overlay.png" x="0" y="0" width="516" height="878" />

              {/* 4f. 左右独立眉毛 */}
              <g transform={`translate(0, ${rig.browLY.toFixed(1)}) rotate(${rig.browLTilt.toFixed(1)}, 174, 257)`}>
                <path
                  d="M 150 262 Q 173 252 197 257"
                  fill="none"
                  stroke="#2C4496"
                  strokeWidth="6.2"
                  strokeLinecap="round"
                />
              </g>
              <g transform={`translate(0, ${rig.browRY.toFixed(1)}) rotate(${rig.browRTilt.toFixed(1)}, 346, 253)`}>
                <path
                  d="M 324 253 Q 348 248 370 258"
                  fill="none"
                  stroke="#2C4496"
                  strokeWidth="6.2"
                  strokeLinecap="round"
                />
              </g>

              {/* 4g. 物理水晶花坠（晚半拍跟随头部摇曳） */}
              <g transform={`rotate(${rig.pendantDeg.toFixed(2)}, 451, 234)`}>
                <image href="./linger/crystal_pendant.png" x="430" y="232" width="50" height="90" />
              </g>
            </g>
          </g>
        </g>

        {/* === 睡觉场景前景道具：星月绒绒小毛毯（盖在灵儿肚子与小腿上） === */}
        {showSleepProps && (
          <g opacity={rig.sleepLay.toFixed(2)} transform={`translate(0, ${(Math.sin(rig.animTime * 1.5) * 3.5).toFixed(1)})`}>
            <path
              d="M 225 568 Q 340 538 452 574 Q 486 645 462 738 Q 350 774 218 746 Q 192 652 225 568 Z"
              fill={`url(#blanketGrad-${uid})`}
              stroke="#E0F2FE"
              strokeWidth="6"
            />
            {/* 白色蓬松蕾丝被边 */}
            <path
              d="M 225 568 Q 204 654 218 746"
              fill="none"
              stroke="#FFFFFF"
              strokeWidth="12"
              strokeLinecap="round"
              strokeDasharray="12 12"
            />
            {/* 毛毯上的小星星点缀 */}
            <path d="M 328 632 L 333 644 L 345 649 L 333 654 L 328 666 L 323 654 L 311 649 L 323 644 Z" fill="#FEF08A" />
            <path d="M 402 668 L 405 676 L 413 679 L 405 682 L 402 690 L 399 682 L 391 679 L 399 676 Z" fill="#FFFFFF" opacity="0.9" />
            <circle cx="366" cy="612" r="5" fill="#E0F2FE" />
            <circle cx="288" cy="702" r="6" fill="#E0F2FE" />
          </g>
        )}

        {/* === 靠显示器边缘探头探脑偷看时的可爱星辉好奇点缀 === */}
        {!cleanMode &&
          (dockPose === "peek-left" ||
            dockPose === "peek-right" ||
            dockPose === "peek-top") && (
            <g className="pointer-events-none">
              <g
                transform={`translate(${
                  dockPose === "peek-left"
                    ? "438"
                    : dockPose === "peek-right"
                      ? "78"
                      : "426"
                }, ${(148 + Math.sin(rig.animTime * 3.1) * 7).toFixed(1)}) scale(${(
                  0.92 +
                  Math.sin(rig.animTime * 4.2) * 0.1
                ).toFixed(2)})`}
              >
                <path
                  d="M 0 -18 L 4.5 -4.5 L 18 0 L 4.5 4.5 L 0 18 L -4.5 4.5 L -18 0 L -4.5 -4.5 Z"
                  fill="#60A5FA"
                  stroke="#FFFFFF"
                  strokeWidth="2.4"
                />
                <circle cx="22" cy="-16" r="4.5" fill="#BAE6FD" />
              </g>
            </g>
          )}

        {/* === 特色动态表情符号层 === */}
        {!cleanMode && renderEmotionSymbols(rig.symbol, rig.animTime, uid)}
      </svg>

      {!cleanMode && dndEnabled && (
        <span
          title="免打扰模式已开启"
          className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded-full bg-slate-800/85 text-sky-100 text-[10px] font-medium shadow"
        >
          静音
        </span>
      )}
    </div>
  );
}
