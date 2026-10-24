/**
 * 左下角设置层（2026-10-23 · P2）。
 *
 * 只做四件事：外观（localStorage）、启动/关闭（config.json）、关于（只读）、
 * 数据（复用现有导出动作）。业务状态仍由 app.js 的 S 管理；本模块只渲染与提交，
 * 不另存一份偏好。
 */

const ACCENT_LABELS = {
  ocean: '海蓝', lagoon: '青碧', pine: '松绿', amber: '琥珀',
  coral: '珊瑚', berry: '莓红', violet: '紫罗兰',
};
const FONT_LABELS = { sans: '无衬线', serif: '衬线' };

const $ = (id) => document.getElementById(id);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function initSettings(deps) {
  const layer = $('settingsLayer');
  if (!layer) return;

  const panel = $('settingsPanel');
  const scroll = $('settingsScroll');
  const gear = $('setGear');
  const backdrop = $('settingsBackdrop');
  const closeBtn = $('settingsClose');
  const railItems = $$('.set-rail-item');
  const sections = $$('.set-section', scroll);
  let isOpen = false;
  let lastFocus = null;
  let railLockUntil = 0;
  let bgTries = 0;

  const stateOf = () => (deps.getState() && deps.getState().state) || {};
  const launchOf = () => {
    const s = stateOf();
    return (s.config && s.config.launch) || {};
  };
  const themeNow = () => document.documentElement.dataset.theme || 'light';
  const accentNow = () => document.documentElement.dataset.accent || 'ocean';
  const fontNow = () => document.documentElement.dataset.fontStyle || 'sans';

  /* ── 外观：主题色网格 ─────────────────────────────────────────────── */
  const accentIds = (window.__accentBoot && Array.isArray(window.__accentBoot.values))
    ? window.__accentBoot.values.slice()
    : Object.keys(ACCENT_LABELS);
  const accentGrid = $('accentGrid');
  if (accentGrid) {
    accentGrid.innerHTML = accentIds.map((id) => {
      const label = ACCENT_LABELS[id] || id;
      return `<button class="set-acc" type="button" data-accent-opt="${esc(id)}" aria-pressed="false" aria-label="主题色：${esc(label)}">`
        + `<span class="set-acc-dot"><svg aria-hidden="true"><use href="#si-check"/></svg></span>`
        + `<span>${esc(label)}</span></button>`;
    }).join('');
    accentGrid.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-accent-opt]');
      if (!btn) return;
      deps.setAccent(btn.dataset.accentOpt);
      paintAccents();
      paintChip();
    });
  }

  /* ── 外观：主题/字体 ──────────────────────────────────────────────── */
  const themeSeg = $('setThemeSeg');
  if (themeSeg) {
    themeSeg.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-theme-opt]');
      if (!btn) return;
      await deps.applyTheme(btn.dataset.themeOpt, btn);
      paintTheme();
      paintChip();
    });
  }
  const fontGrid = $('fontGrid');
  if (fontGrid) {
    fontGrid.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-font-opt]');
      if (!btn) return;
      deps.setFontStyle(btn.dataset.fontOpt);
      paintFont();
    });
  }

  /* ── 外观：背景 + 速度（数据源仍是 shader-bg.js）──────────────────── */
  function paintSpeed() {
    const box = $('bgSpeed');
    if (!box) return;
    const sb = window.ShaderBG;
    const speeds = (sb && sb.SPEEDS) || [];
    if (!speeds.length) { box.innerHTML = ''; return; }
    if (box.childElementCount !== speeds.length) {
      box.innerHTML = speeds.map((s) => `<button type="button" data-speed="${s.v}" aria-pressed="false">${esc(s.label)}</button>`).join('');
    }
    const cur = sb ? sb.speed : null;
    $$('[data-speed]', box).forEach((b) => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === Number(cur)));
    });
  }

  function paintBackground() {
    const sb = window.ShaderBG;
    if (!sb) return;
    const v = (sb.VARIANTS || []).find((x) => x.id === sb.current);
    const name = $('setBgName');
    if (name) name.textContent = v ? v.label : '—';
    paintSpeed();
  }

  function withShader(cb) {
    if (window.ShaderBG) { cb(); return; }
    if (bgTries >= 60) return;
    bgTries += 1;
    setTimeout(() => withShader(cb), 50);
  }
  withShader(paintBackground);

  const bgSpeed = $('bgSpeed');
  if (bgSpeed) {
    bgSpeed.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-speed]');
      if (!btn || !window.ShaderBG) return;
      window.ShaderBG.setSpeed(Number(btn.dataset.speed));
      paintSpeed();
      deps.toast(`背景速度：${btn.textContent}`, 'ok');
    });
  }
  const bgPickList = $('bgPickList');
  if (bgPickList) {
    bgPickList.addEventListener('click', () => setTimeout(paintBackground, 0));
  }

  /* ── 启动 / 关闭偏好 ──────────────────────────────────────────────── */
  function setSeg(id, attr, value) {
    $$(`#${id} [${attr}]`).forEach((b) => {
      b.setAttribute('aria-pressed', String(b.getAttribute(attr) === value));
    });
  }
  function setSwitch(id, on) {
    const b = $(id);
    if (b) b.setAttribute('aria-checked', String(!!on));
  }
  function isSwitchOn(id) {
    const b = $(id);
    return !!b && b.getAttribute('aria-checked') === 'true';
  }

  async function saveLaunch(patch, okMsg) {
    try {
      const r = await deps.post('/api/config', { launch: patch });
      deps.toast((r && r.msg) || okMsg, 'ok');
      await deps.refresh(true);
      paintLaunch();
    } catch (e) {
      deps.toast(`保存失败：${e.message}`, 'bad');
      paintLaunch();
    }
  }

  const lastLaunch = $('setLastLaunch');
  function paintLastLaunch(last) {
    if (!lastLaunch) return;
    if (!last || typeof last !== 'object') {
      lastLaunch.innerHTML = '<dt>记录</dt><dd>启动一次控制台后这里会出现</dd>';
      return;
    }
    const at = last.t ? new Date(last.t) : null;
    const time = at && !Number.isNaN(at.getTime()) ? at.toLocaleString('zh-CN', { hour12: false }) : '—';
    const how = last.used || last.kind || last.mode || '—';
    const result = last.skipped
      ? '按设置未打开界面'
      : (last.opened === false ? `打开失败（${last.error || '原因未知'}）` : '已打开');
    lastLaunch.innerHTML = [
      ['时间', time],
      ['入口', last.entryLabel || last.entry || '—'],
      ['形态', how],
      ['结果', result],
    ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  }

  function paintLaunch() {
    const l = launchOf();
    setSeg('setModeSeg', 'data-mode-opt', l.mode === 'window' ? 'window' : 'browser');
    setSeg('setCloseSeg', 'data-close-opt', l.closeAction === 'quit' ? 'quit' : 'tray');
    setSwitch('setOpenOnStart', l.openOnStart !== false);
    setSwitch('setAutoProtocol', l.autoProtocol !== false);

    const auto = String(l.autoStartState || 'unsupported');
    setSwitch('setAutostart', auto === 'on');
    const autoBtn = $('setAutostart');
    if (autoBtn) autoBtn.disabled = auto === 'unsupported';
    const autoHint = $('setAutostartHint');
    if (autoHint) {
      autoHint.textContent = auto === 'on' ? '已写入 Windows 启动项。'
        : auto === 'blocked' ? '任务管理器已禁用这个启动项；再开启会清除禁用状态。'
          : auto === 'off' ? '当前未开启；仅 Windows 安装版可用。'
            : '仅 Windows 安装版可用。';
    }
    const closeHint = $('setCloseHint');
    if (closeHint) {
      closeHint.textContent = l.closeAction === 'quit'
        ? '关闭窗口会走完整停止链：结束机器人与协议端，并核对没有残留进程。'
        : '程序继续在后台运行；托盘不可用时，关闭会自动最小化到任务栏。';
    }
    paintLastLaunch(l.last);
  }

  const modeSeg = $('setModeSeg');
  if (modeSeg) {
    modeSeg.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-mode-opt]');
      if (!btn) return;
      if (btn.getAttribute('aria-pressed') === 'true') return;
      saveLaunch({ mode: btn.dataset.modeOpt }, '已保存 —— 下次启动生效');
    });
  }
  const closeSeg = $('setCloseSeg');
  if (closeSeg) {
    closeSeg.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-close-opt]');
      if (!btn) return;
      if (btn.getAttribute('aria-pressed') === 'true') return;
      const quit = btn.dataset.closeOpt === 'quit';
      saveLaunch({ closeAction: quit ? 'quit' : 'tray' },
        quit ? '已保存 —— 关闭窗口将退出程序' : '已保存 —— 关闭窗口将驻留托盘');
    });
  }

  $$('[data-set]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const key = btn.dataset.set;
      const next = !isSwitchOn(btn.id);
      btn.setAttribute('aria-checked', String(next));
      if (key === 'autoStart') {
        saveLaunch({ autoStart: next }, next ? '已写入系统启动项' : '已移除系统启动项');
      } else if (key === 'autoProtocol') {
        saveLaunch({ autoProtocol: next }, '已保存 —— 下次启动生效');
      } else if (key === 'openOnStart') {
        saveLaunch({ openOnStart: next }, '已保存 —— 下次启动生效');
      }
    });
  });

  /* ── 关于 ─────────────────────────────────────────────────────────── */
  function stripRepo(url) {
    return String(url || '').replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '');
  }
  function setLink(id, href) {
    const a = $(id);
    if (!a) return;
    if (href) {
      a.href = href;
      a.removeAttribute('aria-disabled');
    } else {
      a.href = '#';
      a.setAttribute('aria-disabled', 'true');
    }
  }

  function paintAbout() {
    const s = stateOf();
    const meta = s.appMeta || {};
    const u = s.update || {};
    const version = meta.version || u.currentVersion || '—';
    const versionText = version === '—' ? '版本未知' : `v${version}`;
    if ($('aboutVersion')) $('aboutVersion').textContent = versionText;
    if ($('setRailVersion')) $('setRailVersion').textContent = versionText;
    const ua = navigator.userAgent || '';
    const em = ua.match(/Electron\/([\d.]+)/);
    if ($('aboutShell')) $('aboutShell').textContent = em ? `Electron ${em[1]}` : '浏览器模式';
    if ($('aboutBuild')) $('aboutBuild').textContent = em ? '桌面版' : '浏览器版';
    if ($('aboutRuntime')) {
      $('aboutRuntime').textContent = meta.runtime ? `Node ${meta.runtime}` : '—';
    }

    let last = '尚未检查';
    if (u.phase === 'checking') last = '检查中…';
    else if (u.phase === 'up_to_date') last = '已是最新';
    else if (u.phase === 'available') last = `发现 v${(u.latest && u.latest.version) || '?'}`;
    else if (u.phase === 'downloading') last = `正在下载${u.progress && u.progress.percent != null ? ` ${u.progress.percent}%` : ''}`;
    else if (u.phase === 'ready') last = `v${(u.latest && u.latest.version) || '?'} 已下载，待安装`;
    else if (u.phase === 'error') last = `检查失败：${u.error || '未知原因'}`;
    else if (u.checkedAt) last = `上次检查 ${new Date(u.checkedAt).toLocaleString('zh-CN', { hour12: false })}`;
    if ($('aboutUpdateState')) $('aboutUpdateState').textContent = last;

    const repo = String(meta.repo || '').trim();
    if ($('aboutRepoPath')) {
      $('aboutRepoPath').textContent = repo ? stripRepo(repo).replace('/', ' / ') : '未提供仓库地址';
    }
    setLink('repoOpen', repo);
    setLink('repoIssues', repo ? `${repo.replace(/\/$/, '')}/issues/new` : '');
    setLink('repoReleases', repo ? `${repo.replace(/\/$/, '')}/releases` : '');
    const copy = $('repoCopy');
    if (copy) copy.disabled = !repo;
  }

  const copyBtn = $('repoCopy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const repo = String((stateOf().appMeta || {}).repo || '').trim();
      if (!repo) return;
      try {
        await navigator.clipboard.writeText(repo);
        deps.toast('仓库地址已复制', 'ok');
      } catch {
        const ta = document.createElement('textarea');
        ta.value = repo;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { /* 老浏览器 */ }
        ta.remove();
        deps.toast(ok ? '仓库地址已复制' : '复制失败，请手动选择地址', ok ? 'ok' : 'warn');
      }
    });
  }

  const updateBtn = $('settingsPanel') && $('settingsPanel').querySelector('[data-a="update.check"]');
  if (updateBtn) setTimeout(() => updateBtn.addEventListener('click', () => setTimeout(paintAbout, 1500)), 0);

  /* ── 数据：按范围导出（大小来自服务端 dry=1，不写死）───────────────── */
  let scopeRows = [];
  let scopeLoaded = false;
  const fmtBytes = (n) => {
    const v = Math.max(0, Number(n) || 0);
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1024 / 1024).toFixed(1)} MB`;
  };
  function selectedScopes() {
    return $$('#exportScopes [data-scope]').filter((i) => i.checked).map((i) => i.dataset.scope);
  }
  function paintScopeTotal() {
    const ids = new Set(selectedScopes());
    const total = scopeRows.filter((r) => ids.has(r.id)).reduce((n, r) => n + (Number(r.bytes) || 0), 0);
    if ($('exportTotal')) $('exportTotal').innerHTML = `合计 <b>${fmtBytes(total)}</b> · ${ids.size} 项`;
    if ($('exportSelected')) $('exportSelected').disabled = ids.size === 0;
  }
  async function loadScopes(force) {
    const box = $('exportScopes');
    if (!box || !deps.api) return;
    if (scopeLoaded && !force) return;
    box.innerHTML = '<p class="set-hint">正在读取可导出范围…</p>';
    try {
      const data = await deps.api('/api/custom/export?what=selected&dry=1');
      scopeRows = Array.isArray(data && data.scopes) ? data.scopes : [];
      if (!scopeRows.length) {
        box.innerHTML = '<p class="set-hint">当前没有可导出的数据。</p>';
        paintScopeTotal();
        return;
      }
      box.innerHTML = scopeRows.map((r) => {
        const files = Array.isArray(r.files) ? r.files.join(' · ') : '';
        return `<label class="set-scope"><input type="checkbox" data-scope="${esc(r.id)}" checked>`
          + `<span class="txt"><b>${esc(r.label || r.id)}</b><span>${esc(files)}</span></span>`
          + `<span class="size">${fmtBytes(r.bytes)}</span></label>`;
      }).join('');
      scopeLoaded = true;
      paintScopeTotal();
    } catch (e) {
      box.innerHTML = `<p class="set-hint">范围读取失败：${esc(e.message)}；仍可用下面的完整数据包。</p>`;
    }
  }
  const scopeBox = $('exportScopes');
  if (scopeBox) scopeBox.addEventListener('change', paintScopeTotal);
  const exportSelected = $('exportSelected');
  if (exportSelected) {
    exportSelected.addEventListener('click', () => {
      const ids = selectedScopes();
      if (!ids.length) return deps.toast('先选至少一项再导出', 'warn');
      deps.exportSelected(ids);
    });
  }

  /* ── 外观绘制 ─────────────────────────────────────────────────────── */
  function paintTheme() {
    const t = themeNow();
    $$('#setThemeSeg [data-theme-opt]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.themeOpt === t));
    });
  }
  function paintAccents() {
    const a = accentNow();
    $$('[data-accent-opt]', accentGrid || document).forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.accentOpt === a));
    });
  }
  function paintFont() {
    const f = fontNow() === 'serif' ? 'serif' : 'sans';
    $$('[data-font-opt]', fontGrid || document).forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.fontOpt === f));
    });
  }
  function paintChip() {
    const label = ACCENT_LABELS[accentNow()] || accentNow();
    const theme = themeNow() === 'dark' ? '夜间' : '日间';
    if ($('setChip')) $('setChip').textContent = `${label} · ${theme}`;
    if ($('setAccentName')) $('setAccentName').textContent = label;
  }

  function paintAll() {
    paintTheme();
    paintAccents();
    paintFont();
    paintChip();
    paintBackground();
    paintLaunch();
    paintAbout();
  }

  /* ── 恢复默认外观 ─────────────────────────────────────────────────── */
  const reset = $('setResetAppearance');
  if (reset) {
    reset.addEventListener('click', async () => {
      deps.setAccent('ocean');
      deps.setFontStyle('sans');
      await deps.applyTheme('light');
      const sb = window.ShaderBG;
      const defaultBg = sb ? (sb.DEFAULT || sb.VARIANTS[0].id) : '';
      if (sb) {
        sb.set(defaultBg);
        sb.setSpeed(66);
      }
      paintAll();
      const bgLabel = (sb && (sb.VARIANTS || []).find((x) => x.id === defaultBg) || {}).label || '默认';
      deps.toast(`外观已恢复为默认：海蓝 · 日间 · ${bgLabel} · 无衬线`, 'ok');
    });
  }

  /* ── 开合 ─────────────────────────────────────────────────────────── */
  function setBackgroundInert(on) {
    $$('.topbar, #navrow, #page, .foot, .savebar').forEach((el) => {
      if (on) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    });
  }

  function setRailActive(id) {
    railItems.forEach((r) => {
      const on = r.dataset.target === id;
      r.classList.toggle('is-active', on);
      if (on) r.setAttribute('aria-current', 'true');
      else r.removeAttribute('aria-current');
    });
  }

  function updateRail() {
    if (performance.now() < railLockUntil) return;
    const line = scroll.scrollTop + Math.min(180, scroll.clientHeight * .38);
    let current = sections.length ? sections[0].id : '';
    sections.forEach((s) => { if (s.offsetTop <= line) current = s.id; });
    const max = scroll.scrollHeight - scroll.clientHeight;
    if (sections.length && max > 0 && scroll.scrollTop >= max - 120) {
      current = sections[sections.length - 1].id;
    }
    if (current) setRailActive(current);
  }

  railItems.forEach((r) => {
    r.addEventListener('click', () => {
      const target = document.getElementById(r.dataset.target);
      if (!target) return;
      setRailActive(target.id);
      railLockUntil = performance.now() + 900;
      const top = target.offsetTop - scroll.offsetTop;
      scroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    });
  });
  let railRaf = 0;
  scroll.addEventListener('scroll', () => {
    if (railRaf) return;
    railRaf = requestAnimationFrame(() => { railRaf = 0; updateRail(); });
  }, { passive: true });

  function open() {
    if (isOpen) return;
    isOpen = true;
    lastFocus = document.activeElement;
    paintAll();
    layer.dataset.open = 'true';
    layer.removeAttribute('aria-hidden');
    gear.classList.add('is-open');
    gear.setAttribute('aria-expanded', 'true');
    gear.setAttribute('aria-label', '关闭设置');
    gear.title = '关闭设置';
    document.documentElement.classList.add('settings-open');
    setBackgroundInert(true);
    scroll.scrollTop = 0;
    // 打开时补一次状态（首屏可能还没拿到 /api/state；只影响只读信息）。
    Promise.resolve(deps.refresh(true)).then(() => {
      if (!isOpen) return;
      paintAll();
      void loadScopes(true);
    }).catch(() => { void loadScopes(true); });
    setTimeout(() => {
      if (panel) panel.focus({ preventScroll: true });
      updateRail();
    }, 30);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    layer.dataset.open = 'false';
    layer.setAttribute('aria-hidden', 'true');
    gear.classList.remove('is-open');
    gear.setAttribute('aria-expanded', 'false');
    gear.setAttribute('aria-label', '打开设置');
    gear.title = '设置';
    document.documentElement.classList.remove('settings-open');
    setBackgroundInert(false);
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus({ preventScroll: true });
    else gear.focus({ preventScroll: true });
  }

  layer.setAttribute('aria-hidden', 'true');
  gear.addEventListener('click', () => { if (isOpen) close(); else open(); });
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (backdrop) backdrop.addEventListener('click', close);

  document.addEventListener('keydown', (ev) => {
    if (!isOpen) return;
    if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
    if (ev.key !== 'Tab' || !panel) return;
    const focusables = $$('a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])', panel)
      .filter((el) => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (ev.shiftKey && (active === first || active === panel)) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
  });

}
