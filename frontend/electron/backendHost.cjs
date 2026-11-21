/**
 * 启动本机灵儿后端。
 * 开发时如果 8765 已经有服务（start_linger.bat），就不再另起一个。
 * 打包后把后端源码放在 resources/linger-backend，数据放在用户目录。
 */

const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = 8765;
let backendChild = null;
let logFd = null;
let stopping = false;
let currentStatus = { state: "starting", detail: "正在等本地大脑…" };

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function resolveDataDir() {
  if (app.isPackaged) {
    return path.join(app.getPath("userData"), "data");
  }
  return path.join(repoRoot(), "data");
}

function resolveBackendDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "linger-backend");
  }
  return path.join(repoRoot(), "backend");
}

function publish(status) {
  currentStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("backend:status", status);
    }
  }
}

function getBackendStatus() {
  return currentStatus;
}

function probeBackend() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/api/health",
        method: "GET",
        timeout: 1500,
      },
      (res) => {
        res.resume();
        resolve("up");
      },
    );
    req.on("error", () => resolve("down"));
    req.on("timeout", () => {
      req.destroy();
      resolve("down");
    });
    req.end();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBackend(attempts) {
  for (let i = 0; i < attempts; i += 1) {
    if (stopping) return "down";
    if ((await probeBackend()) === "up") return "up";
    await delay(500);
  }
  return "down";
}

function readTokenFile() {
  try {
    return fs.readFileSync(path.join(resolveDataDir(), "linger.token"), "utf8").trim();
  } catch {
    return "";
  }
}

async function readAuthToken() {
  for (let i = 0; i < 40; i += 1) {
    const token = readTokenFile();
    if (token) return token;
    await delay(250);
  }
  return "";
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...options,
    });
    let stderr = "";
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} 退出码 ${code}`));
    });
  });
}

function systemPython() {
  const local = process.env.LOCALAPPDATA || "";
  for (const version of ["Python313", "Python312", "Python311"]) {
    const exe = path.join(local, "Programs", "Python", version, "python.exe");
    if (fs.existsSync(exe)) return { command: exe, prefix: [] };
  }
  return { command: "py", prefix: ["-3"] };
}

async function ensurePackagedPython(backendDir) {
  const bundled = path.join(process.resourcesPath, "python", "python.exe");
  if (fs.existsSync(bundled)) return bundled;
  const venvPython = path.join(app.getPath("userData"), "venv", "Scripts", "python.exe");
  if (fs.existsSync(venvPython)) return venvPython;
  const system = systemPython();
  publish({ state: "installing", detail: "第一次打开，正在安装本地大脑依赖…" });
  const venvDir = path.join(app.getPath("userData"), "venv");
  await runProcess(system.command, [...system.prefix, "-m", "venv", venvDir]);
  await runProcess(venvPython, [
    "-m",
    "pip",
    "install",
    "-r",
    path.join(backendDir, "requirements.txt"),
  ]);
  return venvPython;
}

function resolveDevPython(backendDir) {
  const venvPython = path.join(backendDir, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(venvPython)) return venvPython;
  return "";
}

function openBackendLog() {
  const logDir = path.join(resolveDataDir(), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  return fs.createWriteStream(path.join(logDir, "backend.log"), { flags: "a" });
}

function spawnBackend(python, backendDir) {
  const logStream = openBackendLog();
  logFd = logStream;
  const child = spawn(
    python,
    [
      "-m",
      "uvicorn",
      "app.main:app",
      "--app-dir",
      backendDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(PORT),
    ],
    {
      cwd: backendDir,
      env: {
        ...process.env,
        LINGER_DATA_DIR: resolveDataDir(),
      },
      windowsHide: true,
      stdio: ["ignore", logStream, logStream],
    },
  );
  backendChild = child;
  child.on("exit", (code) => {
    if (backendChild !== child) return;
    backendChild = null;
    if (!stopping) {
      publish({
        state: "down",
        detail: `本地大脑退出了（代码 ${code ?? "unknown"}）。日志在 data/logs/backend.log`,
      });
    }
  });
}

async function startBackendHost() {
  stopping = false;
  publish({ state: "starting", detail: "正在等本地大脑…" });
  const already = await waitForBackend(20);
  if (already === "up") {
    const token = await readAuthToken();
    if (!token) {
      publish({
        state: "down",
        detail: "8765 已被占用，但没有灵儿令牌。请关掉旧后端后再启动。",
      });
      return;
    }
    publish({ state: "ready", detail: "本地大脑在线" });
    return;
  }

  const backendDir = resolveBackendDir();
  try {
    const python = app.isPackaged
      ? await ensurePackagedPython(backendDir)
      : resolveDevPython(backendDir);
    if (!python) {
      publish({
        state: "down",
        detail: "找不到 backend\\.venv。请先安装依赖后再双击 start_linger.bat。",
      });
      return;
    }
    fs.mkdirSync(resolveDataDir(), { recursive: true });
    spawnBackend(python, backendDir);
    const up = await waitForBackend(40);
    if (up !== "up") {
      publish({
        state: "down",
        detail: "本地大脑没有在 8765 端口起来。日志在 data/logs/backend.log",
      });
      return;
    }
    publish({ state: "ready", detail: "本地大脑在线" });
  } catch (err) {
    publish({
      state: "down",
      detail: err instanceof Error ? err.message : "本地大脑启动失败",
    });
  }
}

function stopBackendHost() {
  stopping = true;
  const child = backendChild;
  backendChild = null;
  if (child && !child.killed) {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill();
    }
  }
  if (logFd && typeof logFd.end === "function") {
    logFd.end();
    logFd = null;
  }
}

module.exports = {
  startBackendHost,
  stopBackendHost,
  getBackendStatus,
  readAuthToken,
};
