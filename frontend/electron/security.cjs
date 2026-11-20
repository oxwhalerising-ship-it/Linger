/**
 * Electron 渲染窗口安全防护（阻止未授权外链导航与弹窗，外部链接安全交由系统浏览器打开）
 */
const { shell } = require("electron");

function isAllowedInternalUrl(url) {
  if (!url) return false;
  return (
    url.startsWith("http://127.0.0.1:5173") ||
    url.startsWith("http://localhost:5173") ||
    url.startsWith("file://")
  );
}

function attachWindowSecurityGuards(win) {
  if (!win || win.isDestroyed()) return;

  // 拦截渲染层内的页面跳转，仅允许本地 Vite / file:// 页面
  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedInternalUrl(targetUrl)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(targetUrl)) {
        void shell.openExternal(targetUrl);
      }
    }
  });

  // 禁止 window.open 弹出新 Electron 窗口，外部 http(s) 链接改为系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
}

module.exports = {
  attachWindowSecurityGuards,
};
