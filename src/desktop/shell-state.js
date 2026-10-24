/**
 * 托盘与窗口生命周期的纯决策。
 *
 * 托盘不可用时不能 hide：那会造出"既没有托盘入口、也没有窗口"的幽灵进程。
 * 这时关闭按钮退化为最小化到任务栏；任务栏图标本身就是入口。
 */

export function trayUsable(bounds, {
  degraded = false, createFailed = false, notificationAreaDisabled = false,
} = {}) {
  if (degraded || createFailed || notificationAreaDisabled) return false;
  if (!bounds || typeof bounds !== 'object') return false;
  return Number(bounds.width) > 0 && Number(bounds.height) > 0;
}

/**
 * preference:'tray' 是默认值；'quit' 是用户在设置里明确选的退出。
 * 托盘不可用只影响 tray 态（退化为最小化），不影响 quit。
 */
export function decideCloseAction({
  quitting = false, trayUsable: usable = false, preference = 'tray',
} = {}) {
  if (quitting) return 'close';
  if (preference === 'quit') return 'quit';
  return usable ? 'hide' : 'minimize';
}

export function decideStartVisibility({ hidden = false, trayUsable: usable = false } = {}) {
  return hidden && usable ? 'hidden' : 'show';
}
