#!/usr/bin/env node
/**
 * 人设工厂单文件构建器（零依赖）。
 *
 * 源：panel/next/persona-studio/{factory.css,core.js,ui.js}
 * 产出：panel/next/persona-factory.html（登记进 NEXT_ASSETS 的那一份）
 *
 * 用法：
 *   node scripts/build-persona-factory.mjs           # 写入
 *   node scripts/build-persona-factory.mjs --check   # 只核对是否最新（供门禁用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'panel', 'next', 'persona-studio');
const OUT = path.join(ROOT, 'panel', 'next', 'persona-factory.html');

function read(name) {
  const file = path.join(SRC, name);
  if (!fs.existsSync(file)) throw new Error(`缺少源文件：${path.relative(ROOT, file)}`);
  return fs.readFileSync(file, 'utf8');
}

function build() {
  const css = read('factory.css');
  const core = read('core.js');
  const ui = read('ui.js');
  const logo = read('logo.svg').trim()
    .replace(/<svg\b/, '<svg class="brand-mark" aria-hidden="true" focusable="false"');
  if (/<\/script/i.test(core) || /<\/script/i.test(ui)) {
    throw new Error('core.js / ui.js 里出现了 </script，不能直接内联进单文件 HTML');
  }
  return `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>人设工厂 · ESTRELLA PERSONA STUDIO</title>
<meta name="description" content="Estrella 人设工厂：六章向导、底色与偏好生成、MBTI / 生日、实时预览与预算。">
<!-- 由 scripts/build-persona-factory.mjs 生成；改源码请改 panel/next/persona-studio/ 下的文件。 -->
<style>
${css}
</style>
</head>
<body>
<a class="skip-link" href="#editor">跳到人设编辑器</a>
<div class="page-deco" aria-hidden="true">
  <svg class="deco deco-books" viewBox="0 0 120 140" fill="none">
    <rect x="14" y="96" width="88" height="18" rx="3" stroke="currentColor" stroke-width="1.5"/>
    <path d="M14 105h88" stroke="currentColor" stroke-width="1" opacity=".45"/>
    <rect x="24" y="76" width="78" height="18" rx="3" stroke="currentColor" stroke-width="1.5"/>
    <path d="M24 85h78" stroke="currentColor" stroke-width="1" opacity=".45"/>
    <rect x="10" y="56" width="72" height="18" rx="3" stroke="currentColor" stroke-width="1.5"/>
    <path d="M10 65h72" stroke="currentColor" stroke-width="1" opacity=".45"/>
    <path d="M62 56v18" stroke="var(--violet)" stroke-width="1.5"/>
    <path d="M96 74l10 7V57z" fill="var(--lime)" opacity=".55"/>
  </svg>
  <svg class="deco deco-quill" viewBox="0 0 120 160" fill="none">
    <path d="M30 140C46 112 62 82 94 22" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M94 22c-4 24-16 45-32 60-10 9-21 15-32 18 11 0 24-5 36-12 20-12 30-34 28-66z" stroke="currentColor" stroke-width="1.4"/>
    <path d="M62 70l-9-12M70 58l-10-11M78 46l-10-10M54 82l-9-13" stroke="currentColor" stroke-width="1" opacity=".55"/>
    <path d="M30 140l-7 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    <path d="M96 26c6-4 12-6 18-6" stroke="var(--violet)" stroke-width="1.2" opacity=".55"/>
  </svg>
  <svg class="deco deco-spread" viewBox="0 0 140 100" fill="none">
    <path d="M70 24C58 16 42 12 24 12v58c18 0 34 4 46 12 12-8 28-12 46-12V12c-18 0-34 4-46 12Z" stroke="currentColor" stroke-width="1.5"/>
    <path d="M70 24v58" stroke="currentColor" stroke-width="1.2"/>
    <path d="M36 26c8 0 15 2 22 6M36 38c8 0 15 2 22 6M36 50c8 0 15 2 22 6" stroke="currentColor" stroke-width="1" opacity=".55"/>
    <path d="M104 26c-8 0-15 2-22 6M104 38c-8 0-15 2-22 6M104 50c-8 0-15 2-22 6" stroke="currentColor" stroke-width="1" opacity=".55"/>
    <path d="M70 18V8" stroke="var(--violet)" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M70 8l7-4-2 8z" fill="var(--lime)" opacity=".6"/>
  </svg>
  <svg class="deco deco-inkwell" viewBox="0 0 100 120" fill="none">
    <path d="M28 64h44l-6 34H34z" stroke="currentColor" stroke-width="1.5"/>
    <path d="M24 58h52v8H24z" stroke="currentColor" stroke-width="1.4"/>
    <path d="M38 58V46h24v12" stroke="currentColor" stroke-width="1.4"/>
    <path d="M50 44V18" stroke="currentColor" stroke-width="1.2"/>
    <path d="M50 20c8 6 13 14 12 24-6-5-11-13-12-24Z" stroke="var(--violet)" stroke-width="1.3"/>
    <path d="M33 98h34" stroke="currentColor" stroke-width="1" opacity=".4"/>
  </svg>
  <svg class="deco deco-bookmark" viewBox="0 0 80 120" fill="none">
    <path d="M22 10h36v84l-18-12-18 12z" stroke="currentColor" stroke-width="1.5"/>
    <path d="M30 26h20M30 38h20M30 50h12" stroke="currentColor" stroke-width="1" opacity=".5"/>
    <path d="M40 94v14M40 102l-6 8M40 102l6 8" stroke="var(--violet)" stroke-width="1.3" stroke-linecap="round"/>
  </svg>
  <svg class="deco deco-letter" viewBox="0 0 120 100" fill="none">
    <rect x="12" y="22" width="96" height="62" rx="4" stroke="currentColor" stroke-width="1.5"/>
    <path d="M12 25l48 31 48-31" stroke="currentColor" stroke-width="1.3"/>
    <path d="M12 80l33-27M108 80L75 53" stroke="currentColor" stroke-width="1" opacity=".5"/>
    <circle cx="60" cy="57" r="7" stroke="var(--violet)" stroke-width="1.4"/>
    <path d="M60 64v9" stroke="var(--violet)" stroke-width="1.2"/>
  </svg>
  <svg class="deco deco-sprig" viewBox="0 0 120 140" fill="none">
    <path d="M28 132C44 100 62 66 96 18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M54 78c-14-2-24-10-28-22 14 0 25 8 28 22ZM66 60c2-14 10-24 22-28-1 14-9 25-22 28ZM44 96c-13 0-24-6-30-17 13-2 25 5 30 17ZM78 44c0-13 6-24 17-30 2 13-5 25-17 30Z" stroke="currentColor" stroke-width="1.2"/>
    <circle cx="86" cy="34" r="3" fill="var(--lime)" opacity=".6"/>
  </svg>
</div>
<header class="site-header">
  <a class="brand" href="#" aria-label="人设工厂首页">${logo}<span class="brand-copy"><strong>Estrella Persona Studio</strong><small>人设工厂</small></span></a>
  <div class="header-actions">
    <span class="local-indicator"><span aria-hidden="true"></span>你的灵感，只留在本地</span>
    <span class="live-badge header-mode" id="modeState"><span aria-hidden="true"></span>连接中</span>
    <button class="button button-quiet" id="btnNew" type="button">新建</button>
    <button class="button button-primary" id="btnDeliver" type="button">交付</button>
  </div>
</header>

<main class="workspace">
  <div class="draft-banner" id="draftBanner" hidden>
    <div><strong id="draftBannerTitle">已恢复上次的草稿。</strong><span id="draftBannerDetail"></span></div>
    <div><button class="button button-small" type="button" data-draft-action="fresh">从头开始</button><button class="button button-quiet button-small" type="button" data-draft-action="dismiss">知道了</button></div>
  </div>

  <div class="studio-grid">
    <section class="editor-panel" aria-label="人设编辑器">
      <div class="editor-topline"><span class="section-kicker">01 / 塑造你的角色</span><span class="draft-state" id="draftState">新草稿</span></div>
      <nav class="stepper" id="chapterRail" aria-label="创作步骤"></nav>
      <section id="editor"></section>
      <div class="step-footer">
        <button class="button button-quiet" id="btnPrev" type="button">← 上一步</button>
        <span id="stepCounter">1 / 6</span>
        <button class="button button-primary" id="btnNext" type="button">下一步：性格 →</button>
      </div>
      <div class="draft-toolbar">
        <div class="draft-actions">
          <button class="text-button" id="btnSaveDraft" type="button">保存草稿</button>
          <span aria-hidden="true">·</span>
          <button class="text-button" id="btnLoadDraft" type="button">加载草稿</button>
          <span aria-hidden="true">·</span>
          <button class="text-button" id="btnResetDraft" type="button">重新开始</button>
        </div>
        <p id="storageStatus">草稿只保存在这台设备；不会上传。</p>
      </div>
    </section>
    <aside class="preview-panel" id="preview" aria-label="实时人设预览"></aside>
  </div>
</main>

<div class="ps-modal-root" id="modalRoot" hidden></div>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
<noscript><div style="padding:24px;font:16px/1.6 sans-serif">人设工厂需要 JavaScript 才能运行。</div></noscript>

<script>
/* PERSONA-STUDIO-CORE:BEGIN */
${core}
/* PERSONA-STUDIO-CORE:END */
</script>
<script>
${ui}
</script>
</body>
</html>
`;
}

const check = process.argv.includes('--check');
const html = build();
if (check) {
  if (!fs.existsSync(OUT)) {
    console.error(`✗ 缺少构建产物：${path.relative(ROOT, OUT)}（先跑 node scripts/build-persona-factory.mjs）`);
    process.exit(1);
  }
  const old = fs.readFileSync(OUT, 'utf8');
  if (old !== html) {
    console.error('✗ 人设工厂单文件不是最新：源文件改过但没有重新构建。');
    console.error('  跑：node scripts/build-persona-factory.mjs');
    process.exit(1);
  }
  console.log(`✓ 人设工厂单文件是最新（${Buffer.byteLength(html)} B）`);
} else {
  fs.writeFileSync(OUT, html);
  console.log(`✓ 已生成 ${path.relative(ROOT, OUT)}（${Buffer.byteLength(html)} B）`);
}
