/**
 * ChatGPT Desktop 风格：纯本地离线语音唤醒与开机自启面板（WakewordCard）
 * ---------------------------------------------------------------------
 * 1. 隐私承诺：未命中唤醒词前音频 100% 仅在本地内存流式推理，零联网、零落盘。
 * 2. 支持自定义中文唤醒词（默认「灵儿」）、开启/关闭离线监听与「模拟唤醒测试」。
 * 3. 在 Electron 桌面端提供「Windows 开机自动启动」开关。
 */

import { useCallback, useEffect, useState } from "react";
import { api, type WakewordStatusData } from "../../services/api";

function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
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

export default function WakewordCard({
  onToast,
}: {
  onToast: (msg: string) => void;
}) {
  const [status, setStatus] = useState<WakewordStatusData | null>(null);
  const [keyword, setKeyword] = useState("灵儿");
  const [autoStart, setAutoStart] = useState(false);
  const [busy, setBusy] = useState(false);

  const isElectron = Boolean(window.taiwanBotEnv);

  const loadStatus = useCallback(async () => {
    try {
      const data = await api.getWakewordStatus();
      setStatus(data);
      setKeyword(data.keyword || "灵儿");
    } catch {
      // ignore
    }
    if (window.taiwanBotEnv?.getAutoStart) {
      try {
        setAutoStart(await window.taiwanBotEnv.getAutoStart());
      } catch {
        // ignore
      }
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleToggleWakeword = async (nextEnabled: boolean) => {
    setBusy(true);
    try {
      const updated = await api.toggleWakeword(
        nextEnabled,
        keyword.trim() || "灵儿",
      );
      setStatus(updated);
      if (nextEnabled && !updated.ready) {
        onToast("唤醒词已保存，完善本地 KWS 依赖与模型后即可开启纯离线监听");
      } else if (nextEnabled && !updated.listening) {
        onToast(
          updated.last_error
            ? `唤醒监听启动失败：${updated.last_error}`
            : "唤醒词已保存，但麦克风监听未能启动",
        );
      } else {
        onToast(
          nextEnabled
            ? `已开启纯本地离线唤醒（唤醒词：「${updated.keyword}」）`
            : "已关闭离线语音唤醒监听",
        );
      }
    } catch {
      onToast("更新语音唤醒设置失败");
    } finally {
      setBusy(false);
    }
  };

  const handleSimulateWakeup = async () => {
    setBusy(true);
    try {
      const res = await api.simulateWakeword();
      onToast(
        res.delivered_clients > 0
          ? "已模拟命中唤醒词！桌宠已自动点亮并进入倾听态～"
          : "已触发模拟唤醒事件（打开桌宠浮窗即可看到实时响应）",
      );
      await loadStatus();
    } catch {
      onToast("模拟唤醒失败");
    } finally {
      setBusy(false);
    }
  };

  const handleToggleAutoStart = async () => {
    if (!window.taiwanBotEnv?.setAutoStart) return;
    const next = !autoStart;
    const actual = await window.taiwanBotEnv.setAutoStart(next);
    setAutoStart(actual);
    onToast(actual ? "已开启 Windows 开机自启" : "已关闭开机自启");
  };

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-[16px] font-semibold text-[var(--text-primary)]">
              离线语音唤醒与启动
            </h3>
            <span className="text-[11px] px-2.5 py-0.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-medium">
              未唤醒零联网 · 零落盘
            </span>
          </div>
          <p className="text-[12.5px] text-[var(--text-tertiary)] mt-0.5">
            基于本地 sherpa-onnx KWS 关键词检测，喊一声唤醒词即可 1 秒内唤醒灵儿
          </p>
        </div>
      </div>

      {/* 离线唤醒开关行 */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[14px] font-medium text-[var(--text-primary)]">
            {status?.listening ? "离线监听中" : "启用纯本地离线唤醒"}
          </div>
          <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5">
            仅在本地内存中持续检测唤醒词，未命中前不会上传或保存任何音频
          </div>
        </div>
        <Switch
          checked={Boolean(status?.enabled)}
          disabled={busy}
          onChange={() => void handleToggleWakeword(!status?.enabled)}
        />
      </div>

      {/* 自定义中文唤醒词 */}
      <div className="space-y-2 pt-4 border-t border-[var(--border-subtle)]">
        <label className="text-[12.5px] font-medium text-[var(--text-secondary)] block">
          自定义中文唤醒词
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="例如：灵儿"
            className="flex-1 min-w-[180px] h-9 px-3 rounded-xl bg-[var(--bg-subtle)] border border-transparent focus:border-[var(--border-strong)] focus:bg-[var(--bg-canvas)] text-[13px] text-[var(--text-primary)] outline-none transition-colors"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleToggleWakeword(Boolean(status?.enabled))}
            className="h-9 px-4 rounded-xl bg-[var(--ink-primary)] hover:bg-[var(--ink-primary-hover)] disabled:opacity-40 text-[var(--ink-primary-fg)] text-[12.5px] font-medium transition-colors cursor-pointer"
          >
            保存唤醒词
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleSimulateWakeup()}
            className="h-9 px-4 rounded-xl bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[12.5px] font-medium text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            模拟唤醒桌宠
          </button>
        </div>
      </div>

      {/* 离线 KWS 模型就绪状态说明 */}
      {status && (
        <div className="p-4 rounded-xl bg-[var(--bg-subtle)]/70 border border-[var(--border-subtle)] text-[12px] space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="font-medium text-[var(--text-primary)]">
              sherpa-onnx 本地唤醒引擎状态
            </span>
            <span
              className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${
                status.listening
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                  : status.ready
                    ? "bg-sky-500/12 text-sky-700 dark:text-sky-300"
                    : "bg-amber-500/12 text-amber-700 dark:text-amber-300"
              }`}
            >
              {status.listening
                ? "麦克风离线监听中"
                : status.ready
                  ? "模型已就绪（未开启）"
                  : "待安装依赖或模型"}
            </span>
          </div>
          {status.last_triggered_at && (
            <p className="text-[11.5px] text-[var(--text-tertiary)]">
              最近一次唤醒时间：{status.last_triggered_at}
            </p>
          )}
          {status.last_error && (
            <p className="text-[11.5px] text-rose-600 dark:text-rose-400 break-all">
              异常信息：{status.last_error}
            </p>
          )}
          {status.setup_hints?.map((hint) => (
            <p
              key={hint}
              className="text-[11.5px] text-[var(--text-tertiary)] font-mono break-all"
            >
              • {hint}
            </p>
          ))}
        </div>
      )}

      {/* Electron 桌面端：开机自启开关 */}
      {isElectron && (
        <div className="pt-4 border-t border-[var(--border-subtle)] flex items-center justify-between gap-4">
          <div>
            <div className="text-[14px] font-medium text-[var(--text-primary)]">
              开机自动启动灵儿
            </div>
            <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5">
              登录 Windows 桌面后自动静默常驻在右下角陪伴你
            </div>
          </div>
          <Switch
            checked={autoStart}
            onChange={() => void handleToggleAutoStart()}
          />
        </div>
      )}
    </div>
  );
}
