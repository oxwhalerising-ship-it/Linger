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
      className="w-[276px] rounded-2xl bg-white/94 backdrop-blur-md border border-sky-200/90 shadow-[0_8px_22px_rgba(37,99,235,0.16)] p-2 flex items-center gap-1.5 animate-bubble-pop"
    >
      <button
        type="button"
        onClick={onStartCall}
        title="直接跟灵儿实时语音打电话"
        className="w-7 h-7 rounded-xl bg-gradient-to-br from-blue-600 to-sky-500 hover:from-blue-700 hover:to-sky-600 text-white flex items-center justify-center shadow-[0_2px_8px_rgba(37,99,235,0.28)] transition active:scale-95 cursor-pointer shrink-0"
      >
        <IconPhone className="w-3.5 h-3.5" />
      </button>
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="说句话，或点左侧打电话"
        autoFocus
        className="flex-1 min-w-0 bg-sky-50/75 rounded-xl px-2.5 py-1.5 text-xs text-slate-700 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-sky-300"
      />
      <button
        type="submit"
        disabled={sending || !input.trim()}
        className="px-2.5 py-1.5 rounded-xl bg-gradient-to-r from-blue-600 to-sky-500 hover:from-blue-700 hover:to-sky-600 disabled:opacity-45 text-white text-xs font-medium transition cursor-pointer shrink-0"
      >
        {sending ? "..." : "发送"}
      </button>
      <button
        type="button"
        onClick={onOpenDashboard}
        title="打开主控面板"
        className="px-2 py-1.5 rounded-xl bg-sky-50 hover:bg-sky-100 text-sky-700 text-xs transition cursor-pointer shrink-0"
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
