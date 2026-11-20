/**
 * 统一轻量 Toast Hook（带防重叠计时器覆盖与卸载清理，彻底杜绝过早消失与内存泄漏）
 */

import { useCallback, useEffect, useRef, useState } from "react";

export function useToast(defaultDurationMs = 2600) {
  const [toast, setToast] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const showToast = useCallback(
    (msg: string, durationMs = defaultDurationMs) => {
      setToast(msg);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setToast(null);
      }, durationMs);
    },
    [defaultDurationMs],
  );

  const clearToast = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setToast(null);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  return { toast, showToast, clearToast };
}
