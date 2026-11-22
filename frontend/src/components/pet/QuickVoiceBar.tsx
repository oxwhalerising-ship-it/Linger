/**
 * 桌宠快捷互动条（QuickVoiceBar）
 * ------------------------------
 * 点击桌宠下方浮现的小巧输入框，支持直接和台湾腔小管家快速聊一句，
 * 无需每次都打开大面板，同时提供“打开主控面板”一键入口。
 */

import { useState, type FormEvent } from "react";
import { IconPhone } from "../dashboard/AppleIcons";

interface QuickVoiceBarProps {
  visible: boolean;
  sending: boolean;
  onSend: (text: string) => void;
  onStartCall: () => void;
  onOpenDashboard: () => void;
  onClose: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export default function QuickVoiceBar({
  visible,
  sending,
  onSend,
  onStartCall,
  onOpenDashboard,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: QuickVoiceBarProps) {
  const [input, setInput] = useState("");

  if (!visible) return null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || sending) return;
    onSend(trimmed);
    setInput("");
  };

  return (
    <form
      onSubmit={handleSubmit}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="apple-sheet w-[276px] rounded-[22px] p-2 flex items-center gap-1.5 animate-bubble-pop"
    >
      <button
        type="button"
        onClick={onStartCall}
        title="直接跟灵儿实时语音打电话"
        className="apple-btn apple-btn-fill w-7 h-7 rounded-full flex items-center justify-center cursor-pointer shrink-0"
      >
        <IconPhone className="w-3.5 h-3.5" />
      </button>
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="说句话，或点左侧打电话"
        autoFocus
        className="flex-1 min-w-0 apple-well px-2.5 py-1.5 text-[13px] tracking-[-0.01em] text-[#1d1d1f] placeholder:text-[rgba(60,60,67,0.45)] outline-none focus:bg-white focus:shadow-[0_0_0_3px_rgba(0,113,227,0.28)]"
      />
      <button
        type="submit"
        disabled={sending || !input.trim()}
        className="apple-btn apple-btn-fill px-2.5 py-1.5 text-[12px] disabled:opacity-40 cursor-pointer shrink-0"
      >
        {sending ? "..." : "发送"}
      </button>
      <button
        type="button"
        onClick={onOpenDashboard}
        title="打开主控面板"
        className="apple-btn apple-btn-plain px-2 py-1.5 text-[12px] cursor-pointer shrink-0"
      >
        面板
      </button>
      <button
        type="button"
        onClick={onClose}
        title="收起输入框"
        className="px-1 py-1 text-slate-400 hover:text-slate-600 text-xs cursor-pointer shrink-0"
      >
        ×
      </button>
    </form>
  );
}
