/**
 * 窗口几何的纯判据：默认尺寸与越界回收。
 *
 * 副屏拔掉、显示器排列变化、上次坐标落在屏幕外时，Electron 自己不会把窗口收回来；
 * 症状看起来像"双击没反应"。这里只做纯计算，真实屏幕由 main 传 workArea。
 *
 * 最小尺寸 600×480：P1-5 真机发现 960 宽会让 Windows 无法把窗口贴成半屏
 * （1539px 屏在 125% 下只有约 1231 DIP，半屏 615 DIP < 960）。600 留出半屏余量，
 * 同时覆盖 800×600 的窄屏验收；更窄的布局由面板响应式与 P2-4 回归兜住。
 */

export const MIN_WIDTH = 600;
export const MIN_HEIGHT = 480;
export const DEFAULT_WIDTH = 1360;
export const DEFAULT_HEIGHT = 860;

function boxOf(v) {
  if (!v || typeof v !== 'object') return null;
  const x = Number(v.x);
  const y = Number(v.y);
  const width = Number(v.width);
  const height = Number(v.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function displaysOf(displays) {
  return (Array.isArray(displays) ? displays : [])
    .map((d) => boxOf(d && d.workArea ? d.workArea : d))
    .filter(Boolean);
}

function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** 状态文件的值域收敛；坏值返回 null（启动时按默认尺寸开，不因记忆坏了打不开窗口）。 */
export function normalizeWindowState(raw) {
  const b = boxOf(raw);
  if (!b) return null;
  return { ...b, maximized: raw.maximized === true, v: 1 };
}

/**
 * 显示器变化后的回收决策。纯函数，displays 由调用方保证"主屏在首位"。
 *
 * 最大化的窗口用 getNormalBounds() 的原位置判断它原来在哪块屏：原屏还在就
 * 不动（DPI 变化也由 Electron 自己按 DIP 处理）；原屏没了才先还原、再钳到主屏。
 * 非最大化窗口只要还与任一屏相交就只做边缘钳制，不相交则回主屏居中。
 */
export function reflowForDisplays({
  bounds, normalBounds, maximized = false, displays,
} = {}) {
  const list = displaysOf(displays);
  const primary = list[0] || { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  const current = boxOf(bounds);
  const normal = boxOf(normalBounds);
  const live = current || normal;
  if (!live) {
    return { unmaximize: false, remaximize: false, bounds: defaultBounds(primary) };
  }
  const normalHit = normal ? list.find((a) => intersects(normal, a)) : null;
  if (maximized) {
    if (normalHit) return { unmaximize: false, remaximize: false, bounds: live };
    return {
      unmaximize: true,
      remaximize: true,
      bounds: clampBounds(normal || current || primary, list),
    };
  }
  const hit = list.find((a) => intersects(live, a));
  if (hit) return { unmaximize: false, remaximize: false, bounds: clampBounds(live, list) };
  return {
    unmaximize: false,
    remaximize: false,
    bounds: clampBounds(normal || current || primary, list),
  };
}

export function defaultBounds(workArea) {
  const a = boxOf(workArea) || { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  const width = Math.min(DEFAULT_WIDTH, a.width);
  const height = Math.min(DEFAULT_HEIGHT, a.height);
  return {
    x: Math.round(a.x + (a.width - width) / 2),
    y: Math.round(a.y + (a.height - height) / 2),
    width,
    height,
  };
}

export function clampBounds(bounds, displays) {
  const list = displaysOf(displays);
  const primary = list[0] || { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  const b = boxOf(bounds);
  let width = Math.min(Math.max(MIN_WIDTH, b ? b.width : DEFAULT_WIDTH), primary.width);
  let height = Math.min(Math.max(MIN_HEIGHT, b ? b.height : DEFAULT_HEIGHT), primary.height);
  let x = b ? b.x : primary.x + (primary.width - width) / 2;
  let y = b ? b.y : primary.y + (primary.height - height) / 2;

  const hit = list.find((a) => x < a.x + a.width && x + width > a.x && y < a.y + a.height && y + height > a.y);
  if (!hit) {
    x = primary.x + (primary.width - width) / 2;
    y = primary.y + (primary.height - height) / 2;
  } else {
    width = Math.min(width, hit.width);
    height = Math.min(height, hit.height);
    x = Math.max(hit.x, Math.min(x, hit.x + hit.width - width));
    y = Math.max(hit.y, Math.min(y, hit.y + hit.height - height));
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
