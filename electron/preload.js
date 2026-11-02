const { contextBridge, ipcRenderer } = require('electron');

const shell = Object.freeze({
  isShell: true,
  platform: process.platform,
  notify: (payload) => ipcRenderer.invoke('shell:notify', payload),
  retry: () => ipcRenderer.invoke('shell:retry'),
  quit: () => ipcRenderer.invoke('shell:quit'),
  isWindowVisible: () => ipcRenderer.invoke('shell:visible'),
  // P3-2：只收这两条敏感操作。其余写路由仍走 HTTP，浏览器入口不退化。
  restartPanel: () => ipcRenderer.invoke('shell:restart-panel'),
  quitConsole: () => ipcRenderer.invoke('shell:quit-console'),
  panelState: () => ipcRenderer.invoke('shell:panel-state'),
  // 打开方式：立即在系统浏览器打开 / 显示或收起桌面窗口。
  openInBrowser: () => ipcRenderer.invoke('shell:open-in-browser'),
  showWindow: () => ipcRenderer.invoke('shell:show-window'),
  hideWindow: () => ipcRenderer.invoke('shell:hide-window'),
});

contextBridge.exposeInMainWorld('estrellaShell', shell);

function markShell() {
  if (document.documentElement) document.documentElement.dataset.shell = 'electron';
}
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', markShell, { once: true });
else markShell();
