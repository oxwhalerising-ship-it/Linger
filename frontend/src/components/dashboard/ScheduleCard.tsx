/**
 * ChatGPT Desktop 风格：全天作息定时管家与「随机冒泡」配置面板（ScheduleCard）
 * ---------------------------------------------------------------------------
 * 1. 免打扰总开关（实时同步后端与桌宠浮窗）。
 * 2. 自定义 4 个作息节点（早安规划 / 午间提醒 / 晚间复盘 / 睡前催睡）时间与开关。
 * 3. 自定义「随机冒泡」活跃时间段与每日触发次数（1~3 次）。
 * 4. 每个节点均支持「模拟触发」，即时测试桌宠探头语音与气泡。
 */

import { useCallback, useEffect, useState } from "react";
import {
  api,
  type ScheduleConfig,
  type ScheduleEventType,
  type ScheduleStatusData,
} from "../../services/api";

const FIXED_NODES: Array<{
  key: "morning_plan" | "noon_checkin" | "evening_review" | "bedtime_nudge";
  label: string;
  desc: string;
}> = [
  { key: "morning_plan", label: "早安规划", desc: "开启元气一天，确认今日小习惯" },
  { key: "noon_checkin", label: "午间提醒", desc: "提醒吃饱饱、喝温水与起身伸懒腰" },
  { key: "evening_review", label: "晚间复盘", desc: "核对未记录的习惯清单与收集小确幸" },
  { key: "bedtime_nudge", label: "睡前催睡", desc: "温柔提醒放下手机、早点休息" },
];

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

export default function ScheduleCard({
  onToast,
}: {
  onToast: (msg: string) => void;
}) {
  const [status, setStatus] = useState<ScheduleStatusData | null>(null);
  const [schedule, setSchedule] = useState<ScheduleConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [triggering, setTriggering] = useState<ScheduleEventType | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const data = await api.getScheduleStatus();
      setStatus(data);
      setSchedule(data.schedule);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleToggleDnd = async () => {
    if (!schedule) return;
    const next = !schedule.dnd_enabled;
    try {
      await api.toggleDnd(next);
      setSchedule({ ...schedule, dnd_enabled: next });
      await loadStatus();
      onToast(next ? "已开启免打扰模式（静音）" : "已关闭免打扰模式");
    } catch {
      onToast("切换免打扰失败");
    }
  };

  const handleSaveSchedule = async () => {
    if (!schedule) return;
    setSaving(true);
    try {
      await api.updateSettings({ schedule });
      await loadStatus();
      onToast("作息时间与随机冒泡已保存并热重载");
    } catch {
      onToast("保存作息设置失败");
    } finally {
      setSaving(false);
    }
  };

  const handleSimulateTrigger = async (eventType: ScheduleEventType) => {
    setTriggering(eventType);
    try {
      const res = await api.triggerScheduleEvent(eventType);
      onToast(
        res.delivered_clients && res.delivered_clients > 0
          ? "已推送给桌宠浮窗！快看看右下角的灵儿吧～"
          : "已触发事件（若桌宠浮窗已打开将会弹出气泡）",
      );
    } catch {
      onToast("模拟触发失败，请确认后端 8765 端口在线");
    } finally {
      setTriggering(null);
    }
  };

  if (!schedule) {
    return (
      <div className="py-8 text-center text-[13px] text-[var(--text-tertiary)]">
        正在加载作息调度状态...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 顶部标题与操作栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[var(--border-subtle)]">
        <div>
          <h3 className="text-[16px] font-semibold text-[var(--text-primary)]">
            全天作息与主动陪伴
          </h3>
          <p className="text-[12.5px] text-[var(--text-tertiary)] mt-0.5">
            {status?.running
              ? `调度引擎运行中 · 在线窗口 ${status.connected_clients} 个`
              : "调度引擎未启动"}
          </p>
        </div>

        <button
          type="button"
          disabled={saving}
          onClick={() => void handleSaveSchedule()}
          className="h-8 px-4 rounded-full bg-[var(--ink-primary)] hover:bg-[var(--ink-primary-hover)] disabled:opacity-40 text-[var(--ink-primary-fg)] text-[12.5px] font-medium transition-colors cursor-pointer"
        >
          {saving ? "应用中..." : "保存作息"}
        </button>
      </div>

      {/* 免打扰行 */}
      <div className="flex items-center justify-between gap-4 py-1">
        <div>
          <div className="text-[14px] font-medium text-[var(--text-primary)]">
            免打扰模式
          </div>
          <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5">
            开启后暂停一切主动语音与冒泡提醒，保持安静专注
          </div>
        </div>
        <Switch
          checked={schedule.dnd_enabled}
          onChange={() => void handleToggleDnd()}
        />
      </div>

      {/* 4 个固定作息节点 */}
      <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] divide-y divide-[var(--border-subtle)]">
        {FIXED_NODES.map(({ key, label, desc }) => {
          const node = schedule[key];
          return (
            <div
              key={key}
              className="px-4 py-3.5 flex flex-wrap items-center justify-between gap-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Switch
                  checked={node.enabled}
                  onChange={() =>
                    setSchedule({
                      ...schedule,
                      [key]: { ...node, enabled: !node.enabled },
                    })
                  }
                />
                <div className="min-w-0">
                  <div className="text-[13.5px] font-medium text-[var(--text-primary)]">
                    {label}
                  </div>
                  <div className="text-[11.5px] text-[var(--text-tertiary)]">
                    {desc}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="time"
                  value={node.time}
                  onChange={(e) =>
                    setSchedule({
                      ...schedule,
                      [key]: { ...node, time: e.target.value },
                    })
                  }
                  className="h-8 px-2.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[12px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--border-strong)]"
                />
                <button
                  type="button"
                  disabled={triggering !== null}
                  onClick={() => void handleSimulateTrigger(key)}
                  className="h-8 px-3 rounded-lg bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                >
                  {triggering === key ? "推送中..." : "模拟触发"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* 随机冒泡配置 */}
      <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 space-y-3.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[13.5px] font-medium text-[var(--text-primary)]">
              活跃时段「随机冒泡」主动关心
            </div>
            <div className="text-[11.5px] text-[var(--text-tertiary)] mt-0.5">
              像好朋友一样，每天随机探头 1~3 次提醒喝水与打气
            </div>
          </div>
          <Switch
            checked={schedule.random_bubble.enabled}
            onChange={() =>
              setSchedule({
                ...schedule,
                random_bubble: {
                  ...schedule.random_bubble,
                  enabled: !schedule.random_bubble.enabled,
                },
              })
            }
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--border-subtle)]">
          <input
            type="time"
            value={schedule.random_bubble.start_time}
            onChange={(e) =>
              setSchedule({
                ...schedule,
                random_bubble: {
                  ...schedule.random_bubble,
                  start_time: e.target.value,
                },
              })
            }
            className="h-8 px-2.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[12px] font-mono text-[var(--text-primary)] outline-none"
          />
          <span className="text-[12px] text-[var(--text-tertiary)]">至</span>
          <input
            type="time"
            value={schedule.random_bubble.end_time}
            onChange={(e) =>
              setSchedule({
                ...schedule,
                random_bubble: {
                  ...schedule.random_bubble,
                  end_time: e.target.value,
                },
              })
            }
            className="h-8 px-2.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[12px] font-mono text-[var(--text-primary)] outline-none"
          />
          <select
            value={schedule.random_bubble.daily_count}
            onChange={(e) =>
              setSchedule({
                ...schedule,
                random_bubble: {
                  ...schedule.random_bubble,
                  daily_count: Number(e.target.value),
                },
              })
            }
            className="h-8 px-2.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[12px] text-[var(--text-primary)] outline-none"
          >
            <option value={1}>每天 1 次</option>
            <option value={2}>每天 2 次</option>
            <option value={3}>每天 3 次</option>
          </select>
          <button
            type="button"
            disabled={triggering !== null}
            onClick={() => void handleSimulateTrigger("random_bubble")}
            className="h-8 px-3 rounded-lg bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer ml-auto"
          >
            {triggering === "random_bubble" ? "冒泡中..." : "测试随机冒泡"}
          </button>
        </div>
      </div>

      {/* 下次触发排期一览 */}
      {status?.jobs?.length ? (
        <div className="space-y-2">
          <div className="text-[12px] font-medium text-[var(--text-tertiary)]">
            下次排期预览
          </div>
          <div className="flex flex-wrap gap-1.5">
            {status.jobs.map((job) => (
              <span
                key={job.id}
                className="text-[11.5px] px-2.5 py-1 rounded-full bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[var(--text-secondary)] tabular-nums"
              >
                {job.name} ·{" "}
                {job.next_run_time ? job.next_run_time.slice(11, 16) : "--:--"}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
