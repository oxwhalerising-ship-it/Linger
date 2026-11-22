/**
 * 主控面板 `/ws/events` 双向事件与 UI 指令客户端
 * ----------------------------------------------
 * 1. 连接后端 `/ws/events` 并声明 `client: "dashboard"` 身份。
 * 2. 接收 `ui_command`（如番茄钟控制 `focus_control`、切页 `navigate`），调用本地处理器并立刻回发 `ui_command_ack`。
 * 3. 接收 `data_changed`（当灵儿通过工具或后台归档修改了日记/任务/习惯/记忆时），
 *    派发全局浏览器事件 `linger-data-changed` 与 `linger-plan`，让已打开的面板即时无刷新同步。
 */

import { openAuthedWebSocket } from "./api/client";

export interface UiCommandAck {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

export type UiCommandHandler = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<UiCommandAck> | UiCommandAck;

export function connectDashboardEvents(options: {
  onUiCommand: UiCommandHandler;
}): () => void {
  let disposed = false;
  let ws: WebSocket | null = null;
  let pingTimer: number | null = null;
  let reconnectTimer: number | null = null;
  let attempt = 0;

  const clearTimers = () => {
    if (pingTimer !== null) {
      window.clearInterval(pingTimer);
      pingTimer = null;
    }
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (disposed) return;
    attempt += 1;
    const delay = Math.min(8000, 1000 + attempt * 800);
    reconnectTimer = window.setTimeout(() => {
      if (!disposed) void open();
    }, delay);
  };

  const open = async () => {
    clearTimers();
    if (disposed) return;
    let socket: WebSocket;
    try {
      socket = await openAuthedWebSocket("/ws/events");
    } catch {
      scheduleReconnect();
      return;
    }
    if (disposed) {
      socket.close();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      attempt = 0;
      try {
        socket.send(JSON.stringify({ type: "hello", client: "dashboard" }));
      } catch {
        // ignore
      }
      pingTimer = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send("ping");
        }
      }, 25_000);
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = String(msg.type || "");

      if (type === "ui_command") {
        const commandId = String(msg.command_id || "");
        const action = String(msg.action || "");
        const payload =
          msg.payload && typeof msg.payload === "object"
            ? (msg.payload as Record<string, unknown>)
            : {};

        void Promise.resolve(options.onUiCommand(action, payload))
          .then((ack) => {
            if (commandId && socket.readyState === WebSocket.OPEN) {
              socket.send(
                JSON.stringify({
                  type: "ui_command_ack",
                  command_id: commandId,
                  ok: Boolean(ack.ok),
                  result: ack.result ?? {},
                  error: ack.error ?? "",
                }),
              );
            }
          })
          .catch((err) => {
            if (commandId && socket.readyState === WebSocket.OPEN) {
              socket.send(
                JSON.stringify({
                  type: "ui_command_ack",
                  command_id: commandId,
                  ok: false,
                  result: {},
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
            }
          });
        return;
      }

      if (type === "data_changed") {
        const domains = Array.isArray(msg.domains)
          ? msg.domains.map((d) => String(d))
          : [];
        window.dispatchEvent(
          new CustomEvent("linger-data-changed", {
            detail: { domains, source: String(msg.source || "") },
          }),
        );
        if (
          domains.some((d) => d === "tasks" || d === "habits" || d === "focus" || d === "today")
        ) {
          window.dispatchEvent(new Event("linger-plan"));
        }
      }
    };

    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        // ignore
      }
    };

    socket.onclose = () => {
      if (ws === socket) ws = null;
      clearTimers();
      scheduleReconnect();
    };
  };

  void open();

  return () => {
    disposed = true;
    clearTimers();
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  };
}
