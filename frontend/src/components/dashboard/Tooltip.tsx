/**
 * 全站统一黑色圆角悬浮提示组件（Tooltip）
 * ---------------------------------------
 * 1. 使用 React Portal 直接挂载到 document.body（z-[9999]），确保永远位于最顶层不被任何容器遮挡。
 * 2. 自动检测窗口左右边界，靠近右/左边缘时智能对齐，绝不出现文字被窗口裁切一半的问题。
 */

import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  label: string;
  side?: "top" | "bottom" | "left" | "right";
  disabled?: boolean;
  children: ReactNode;
}

interface TipStyle {
  top?: number;
  left?: number;
  right?: number;
  transform: string;
}

export default function Tooltip({
  label,
  side = "bottom",
  disabled = false,
  children,
}: TooltipProps) {
  const [tipStyle, setTipStyle] = useState<TipStyle | null>(null);

  const handleEnter = (e: React.MouseEvent<HTMLSpanElement>) => {
    if (disabled || !label) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const vw = window.innerWidth;

    if (side === "top" || side === "bottom") {
      const y = side === "top" ? rect.top - 8 : rect.bottom + 8;
      const translateY = side === "top" ? "-100%" : "0%";
      const centerX = rect.left + rect.width / 2;

      // 靠近右边缘时改为右对齐，防止气泡超出窗口右侧被裁切
      if (centerX > vw - 110) {
        setTipStyle({
          top: y,
          right: Math.max(10, vw - rect.right),
          transform: `translateY(${translateY})`,
        });
      } else if (centerX < 110) {
        setTipStyle({
          top: y,
          left: Math.max(10, rect.left),
          transform: `translateY(${translateY})`,
        });
      } else {
        setTipStyle({
          top: y,
          left: centerX,
          transform: `translate(-50%, ${translateY})`,
        });
      }
      return;
    }

    if (side === "left") {
      setTipStyle({
        top: rect.top + rect.height / 2,
        left: rect.left - 8,
        transform: "translate(-100%, -50%)",
      });
    } else {
      setTipStyle({
        top: rect.top + rect.height / 2,
        left: rect.right + 8,
        transform: "translate(0%, -50%)",
      });
    }
  };

  const handleLeave = () => setTipStyle(null);

  return (
    <span
      className="inline-flex items-center"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onMouseDown={handleLeave}
    >
      {children}
      {tipStyle &&
        !disabled &&
        createPortal(
          <span
            style={{
              top: tipStyle.top !== undefined ? `${tipStyle.top}px` : undefined,
              left:
                tipStyle.left !== undefined ? `${tipStyle.left}px` : undefined,
              right:
                tipStyle.right !== undefined
                  ? `${tipStyle.right}px`
                  : undefined,
              transform: tipStyle.transform,
            }}
            className="fixed z-[9999] px-2.5 py-1.5 rounded-lg bg-[#141414] text-white text-[12px] font-medium tracking-tight shadow-[0_8px_24px_rgba(0,0,0,0.28)] border border-white/10 pointer-events-none whitespace-nowrap"
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}
