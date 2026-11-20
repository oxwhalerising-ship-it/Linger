/**
 * Windows 外部应用窗口探测与单句柄轻量追踪模块
 * ---------------------------------------------
 * 职责：
 * 1. 拖拽结束时按需枚举当前可见顶层应用窗口矩形（物理像素 -> Electron DIPs）。
 * 2. 吸附到外部应用窗口时启动单 HWND 追踪器，移动时回调最新 DIP 矩形，关闭/最小化时回调 onGone。
 * 3. 严格校验 hwnd 安全整数，绑定 proc.on("error") 防止 spawn 异常导致主进程崩溃。
 */
const { execFile, spawn } = require("child_process");

function createWin32WindowTracker({ screen, getPetWindow }) {
  let trackProc = null;

  function stop() {
    if (trackProc) {
      try {
        trackProc.kill();
      } catch {
        // ignore kill error
      }
      trackProc = null;
    }
  }

  function start(hwnd, { onMove, onGone }) {
    stop();
    if (process.platform !== "win32" || !Number.isSafeInteger(hwnd) || hwnd <= 0) {
      return;
    }

    const psTracker = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class SingleHwndTracker {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
  public static string Poll(long h) {
    IntPtr hWnd = new IntPtr(h);
    if (!IsWindow(hWnd) || !IsWindowVisible(hWnd) || IsIconic(hWnd)) return "GONE";
    RECT r;
    if (DwmGetWindowAttribute(hWnd, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) {
      if (!GetWindowRect(hWnd, out r)) return "GONE";
    }
    int w = r.Right - r.Left;
    int hgt = r.Bottom - r.Top;
    if (w < 80 || hgt < 60) return "GONE";
    return r.Left + "," + r.Top + "," + w + "," + hgt;
  }
}
"@
$last = ""
while ($true) {
  $res = [SingleHwndTracker]::Poll(${hwnd})
  if ($res -eq "GONE") {
    [Console]::Out.WriteLine("GONE")
    [Console]::Out.Flush()
    break
  }
  if ($res -ne $last) {
    $last = $res
    [Console]::Out.WriteLine("MOVE:" + $res)
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 30
}
`;

    try {
      const proc = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psTracker],
        { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      trackProc = proc;

      proc.on("error", () => {
        if (trackProc === proc) {
          trackProc = null;
        }
      });

      let buf = "";
      proc.stdout.on("data", (chunk) => {
        if (trackProc !== proc) return;
        buf += chunk.toString("utf8");
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          if (line === "GONE") {
            onGone?.(hwnd);
            return;
          }
          if (line.startsWith("MOVE:")) {
            const petWindow = getPetWindow();
            if (!petWindow || petWindow.isDestroyed()) continue;
            const parts = line.slice(5).split(",").map(Number);
            if (parts.length === 4 && parts.every(Number.isFinite)) {
              try {
                const dip = screen.screenToDipRect(petWindow, {
                  x: parts[0],
                  y: parts[1],
                  width: parts[2],
                  height: parts[3],
                });
                onMove?.(hwnd, dip);
              } catch {
                // ignore conversion error
              }
            }
          }
        }
      });

      proc.on("exit", () => {
        if (trackProc === proc) {
          trackProc = null;
        }
      });
    } catch {
      trackProc = null;
    }
  }

  function queryVisibleAppWindowRects() {
    return new Promise((resolve) => {
      const petWindow = getPetWindow();
      if (process.platform !== "win32" || !petWindow || petWindow.isDestroyed()) {
        resolve([]);
        return;
      }

      const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnumHelper {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
  public static string ListRects(uint skipPid) {
    var list = new List<string>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      if (pid == skipPid) return true;
      int cloaked = 0;
      DwmGetWindowAttribute(hWnd, 14, out cloaked, Marshal.SizeOf(typeof(int)));
      if (cloaked != 0) return true;
      var cls = new StringBuilder(64);
      GetClassName(hWnd, cls, cls.Capacity);
      string c = cls.ToString();
      if (c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd" || c == "Progman" || c == "WorkerW" || c == "Windows.UI.Core.CoreWindow") return true;
      RECT r;
      if (DwmGetWindowAttribute(hWnd, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) {
        if (!GetWindowRect(hWnd, out r)) return true;
      }
      int w = r.Right - r.Left;
      int h = r.Bottom - r.Top;
      if (w < 160 || h < 120) return true;
      list.Add(hWnd.ToInt64() + "," + r.Left + "," + r.Top + "," + w + "," + h);
      return true;
    }, IntPtr.Zero);
    return string.Join(";", list);
  }
}
"@
[WinEnumHelper]::ListRects(${process.pid})
`;

      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psScript],
        { timeout: 1800, windowsHide: true },
        (err, stdout) => {
          const currentPet = getPetWindow();
          if (err || !stdout || !currentPet || currentPet.isDestroyed()) {
            resolve([]);
            return;
          }
          const raw = stdout.trim();
          if (!raw) {
            resolve([]);
            return;
          }
          const rects = [];
          for (const token of raw.split(";")) {
            const parts = token.split(",").map(Number);
            if (parts.length === 5 && parts.every(Number.isFinite)) {
              try {
                const dip = screen.screenToDipRect(currentPet, {
                  x: parts[1],
                  y: parts[2],
                  width: parts[3],
                  height: parts[4],
                });
                if (dip.width >= 140 && dip.height >= 100) {
                  rects.push({ hwnd: parts[0], ...dip });
                }
              } catch {
                // ignore conversion errors
              }
            }
          }
          resolve(rects);
        },
      );
    });
  }

  return { start, stop, queryVisibleAppWindowRects };
}

module.exports = { createWin32WindowTracker };
