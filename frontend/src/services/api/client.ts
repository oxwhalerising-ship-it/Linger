/**
 * 统一后端 HTTP / WebSocket 传输客户端
 * -----------------------------------
 * 集中管理：
 * 1. 后端 Base URL 与 WebSocket URL 解析
 * 2. 请求超时控制（默认 30s，避免后端卡死拖垮界面）
 * 3. FastAPI JSON `detail` 错误统一提取与 204 No Content 兼容
 */

const DEFAULT_BACKEND_URL = "http://127.0.0.1:8765";
const DEFAULT_TIMEOUT_MS = 30_000;

export function getBackendBaseUrl(): string {
  return (window.taiwanBotEnv?.backendBaseUrl ?? DEFAULT_BACKEND_URL).replace(
    /\/+$/,
    "",
  );
}

export function getWebSocketUrl(path: string): string {
  const wsBase = getBackendBaseUrl().replace(/^http/, "ws");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${wsBase}${normalizedPath}`;
}

export async function parseFastApiError(res: Response): Promise<string> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body?.detail) {
      detail =
        typeof body.detail === "string"
          ? body.detail
          : JSON.stringify(body.detail);
    }
  } catch {
    // ignore non-JSON error body
  }
  return detail;
}

function createTimeoutSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal | null,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = window.setTimeout(() => {
    controller.abort(new DOMException("请求超时", "TimeoutError"));
  }, timeoutMs);

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      window.clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

export async function requestJson<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const { signal, cleanup } = createTimeoutSignal(timeoutMs, init?.signal);
  try {
    const hasBody = init?.body !== undefined && init?.body !== null;
    const isFormData = hasBody && init?.body instanceof FormData;
    const headers: Record<string, string> = {};
    if (hasBody && !isFormData) {
      headers["Content-Type"] = "application/json";
    }
    if (init?.headers) {
      Object.assign(headers, init.headers as Record<string, string>);
    }

    const res = await fetch(`${getBackendBaseUrl()}${path}`, {
      ...init,
      headers,
      signal,
    });
    if (!res.ok) {
      throw new Error(await parseFastApiError(res));
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  } finally {
    cleanup();
  }
}
