/**
 * 通用开关原语（Switch）
 * 统一替代 ScheduleCard / WakewordCard 等多处重复定义的开关组件。
 */

interface SwitchProps {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export default function Switch({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onChange}
      className={`w-9 h-5 rounded-full p-0.5 transition-colors flex items-center cursor-pointer disabled:opacity-40 shrink-0 ${
        checked
          ? "bg-emerald-500 justify-end"
          : "bg-[var(--border-strong)] justify-start"
      }`}
    >
      <span className="w-4 h-4 rounded-full bg-white shadow-xs" />
    </button>
  );
}
