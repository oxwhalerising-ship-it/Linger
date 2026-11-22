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
      className={`relative w-[42px] h-[26px] rounded-full cursor-pointer disabled:opacity-40 shrink-0 transition-colors duration-200 ${
        checked ? "bg-[var(--apple-green,#34c759)]" : "bg-[rgba(120,120,128,0.28)]"
      }`}
    >
      <span
        className={`absolute top-[2px] left-[2px] w-[22px] h-[22px] rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.22)] transition-transform duration-200 ease-out ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}
