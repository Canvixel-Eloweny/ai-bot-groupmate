/* 人设工厂 UI（零依赖；由单文件构建内联） */
(function () {
  'use strict';

  const PS = window.PersonaStudioCore;
  if (!PS) {
    document.body.innerHTML = '<div style="padding:40px;font:16px/1.6 sans-serif">人设工厂核心没有加载成功。</div>';
    return;
  }

  const DRAFT_KEY = 'next-persona-studio-v1';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cssEsc = (s) => (window.CSS && window.CSS.escape ? window.CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'));
  const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const CHAPTER_FIELDS = {
    1: ['persona.role', 'persona.age', 'persona.world'],
    2: ['persona.traits', 'persona.desire', 'persona.fear', 'enhance.values', 'enhance.decide', 'enhance.stress', 'enhance.emotion'],
    3: ['persona.tone', 'persona.catch', 'enhance.speech', 'enhance.habits', 'enhance.meters'],
    4: ['persona.logic', 'persona.attitude', 'persona.status'],
    5: ['enhance.limits', 'enhance.secrets', 'enhance.relation', 'enhance.growth'],
    6: ['enhance.lines'],
  };
  const PERSONA_HINTS = {
    personaName: '它就是群友叫它的名字；和「人格 → 人设」页共用同一个值。',
    'persona.role': '一句话说清它在群里是谁；不用写完整履历。',
    'persona.age': '可以写「不详」；不需要和生日参考年龄一致。',
    'persona.world': '影响它举什么例子、用什么词。',
    'persona.traits': '2–4 个就够；形容词后面最好能接一个行为。',
    'persona.tone': '写它怎么开口、句子多长、会不会抢话。',
    'persona.catch': '偶尔用，不要每句都挂。',
    'persona.desire': '它最想要什么；行为的发动机。',
    'persona.fear': '最怕什么、什么会让它失控。',
    'persona.logic': '遇事怎么判断、先做什么。',
    'persona.attitude': '对群里人的初始距离。',
    'persona.status': '现在在哪、想做什么、情绪如何；可随时手改。',
    'mbti.note': '写它和类型不一样的地方；不写也可以。',
  };
  const TRAIT_OPTIONS = ['温柔', '细心', '慢热', '嘴毒', '心软', '反应快', '冷静', '清晰', '可靠', '热情', '会接梗', '闲不住', '敏感', '画面感', '嘴硬', '护短', '直球', '幽默'];
  const TONE_OPTIONS = [
    { id: 'base', label: '跟随底色' }, { id: 'soft', label: '轻一点' }, { id: 'dry', label: '收着说' },
    { id: 'sharp', label: '带点刺' }, { id: 'warm', label: '多回应' },
  ];
  const HUMOR_OPTIONS = [
    { id: 'base', label: '跟随底色' }, { id: 'self', label: '自嘲' }, { id: 'dry', label: '冷幽默' },
    { id: 'pun', label: '谐音梗' }, { id: 'none', label: '不刻意' },
  ];
  const GROUP_OPTIONS = [
    { id: 'base', label: '跟随底色' }, { id: 'listener', label: '倾听者' }, { id: 'hype', label: '气氛组' },
    { id: 'critic', label: '吐槽役' }, { id: 'strategist', label: '军师' }, { id: 'favorite', label: '团宠' },
    { id: 'observer', label: '旁观者' },
  ];
  const CONFLICT_OPTIONS = [
    { id: 'base', label: '跟随底色' }, { id: 'apologize', label: '先认下来' }, { id: 'reason', label: '讲道理' },
    { id: 'cold', label: '冷处理' }, { id: 'retort', label: '先怼回去' }, { id: 'silent', label: '先沉默' },
  ];
  const CLOSENESS_OPTIONS = [
    { id: 'base', label: '跟随底色' }, { id: 'slow', label: '慢热' }, { id: 'normal', label: '正常' },
    { id: 'clingy', label: '熟了黏人' },
  ];
  const SCENE_GROUPS = [
    { label: '日常', keys: ['newMember', 'silent', 'lateNight'] },
    { label: '冲突', keys: ['insulted', 'complaint'] },
    { label: '故障', keys: ['searchFail', 'visionFail', 'webFail', 'typo'] },
  ];
  const STEP_LABELS = { 1: '身份', 2: '性格', 3: '语言', 4: '群聊', 5: '边界', 6: '场景' };
  const CHAPTER_GLYPHS = { 1: '✺', 2: '◒', 3: '❞', 4: '⌘', 5: '⌁', 6: '↗' };

  let SCHEMA = PS.clone(PS.FALLBACK_SCHEMA);
  let STATE = null;
  let MODE = 'offline';
  let DRAFT = null;
  let SAVED = null;
  let CHAPTER = 1;
  let STEP_DIR = 1;
  let PREVIEW_TAB = 'prompt';
  let LAST_PREVIEW_TAB = 'prompt';
  let VALIDATION_OPEN = false;
  let EDITED = false;
  let SAVE_TIMER = 0;
  let PREVIEW_TIMER = 0;
  let TOAST_TIMER = 0;
  let COPY_TIMER = 0;
  let FOCUS_AFTER_RENDER = '';
  let MODAL_ACTIONS = {};
  let QUIZ = { EI: null, SN: null, TF: null, JP: null };

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); return true; } catch { return false; }
  }

  function labelOf(path) {
    if (path === 'personaName') return '机器人昵称';
    if (path === 'mbti.note') return '个人差异补充';
    if (path.startsWith('persona.')) {
      const k = path.slice(8);
      return SCHEMA.personaLabels[k] || k;
    }
    if (path.startsWith('enhance.')) {
      const k = path.slice(8);
      return SCHEMA.enhanceTable[k]?.label || k;
    }
    if (path.startsWith('scenes.')) {
      const k = path.slice(7);
      return SCHEMA.sceneTable[k]?.label || k;
    }
    return path;
  }
  function hintOf(path) {
    if (PERSONA_HINTS[path]) return PERSONA_HINTS[path];
    if (path.startsWith('enhance.')) return SCHEMA.enhanceTable[path.slice(8)]?.hint || '';
    if (path.startsWith('scenes.')) return SCHEMA.sceneTable[path.slice(7)]?.hint || '';
    return '';
  }
  function phOf(path) {
    if (path.startsWith('enhance.')) return SCHEMA.enhanceTable[path.slice(8)]?.ph || '';
    if (path.startsWith('scenes.')) return SCHEMA.sceneTable[path.slice(7)]?.ph || '';
    if (path === 'persona.traits') return '温柔、细心、偶尔吐槽';
    if (path === 'persona.tone') return '说话轻一点，句子偏短；先接住情绪，再给建议。';
    if (path === 'persona.catch') return '我在听。';
    if (path === 'persona.role') return '群里的树洞型朋友，习惯先听完再开口。';
    if (path === 'persona.world') return '现实都市，普通人的日常。';
    if (path === 'persona.age') return '可以写：不详';
    if (path === 'persona.desire') return '希望群里有人难过时，有一个不急着评判的人。';
    if (path === 'persona.fear') return '怕自己说错话，让对方更难受。';
    if (path === 'persona.logic') return '先确认对方是在倾诉还是求建议。';
    if (path === 'persona.attitude') return '对陌生人礼貌，对熟人会多问一句。';
    if (path === 'persona.status') return '现在在群里安静待着，看到有人低落会接一句。';
    if (path === 'mbti.note') return '比如：我比 INFJ 更爱开玩笑。';
    return '';
  }
  function isLong(path) {
    if (path === 'personaName') return false;
    if (path === 'mbti.note') return true;
    if (path.startsWith('persona.')) return SCHEMA.personaLongKeys.includes(path.slice(8));
    if (path.startsWith('enhance.')) return !SCHEMA.enhanceShortKeys.includes(path.slice(8));
    if (path.startsWith('scenes.')) return true;
    return false;
  }
  function isRequired(path) { return path === 'personaName' || path === 'persona.role' || path === 'persona.traits' || path === 'persona.tone'; }
  function sourceOf(path) { return DRAFT?.meta?.sources?.[path] || 'preset'; }
  function forceSources(paths) {
    if (!DRAFT?.meta?.sources) return;
    for (const p of paths) DRAFT.meta.sources[p] = 'preference';
  }
  function idOf(path) { return 'psf-' + String(path).replace(/[^a-zA-Z0-9]+/g, '-'); }

  function fieldHtml(path, opts) {
    const o = opts || {};
    const value = path === 'personaName' ? DRAFT.personaName : PS.getPath(DRAFT.fields, path);
    const lim = PS.limitOf(SCHEMA, path);
    const count = PS.charCount(value);
    const over = count > lim;
    const long = o.long === undefined ? isLong(path) : !!o.long;
    const user = sourceOf(path) === 'user';
    const label = o.label || labelOf(path);
    const hint = o.hint === undefined ? hintOf(path) : o.hint;
    const ph = o.ph === undefined ? phOf(path) : o.ph;
    const rows = o.rows || (long ? (path === 'enhance.lines' ? 4 : 3) : 1);
    const fieldId = idOf(path);
    return '<div class="field ps-field ' + (user ? 'is-user' : '') + '" data-field="' + esc(path) + '">'
      + '<label class="ps-label" for="' + fieldId + '">' + esc(label)
      + (isRequired(path) ? ' <span class="req">*</span>' : '')
      + '<span class="lim">' + (long ? '最多 ' + fmt(lim) + ' 字' : '') + '</span></label>'
      + (long
        ? '<textarea class="ps-textarea ' + (over ? 'is-error' : '') + '" id="' + fieldId + '" data-path="' + esc(path) + '" rows="' + rows + '" placeholder="' + esc(ph) + '">' + esc(value) + '</textarea>'
        : '<input class="ps-input ' + (over ? 'is-error' : '') + '" id="' + fieldId + '" data-path="' + esc(path) + '" value="' + esc(value) + '" placeholder="' + esc(ph) + '">')
      + '<div class="ps-field-foot"><span class="ps-hint">' + esc(hint) + '</span>'
      + '<span class="ps-counter ' + (over ? 'is-over' : '') + '" data-count-for="' + esc(path) + '">' + fmt(count) + ' / ' + fmt(lim) + '</span></div>'
      + '<div class="ps-error" data-error-for="' + esc(path) + '"' + (over ? '' : ' hidden') + '>超过上限 ' + fmt(lim) + ' 字；不会静默截断，请先删减。</div>'
      + '<div class="ps-field-actions"><button class="ps-linklike" type="button" data-action="reset-field" data-path="' + esc(path) + '">恢复预设</button></div>'
      + '</div>';
  }

  function chipRow(action, options, current, opts) {
    const o = opts || {};
    return '<div class="ps-chip-row">' + options.map((opt) => {
      const id = typeof opt === 'string' ? opt : opt.id;
      const label = typeof opt === 'string' ? opt : opt.label;
      const on = o.multi ? (current || []).includes(id) : current === id;
      return '<button class="ps-chip ' + (on ? 'is-on' : '') + '" type="button" aria-pressed="' + (on ? 'true' : 'false')
        + '" data-action="' + esc(action) + '" data-value="' + esc(id) + '">' + esc(label) + '</button>';
    }).join('') + '</div>';
  }

  function sceneField(k) {
    const path = 'scenes.' + k;
    return '<div class="ps-scene">' + fieldHtml(path, { label: SCHEMA.sceneTable[k]?.label || k, hint: SCHEMA.sceneTable[k]?.hint || '', ph: SCHEMA.sceneTable[k]?.ph || '', long: true, rows: 2 }) + '</div>';
  }

  function birthdayBlock() {
    const b = DRAFT.fields.birthday;
    const info = PS.birthdayInfo(DRAFT, SCHEMA);
    const days = maxDay(b.month);
    const monthOpts = ['<option value="0">不填</option>'].concat(Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      return '<option value="' + m + '"' + (b.month === m ? ' selected' : '') + '>' + m + ' 月</option>';
    })).join('');
    const dayOpts = ['<option value="0">不填</option>'].concat(Array.from({ length: days }, (_, i) => {
      const d = i + 1;
      return '<option value="' + d + '"' + (b.day === d ? ' selected' : '') + '>' + d + ' 日</option>';
    })).join('');
    return '<div class="form-group feature" id="birthdayBlock">'
      + '<div class="group-head"><div class="group-head-main"><div class="group-title">生日彩蛋 <span class="group-badge">娱乐</span></div>'
      + '<div class="group-sub">参考周岁 + 生日，推生肖与星座；生肖只展示，星座最多两句进提示词。</div></div></div>'
      + '<div class="ps-birth-row">'
      + '<label class="ps-field"><span class="ps-label">参考周岁</span><input class="ps-input" type="number" min="0" max="120" data-birthday="age" value="' + (b.age || '') + '" placeholder="可留空"></label>'
      + '<label class="ps-field"><span class="ps-label">出生月份</span><select class="ps-select" data-birthday="month">' + monthOpts + '</select></label>'
      + '<label class="ps-field"><span class="ps-label">出生日期</span><select class="ps-select" data-birthday="day">' + dayOpts + '</select></label>'
      + '</div>'
      + '<div class="ps-birth-derived">'
      + (info.sign
        ? '<span class="ps-birth-sign"><span class="glyph">' + esc(info.sign.glyph) + '</span>' + esc(info.sign.name) + ' · ' + esc(info.sign.range) + '</span><span class="ps-birth-note">' + esc(info.sign.trait) + '</span>'
        : '<span class="ps-birth-note">选好月日后显示星座</span>')
      + (info.animal ? '<span class="ps-birth-note">生肖（只展示）：' + esc(info.animal) + '</span>' : '')
      + '</div>'
      + '<div class="ps-axis-toggle-row" style="margin-top:12px">'
      + '<button class="ps-switch ' + (DRAFT.fields.astroOn ? 'is-on' : '') + '" type="button" role="switch" aria-checked="' + (DRAFT.fields.astroOn ? 'true' : 'false') + '" aria-label="把星座写进提示词" data-action="astro-toggle"></button>'
      + '<div><b style="font-size:12px">把星座写进提示词</b><div class="ps-hint">' + (DRAFT.fields.astroOn ? '保存后会注入；只影响表达色彩，不改变人设。' : '关闭时只展示，不注入。') + '</div></div>'
      + '</div></div>';
  }

  function maxDay(month) {
    return [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(month) - 1] || 31;
  }

  function mbtiBlock() {
    const f = DRAFT.fields.mbti;
    const m = PS.mbtiInfo(f.axes, SCHEMA);
    const axes = SCHEMA.mbti.axes || [];
    const typeOpts = Object.keys(SCHEMA.mbti.types || {}).sort().map((code) => '<option value="' + code + '"' + (code === m.type ? ' selected' : '') + '>' + code + ' · ' + esc(SCHEMA.mbti.types[code].name) + '</option>').join('');
    return '<div class="form-group feature" id="mbtiBlock">'
      + '<div class="group-head"><div class="group-head-main"><div class="group-title">MBTI 辅助 <span class="group-badge">可选</span></div>'
      + '<div class="group-sub">只当表达倾向，不覆盖人设。默认不注入；四轴可以微调。</div></div>'
      + '<button class="button button-small" type="button" data-action="mbti-quiz">4 个小问题起步</button></div>'
      + '<div class="ps-mbti-type" id="mbtiTypeCard">'
      + '<div class="ps-type-code">' + esc(m.type) + '</div>'
      + '<div class="ps-type-copy"><div class="ps-type-name">' + esc(m.name) + '</div><div class="ps-type-tag">' + esc(m.tag) + '</div>'
      + '<div class="ps-type-traits">' + (m.traits || []).map((t) => '<span>' + esc(t) + '</span>').join('') + '</div></div></div>'
      + '<div class="ps-type-select"><span>直接选类型</span><select class="ps-select" data-action="mbti-type-select">' + typeOpts + '</select></div>'
      + '<div class="ps-axes">' + axes.map((axis) => {
        const v = Number(f.axes[axis.id]) || 0;
        return '<div class="ps-axis" data-axis-row="' + axis.id + '">'
          + '<div class="ps-axis-head"><span><b class="' + (v >= 50 ? '' : 'is-on') + '">' + axis.left + '</b> ' + esc(axis.leftName) + ' ' + (100 - v) + '%</span>'
          + '<span><b class="' + (v >= 50 ? 'is-on' : '') + '">' + axis.right + '</b> ' + esc(axis.rightName) + ' ' + v + '%</span></div>'
          + '<div class="ps-axis-slider"><div class="ps-axis-mid"></div><input type="range" min="0" max="100" step="1" value="' + v + '" data-axis="' + axis.id + '" aria-label="' + esc(axis.leftName + '与' + axis.rightName) + '"></div></div>';
      }).join('') + '</div>'
      + '<div class="ps-axis-toggle-row" style="margin-top:13px">'
      + '<button class="ps-switch ' + (f.on ? 'is-on' : '') + '" type="button" role="switch" aria-checked="' + (f.on ? 'true' : 'false') + '" aria-label="把 MBTI 写进提示词" data-action="mbti-toggle"></button>'
      + '<div><b style="font-size:12px">把 MBTI 写进提示词</b><div class="ps-hint">' + (f.on ? '已打开：会作为辅助层注入，只影响表达倾向。' : '默认关闭：类型只用于预览，不注入。') + '</div></div>'
      + '</div>'
      + '<div style="margin-top:13px">' + fieldHtml('mbti.note', { label: '个人差异补充', long: true, rows: 2, hint: '写它和类型不一样的地方；不写也可以。', ph: '比如：我比 INFJ 更爱开玩笑。' }) + '</div>'
      + '</div>';
  }

  function chapterHead() {
    const ch = PS.CHAPTERS[CHAPTER - 1];
    const done = PS.completeness(DRAFT, SCHEMA);
    return '<div class="step-heading"><div><p class="eyebrow">CHAPTER ' + String(CHAPTER).padStart(2, '0') + ' / 06 · ' + esc(ch.title) + '</p>'
      + '<h2 id="chapterHeading" tabindex="-1">' + esc(ch.question) + '</h2></div>'
      + '<span class="step-illustration" aria-hidden="true">' + (CHAPTER_GLYPHS[CHAPTER] || '✳') + '</span></div>'
      + '<p class="section-description">' + esc(ch.desc) + '</p>'
      + '<div class="chapter-tools"><span class="chapter-status">' + (done[CHAPTER] ? '本章已有内容' : '本章待填') + '</span>'
      + '<button class="text-button" type="button" data-action="reset-chapter">恢复本章预设</button></div>';
  }

  function presetBox() {
    const cards = (STATE?.custom?.skills || []).filter((s) => s && s.kind === 'persona');
    const cardDisabled = cards.length ? '' : ' disabled title="当前没有可用的角色卡"';
    const currentDisabled = STATE ? '' : ' disabled title="现在连不上控制台"';
    return '<div class="preset-box"><div class="preset-heading"><span>从一个灵感出发</span><small>选中会替换当前草稿</small></div>'
      + '<div class="preset-list" aria-label="人设起点">' + PS.PRESETS.map((p) => '<button class="preset-chip" type="button" data-start="preset" data-value="' + esc(p.id) + '" aria-pressed="' + (DRAFT.presetId === p.id ? 'true' : 'false') + '" title="' + esc(p.tagline) + '">' + esc(p.name) + '</button>').join('') + '</div>'
      + '<div class="preset-secondary"><button class="text-button" type="button" data-start="current"' + currentDisabled + '>从当前人格开始</button><span aria-hidden="true">·</span>'
      + '<button class="text-button" type="button" data-start="card"' + cardDisabled + '>从角色卡开始</button><span aria-hidden="true">·</span>'
      + '<button class="text-button" type="button" data-start="blank">空白开始</button></div></div>';
  }

  function editorHtml() {
    if (!DRAFT) return '<div class="ps-empty">正在读取底色…</div>';
    let body = '';
    if (CHAPTER === 1) {
      body = presetBox()
        + '<div class="form-group"><div class="group-head"><div class="group-head-main"><div class="group-title">身份档案</div><div class="group-sub">它在什么世界、以什么身份说话。</div></div><span class="group-badge">最高优先</span></div>'
        + '<div class="field-grid">' + fieldHtml('personaName', { label: '机器人昵称', long: false, hint: '它会显示在群里；也是「人格」页的昵称。', ph: '比如：星柚' })
        + fieldHtml('persona.age', { long: false }) + '</div>'
        + '<div class="ps-stack">' + fieldHtml('persona.role') + fieldHtml('persona.world') + '</div></div>'
        + birthdayBlock();
    } else if (CHAPTER === 2) {
      body = '<div class="form-group"><div class="group-head"><div class="group-head-main"><div class="group-title">性格骨架</div><div class="group-sub">先选几个关键词，再补一句行为；不要只写形容词。</div></div><span class="group-badge">2–4 个</span></div>'
        + chipRow('trait', TRAIT_OPTIONS, DRAFT.answers.traits || [], { multi: true })
        + fieldHtml('persona.traits', { long: true, rows: 2 })
        + '<div class="field-grid">' + fieldHtml('persona.desire') + fieldHtml('persona.fear') + '</div></div>'
        + '<div class="form-group"><div class="group-head"><div class="group-head-main"><div class="group-title">他怎么想</div><div class="group-sub">价值观、决策、压力反应、情绪触发。</div></div></div>'
        + '<div class="ps-stack">' + fieldHtml('enhance.values') + fieldHtml('enhance.decide') + fieldHtml('enhance.stress') + fieldHtml('enhance.emotion') + '</div></div>'
        + mbtiBlock();
    } else if (CHAPTER === 3) {
      body = '<div class="form-group"><div class="group-head"><div class="group-head-main"><div class="group-title">语气与句子</div><div class="group-sub">像不像一个人，主要看这里。</div></div></div>'
        + '<span class="ps-label">语气倾向</span>' + chipRow('tone', TONE_OPTIONS, DRAFT.answers.tone || 'base')
        + fieldHtml('persona.tone')
        + '<div class="field-grid">' + fieldHtml('persona.catch') + fieldHtml('enhance.habits') + '</div>'
        + '<span class="ps-label">回复长度</span>' + chipRow('length', Object.keys(SCHEMA.replyLengths).map((id) => ({ id, label: SCHEMA.replyLengths[id].label })), DRAFT.answers.length || DRAFT.fields.replyStyle.length)
        + '<div class="ps-hint" style="margin:-8px 0 16px">' + esc((SCHEMA.replyLengths[DRAFT.fields.replyStyle.length] || {}).hint || '') + '</div></div>'
        + '<div class="form-group"><div class="group-head"><div class="group-head-main"><div class="group-title">语言指纹</div><div class="group-sub">常用词、幽默感、称呼变化；写成能照着演的样子。</div></div></div>'
        + '<span class="ps-label">幽默方式</span>' + chipRow('humor', HUMOR_OPTIONS, DRAFT.answers.humor || 'base')
        + fieldHtml('enhance.speech')
        + fieldHtml('enhance.meters') + '</div>';
    } else if (CHAPTER === 4) {
      body = '<div class="form-group"><div class="group-head"><div class="group-head-main"><div class="group-title">群聊位置</div><div class="group-sub">它在群里是接话、救场、观察，还是只在被叫到时才出现？</div></div></div>'
        + '<span class="ps-label">群里的角色</span>' + chipRow('group', GROUP_OPTIONS, DRAFT.answers.groupRole || 'base')
        + fieldHtml('persona.logic')
        + fieldHtml('persona.attitude') + '</div>'
        + '<div class="form-group"><div class="group-head"><div class="group-head-main"><div class="group-title">压力与冲突</div><div class="group-sub">被怼、被质疑、场面僵住时，它先做什么。</div></div></div>'
        + '<span class="ps-label">冲突反应</span>' + chipRow('conflict', CONFLICT_OPTIONS, DRAFT.answers.conflict || 'base')
        + fieldHtml('persona.status') + '</div>';
    } else if (CHAPTER === 5) {
      const bounds = DRAFT.answers.bounds || [];
      body = '<div class="form-group"><div class="group-head"><div class="group-head-main"><div class="group-title">边界与雷区</div><div class="group-sub">哪些话它绝不会说；勾选后会合并进「底线与禁忌」。</div></div></div>'
        + '<span class="ps-label">安全边界</span>' + chipRow('bound', PS.BOUNDARY_OPTIONS, bounds, { multi: true })
        + fieldHtml('enhance.limits') + '</div>'
        + '<div class="form-group"><div class="group-head"><div class="group-head-main"><div class="group-title">关系怎么变</div><div class="group-sub">什么会让它靠近，什么会让它退开。</div></div></div>'
        + '<span class="ps-label">亲近速度</span>' + chipRow('closeness', CLOSENESS_OPTIONS, DRAFT.answers.closeness || 'base')
        + '<div class="ps-stack">' + fieldHtml('enhance.secrets') + fieldHtml('enhance.relation') + fieldHtml('enhance.growth') + '</div></div>';
    } else {
      body = '<div class="form-group"><div class="group-head"><div class="group-head-main"><div class="group-title">示例台词</div><div class="group-sub">2–3 句它真正会说的话；最能锁定语气。</div></div><span class="group-badge">最能锁语气</span></div>'
        + fieldHtml('enhance.lines', { long: true, rows: 4 }) + '</div>'
        + '<div class="form-group"><div class="group-head"><div class="group-head-main"><div class="group-title">九个场景</div><div class="group-sub">不用写长；每个场景一句，就能把语气和边界锁住。留空就不进提示词。</div></div></div>'
        + SCENE_GROUPS.map((g) => '<div class="ps-scene-group">' + esc(g.label) + '</div><div class="ps-scenes">' + g.keys.map(sceneField).join('') + '</div>').join('')
        + '</div>';
    }
    return '<section class="form-step" data-dir="' + (STEP_DIR < 0 ? 'back' : 'next') + '" data-panel="' + CHAPTER + '" aria-labelledby="chapterHeading">' + chapterHead() + body + '</section>';
  }

  function budgetRows(b) {
    const defs = [
      { id: 'persona', label: '人格段', note: '含底子 ' + fmt(b.base) + ' 字' },
      { id: 'enhance', label: '增强项' },
      { id: 'scenes', label: '场景' },
      { id: 'mbti', label: 'MBTI' },
      { id: 'astro', label: '生日彩蛋' },
    ];
    return defs.map((d) => {
      const used = b.used[d.id] || 0;
      const lim = b.limits[d.id] || 0;
      const pct = lim ? Math.min(100, (used / lim) * 100) : 0;
      const over = lim && used > lim;
      const warn = !over && lim && used / lim >= 0.85;
      return '<div class="ps-budget-row"><div class="ps-budget-top"><span>' + esc(d.label) + (d.note ? ' · ' + esc(d.note) : '') + '</span><b class="' + (over ? 'is-over' : '') + '">' + fmt(used) + ' / ' + fmt(lim) + '</b></div>'
        + '<div class="ps-bar ' + (over ? 'is-over' : warn ? 'is-warn' : '') + '"><i style="width:' + pct.toFixed(1) + '%"></i></div></div>';
    }).join('');
  }

  function previewWarnings(v) {
    const items = [];
    for (const e of v.errors || []) items.push('<div class="ps-warn danger">' + esc(e.msg || e) + '</div>');
    for (const w of v.warnings || []) items.push('<div class="ps-warn ' + esc(w.kind === 'info' ? 'info' : w.kind === 'draft' ? 'draft' : w.kind === 'merged' ? 'merged' : 'warn') + '">' + esc(w.msg || w) + '</div>');
    if (!items.length) return '<div class="ps-warn merged">结构检查通过：没有超限或预算警告。</div>';
    return items.join('');
  }

  function previewText() {
    return DRAFT ? PS.exportMarkdown(DRAFT, SCHEMA) : '';
  }

  function chapterForPath(path) {
    if (path === 'personaName' || /^persona\.(role|age|world)$/.test(path)) return 1;
    if (/^persona\.(traits|desire|fear)$/.test(path) || /^enhance\.(values|decide|stress|emotion)$/.test(path) || path === 'mbti.note') return 2;
    if (/^persona\.(tone|catch)$/.test(path) || /^enhance\.(speech|habits|meters)$/.test(path)) return 3;
    if (/^persona\.(logic|attitude|status)$/.test(path)) return 4;
    if (/^enhance\.(limits|secrets|relation|growth)$/.test(path)) return 5;
    return 6;
  }

  function validationIssues(v) {
    const rows = [];
    for (const e of (v.errors || []).slice(0, 4)) rows.push({ kind: 'error', path: e.path || '', msg: e.msg || String(e) });
    for (const w of (v.warnings || []).slice(0, 3)) rows.push({ kind: 'warn', path: w.path || '', msg: w.msg || String(w) });
    if (!rows.length) return '<li>没有阻断项；可以继续补细节，也可以直接交付。</li>';
    return rows.map((row) => '<li class="' + (row.kind === 'error' ? 'issue-error' : '') + '">'
      + (row.path
        ? '<button type="button" data-jump-path="' + esc(row.path) + '">' + esc(row.msg) + '</button>'
        : esc(row.msg))
      + '</li>').join('');
  }

  function previewHtml() {
    if (!DRAFT) return '<div class="ps-empty">正在读取底色…</div>';
    const swap = PREVIEW_TAB !== LAST_PREVIEW_TAB;
    LAST_PREVIEW_TAB = PREVIEW_TAB;
    const c = PS.compile(DRAFT, SCHEMA);
    const v = PS.validate(DRAFT, SCHEMA);
    const b = v.budget;
    const done = PS.completeness(DRAFT, SCHEMA);
    const doneCount = Object.values(done).filter(Boolean).length;
    const score = Math.round((doneCount / 6) * 100);
    const m = PS.mbtiInfo(DRAFT.fields.mbti.axes, SCHEMA);
    const bi = PS.birthdayInfo(DRAFT, SCHEMA);
    const name = String(DRAFT.personaName || '').trim() || '等待一个名字';
    const role = String(DRAFT.fields.persona.role || '').trim() || '你的角色，即将登场';
    const avatar = Array.from(String(DRAFT.personaName || '').trim() || '人')[0];
    const prompt = previewText();
    const tabs = [['prompt', '提示词'], ['runtime', '运行版'], ['budget', '预算']];
    let docTitle = 'PERSONA PROMPT';
    let docCount = fmt(PS.charCount(prompt)) + ' 字符';
    let docBody = '';
    if (PREVIEW_TAB === 'runtime') {
      const filledP = SCHEMA.personaKeys.filter((k) => String(DRAFT.fields.persona[k] || '').trim());
      const filledE = SCHEMA.enhanceKeys.filter((k) => String(DRAFT.fields.enhance[k] || '').trim());
      const filledS = SCHEMA.sceneKeys.filter((k) => String(DRAFT.fields.scenes[k] || '').trim());
      docTitle = 'RUNTIME FIELDS';
      docCount = c.mapped.length + ' 项';
      docBody = '<div class="preview-scroll"><div class="ps-report">'
        + '<div class="ps-report-row"><b>人格</b><span>' + filledP.length + ' / ' + SCHEMA.personaKeys.length + ' 项 · ' + fmt(filledP.reduce((n, k) => n + PS.charCount(DRAFT.fields.persona[k]), 0)) + ' 字</span></div>'
        + '<div class="ps-report-row"><b>增强项</b><span>' + filledE.length + ' / ' + SCHEMA.enhanceKeys.length + ' 项 · ' + fmt(filledE.reduce((n, k) => n + PS.charCount(DRAFT.fields.enhance[k]), 0)) + ' 字</span></div>'
        + '<div class="ps-report-row"><b>场景</b><span>' + filledS.length + ' / ' + SCHEMA.sceneKeys.length + ' 项 · ' + fmt(filledS.reduce((n, k) => n + PS.charCount(DRAFT.fields.scenes[k]), 0)) + ' 字</span></div>'
        + '<div class="ps-report-row"><b>MBTI</b><span>' + esc(m.type + ' · ' + m.name) + (c.included.mbti ? (DRAFT.fields.mbti.on ? ' · 会写入并注入' : ' · 会写入，不注入') : ' · 只在草稿里，不写入') + '</span></div>'
        + '<div class="ps-report-row"><b>生日</b><span>' + (bi.month && bi.day ? esc(bi.month + ' 月 ' + bi.day + ' 日 · ' + (bi.sign ? bi.sign.name : '待定') + (bi.animal ? ' · 生肖' + bi.animal : '')) : '未填写') + (c.included.birthday ? (DRAFT.fields.astroOn ? ' · 星座注入开' : ' · 星座只展示') : ' · 不写入') + '</span></div>'
        + '</div><div class="ps-budget-note">这是字段级预览；完整提示词以保存后「人格 → 系统提示词」页为准。</div></div>';
    } else if (PREVIEW_TAB === 'budget') {
      docTitle = 'CONTEXT BUDGET';
      docCount = fmt(b.used.persona) + ' / ' + fmt(b.limits.persona) + ' 字';
      docBody = '<div class="preview-scroll"><div class="ps-panel-head"><b>运行时预算</b><span>按原始字数</span></div>'
        + budgetRows(b)
        + '<div class="ps-budget-note">人格段预算 ' + fmt(b.limits.persona) + '；底子文件占 ' + fmt(b.base) + '，结构化字段可用约 ' + fmt(b.personaAvailable) + '。超预算不会拦保存，但提示词可能按行裁剪——导出前先看一眼。</div></div>';
    } else {
      docBody = '<pre id="personaPreview" class="persona-preview" tabindex="0" aria-label="实时生成的人设提示词">' + esc(prompt) + '</pre>';
    }
    const short = v.errors.length
      ? v.errors.length + ' 项基础信息还没填 · 点 ⓘ 查看并跳转。'
      : v.warnings.length
        ? v.warnings.length + ' 条可选建议 · 继续添一点角色细节。'
        : '设定已完整。现在可以带 TA 去认识新朋友了。';
    return '<div class="preview-top"><div><span class="section-kicker">02 / 实时人设预览</span><h2>一份独一无二的设定。</h2></div><span class="live-badge"><span aria-hidden="true"></span>实时整理</span></div>'
      + '<div class="preview-profile"><span class="profile-avatar" aria-hidden="true">' + esc(avatar) + '</span>'
      + '<div><strong class="ps-preview-name">' + esc(name) + '</strong><p title="' + esc(role) + '">' + esc(role) + '</p></div>'
      + '<span class="profile-star" aria-hidden="true">✦</span></div>'
      + '<div class="completeness"><div class="completeness-label"><span>设定完整度 <button type="button" class="help-button" id="btnValidation" aria-expanded="' + (VALIDATION_OPEN ? 'true' : 'false') + '" aria-label="查看人设完善建议">ⓘ</button></span><strong>' + score + '%</strong></div>'
      + '<div class="progress-track" role="progressbar" aria-label="设定完整度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + score + '"><span style="width:' + score + '%"></span></div>'
      + '<p>' + esc(short) + '</p></div>'
      + '<div class="validation-box" id="validationBox"' + (VALIDATION_OPEN ? '' : ' hidden') + '><h3>让设定更完整</h3><ul>' + validationIssues(v) + '</ul></div>'
      + '<div class="preview-tabs" role="tablist" aria-label="预览内容">' + tabs.map(([id, label]) => '<button class="preview-tab ' + (PREVIEW_TAB === id ? 'is-on' : '') + '" type="button" role="tab" aria-selected="' + (PREVIEW_TAB === id ? 'true' : 'false') + '" data-preview-tab="' + id + '">' + label + '</button>').join('') + '</div>'
      + '<div class="preview-document' + (swap ? ' is-swap' : '') + '"><div class="document-label"><span><span class="document-dot" aria-hidden="true"></span>' + docTitle + '</span><span>' + docCount + '</span></div>' + docBody + '</div>'
      + '<div class="preview-bottom"><p><span aria-hidden="true">✳</span> ' + (PREVIEW_TAB === 'prompt' ? '这是人设提示词，不是 AI 生成的试聊回复。' : '这是字段级预览，不是 AI 生成的试聊回复。') + '</p>'
      + '<div class="preview-actions"><button class="button button-copy" id="btnCopyPreview" type="button"><span aria-hidden="true">▢</span> 复制人设</button><button class="button button-download" id="btnDownloadPreview" type="button" aria-label="下载 Markdown 人设">↓ <span>导出 MD</span></button></div></div>';
  }

  function scrollActiveStep() {
    const rail = $('#chapterRail');
    const active = rail && rail.querySelector('.step.is-active');
    if (!rail || !active || rail.scrollWidth <= rail.clientWidth + 1) return;
    const left = active.offsetLeft - (rail.clientWidth - active.offsetWidth) / 2;
    rail.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
  }

  function renderRail() {
    const done = DRAFT ? PS.completeness(DRAFT, SCHEMA) : {};
    $('#chapterRail').innerHTML = PS.CHAPTERS.map((ch) => {
      const active = CHAPTER === ch.id;
      return '<button class="step ' + (active ? 'is-active ' : '') + (done[ch.id] ? 'is-visited' : '') + '" type="button"'
        + (active ? ' aria-current="step"' : '')
        + ' data-action="chapter" data-value="' + ch.id + '"><span class="step-number">' + ch.id + '</span><span>' + esc(STEP_LABELS[ch.id] || ch.title) + '</span></button>';
    }).join('');
    requestAnimationFrame(scrollActiveStep);
  }

  function renderEditor() {
    if (!DRAFT) { $('#editor').innerHTML = '<div class="ps-empty">正在读取底色…</div>'; return; }
    $('#editor').innerHTML = editorHtml();
    if (FOCUS_AFTER_RENDER) {
      const sel = FOCUS_AFTER_RENDER;
      FOCUS_AFTER_RENDER = '';
      requestAnimationFrame(() => { try { const el = $(sel); if (el) el.focus(); } catch { /* ignore */ } });
    }
  }

  function renderPreview() {
    const old = $('#personaPreview');
    const top = old ? old.scrollTop : 0;
    $('#preview').innerHTML = previewHtml();
    const next = $('#personaPreview');
    if (next) next.scrollTop = top;
  }

  function renderFooter() {
    $('#btnPrev').disabled = CHAPTER <= 1;
    $('#stepCounter').textContent = CHAPTER + ' / 6 · ' + (STEP_LABELS[CHAPTER] || '');
    $('#btnNext').textContent = CHAPTER >= 6 ? '交付这份人设  ↗' : '下一步：' + (STEP_LABELS[CHAPTER + 1] || '') + '  →';
  }

  function renderAll() {
    renderRail();
    renderEditor();
    renderPreview();
    renderFooter();
  }

  function goChapter(n) {
    const next = Math.max(1, Math.min(6, Number(n) || 1));
    STEP_DIR = next >= CHAPTER ? 1 : -1;
    CHAPTER = next;
    renderAll();
  }

  function setStatus(kind) {
    const el = $('#draftState');
    const store = $('#storageStatus');
    if (!el) return;
    if (kind === 'dirty') {
      el.textContent = '有未保存改动';
      el.classList.add('is-dirty');
      if (store) store.textContent = '有改动，正在自动保存…';
      return;
    }
    el.classList.remove('is-dirty');
    if (kind === 'saved' && SAVED && SAVED.savedAt) {
      const time = new Date(SAVED.savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      el.textContent = '草稿已保存 · ' + time;
      if (store) store.textContent = '已自动保存 · ' + time + ' · 只在本机，不会上传。';
      return;
    }
    el.textContent = '新草稿';
    if (store) store.textContent = '草稿只保存在这台设备；不会上传。';
  }

  function setMode() {
    const el = $('#modeState');
    if (!el) return;
    el.innerHTML = '<span aria-hidden="true"></span>' + (MODE === 'online' ? '在线 · 已读控制台' : '离线预览 · 内置基线');
    el.classList.toggle('is-offline', MODE !== 'online');
  }

  function showDraftBanner() {
    if (!SAVED || !SAVED.savedAt) return;
    const d = new Date(SAVED.savedAt);
    const when = Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const name = String(SAVED.draft?.personaName || '').trim() || '未命名草稿';
    const title = $('#draftBannerTitle');
    const detail = $('#draftBannerDetail');
    if (title) title.textContent = '已恢复上次的草稿「' + name + '」';
    if (detail) detail.textContent = (when ? when + ' · ' : '') + '仅保存在这台设备';
    const banner = $('#draftBanner');
    if (banner) banner.hidden = false;
  }

  function hideDraftBanner() {
    const banner = $('#draftBanner');
    if (banner) banner.hidden = true;
  }

  function saveNow() {
    if (!DRAFT) return;
    const ok = storageSet(DRAFT_KEY, JSON.stringify({ version: PS.VERSION, draft: DRAFT, savedAt: Date.now() }));
    if (ok) {
      SAVED = { draft: PS.clone(DRAFT), savedAt: Date.now() };
      setStatus('saved');
      hideDraftBanner();
    } else {
      setStatus('dirty');
      showToast('浏览器没有允许写入本地草稿；请先导出 JSON 备份。', 'bad');
    }
  }
  function scheduleSave() {
    setStatus('dirty');
    hideDraftBanner();
    clearTimeout(SAVE_TIMER);
    SAVE_TIMER = setTimeout(saveNow, 600);
  }
  function schedulePreview() {
    clearTimeout(PREVIEW_TIMER);
    PREVIEW_TIMER = setTimeout(() => { if (DRAFT) { renderPreview(); renderFooter(); } }, 120);
  }

  function showToast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' is-' + kind : '');
    el.hidden = false;
    clearTimeout(TOAST_TIMER);
    TOAST_TIMER = setTimeout(() => { el.hidden = true; }, 3200);
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function safeName() {
    return String(DRAFT.personaName || '未命名人设').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40);
  }
  function dateTag() {
    return new Date().toLocaleDateString('sv-SE');
  }
  async function copyPreview() {
    if (!DRAFT) return;
    const text = previewText();
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch { /* file:// 或受限环境走下面的本地回退 */ }
    if (!copied) {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.setAttribute('aria-label', '待复制的人设文本');
      document.body.appendChild(area);
      area.select();
      try { copied = document.execCommand('copy'); } catch { copied = false; }
      area.remove();
    }
    if (!copied) {
      showToast('浏览器没有允许自动复制；请选中右侧预览文字手动复制。', 'bad');
      return;
    }
    const v = PS.validate(DRAFT, SCHEMA);
    showToast(v.errors.length ? '草稿已复制；仍有 ' + v.errors.length + ' 项基础信息没填。' : '人设提示词已复制。', 'ok');
    const btn = $('#btnCopyPreview');
    if (btn) {
      const original = btn.innerHTML;
      clearTimeout(COPY_TIMER);
      btn.classList.add('is-copied');
      btn.innerHTML = '<span aria-hidden="true">✓</span> 已复制';
      COPY_TIMER = setTimeout(() => {
        btn.classList.remove('is-copied');
        if (btn.isConnected) btn.innerHTML = original;
      }, 1400);
    }
  }
  function downloadPreview() {
    if (!DRAFT) return;
    download(safeName() + '-' + dateTag() + '.md', previewText(), 'text/markdown;charset=utf-8');
    showToast('已下载 Markdown 人设。', 'ok');
  }

  /* ── 控制台桥：只读父页面 token + 保存条状态，写仍走唯一写口 /api/config ──
     工厂作为「工厂 → 人设工厂」二级页在 same-origin iframe 里运行：父页面
     <meta name="panel-token"> 是面板鉴权的唯一注入点。直接打开 /persona-factory.html
     或离线打开时拿不到 token，这时只保留导出，不提供任何直写。 */
  function hostPanel() {
    try {
      if (window.parent && window.parent !== window && window.parent.document) return window.parent;
    } catch { /* 跨域或 file:// */ }
    return null;
  }
  function hostToken() {
    const panel = hostPanel();
    if (!panel) return '';
    const token = String(panel.document.querySelector('meta[name="panel-token"]')?.content || '').trim();
    return token && token !== '__QQBOT_PANEL_TOKEN__' ? token : '';
  }
  function hostSavebarDirty() {
    const panel = hostPanel();
    if (!panel) return false;
    const bar = panel.document.getElementById('savebar');
    return !!bar && !bar.hidden;
  }
  async function postConfig(payload) {
    const token = hostToken();
    if (!token) throw new Error('没有拿到面板 token；请从控制台「工厂 → 人设工厂」打开。');
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(payload),
    });
    let data = null;
    try { data = await r.json(); } catch { /* 非 JSON 时下面统一报错 */ }
    if (!r.ok || !data || data.ok !== true) throw new Error((data && data.error) || ('HTTP ' + r.status));
    return data;
  }
  function showHostDirty() {
    openModal({
      title: '控制台还有未保存改动',
      subtitle: '为了不覆盖你正在编辑的草稿，先回控制台处理保存条。',
      body: '<p class="ps-hint">先回控制台点底部的「保存并生效」或「丢弃」，再重新打开人设工厂。工厂不会替你决定丢掉哪一边。</p>',
      footer: '<button class="ps-btn" type="button" data-modal-action="__close">知道了</button>',
    });
    MODAL_ACTIONS = { __close: closeModal };
  }
  function buildCard(existing) {
    const c = PS.compile(DRAFT, SCHEMA);
    const fields = {};
    for (const k of PS.PERSONA_KEYS) fields[k] = c.custom.persona[k] || '';
    for (const k of PS.ENHANCE_KEYS) fields[k] = c.custom.enhance[k] || '';
    fields.scenes = { ...c.custom.scenes };
    const baseName = (DRAFT.personaName || '未命名人设').trim().slice(0, 40) || '未命名人设';
    let name = baseName;
    const names = new Set((existing || []).map((s) => s && s.name).filter(Boolean));
    let i = 2;
    while (names.has(name)) { name = baseName + ' ' + i; i += 1; }
    return {
      id: 'k' + Date.now().toString(36), kind: 'persona', name, enabled: true,
      scope: { type: 'global', id: '' }, triggers: [], background: '', examples: [], fields,
    };
  }
  async function readHostState() {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (!r.ok) throw new Error('读不到控制台状态（HTTP ' + r.status + '）');
    return r.json();
  }
  async function saveCardDirect() {
    if (!DRAFT) return;
    const v = PS.validate(DRAFT, SCHEMA);
    if (v.errors.length) { showToast('先处理阻断错误再存卡。', 'bad'); return; }
    if (hostSavebarDirty()) { closeModal(); showHostDirty(); return; }
    if (!hostToken()) { showToast('没有拿到面板 token；请从控制台「工厂 → 人设工厂」打开。', 'bad'); return; }
    const btn = $('#modalRoot [data-modal-action="save-card"]');
    if (btn) btn.disabled = true;
    try {
      const state = await readHostState();
      const skills = Array.isArray(state?.custom?.skills) ? state.custom.skills : [];
      const card = buildCard(skills);
      await postConfig({ custom: { skills: [...skills, card] } });
      closeModal();
      showResult('已存为角色卡', '「' + esc(card.name) + '」已写入。回到控制台后，去「记忆 → 知识包与角色卡」就能看到它；套用后仍要保存。');
    } catch (e) {
      if (btn) btn.disabled = false;
      showToast('存卡失败：' + e.message, 'bad');
    }
  }
  async function buildApplyPatch(mode) {
    const c = PS.compile(DRAFT, SCHEMA);
    const state = await readHostState();
    const current = state?.custom || {};
    const patch = { custom: {} };
    if (DRAFT.personaName.trim()) patch.personaName = DRAFT.personaName.trim();
    const put = (group, key, val, cur) => {
      const v = String(val || '');
      if (!v) return;
      if (mode === 'fill' && String(cur || '').trim()) return;
      patch.custom[group] = patch.custom[group] || {};
      patch.custom[group][key] = v;
    };
    for (const k of PS.PERSONA_KEYS) put('persona', k, c.custom.persona[k], current.persona?.[k]);
    for (const k of PS.ENHANCE_KEYS) put('enhance', k, c.custom.enhance[k], current.enhance?.[k]);
    for (const k of PS.SCENE_KEYS) put('scenes', k, c.custom.scenes[k], current.scenes?.[k]);
    patch.custom.replyStyle = { length: c.custom.replyStyle.length };
    if (c.included.mbti) {
      if (mode === 'overwrite' || (!current.mbti?.on && !String(current.mbti?.note || '').trim())) {
        patch.custom.mbti = c.custom.mbti;
      }
    }
    if (c.included.birthday) {
      if (mode === 'overwrite' || !(current.birthday?.month && current.birthday?.day)) {
        patch.custom.birthday = c.custom.birthday;
        patch.custom.astroOn = c.custom.astroOn;
      }
    }
    if (mode === 'overwrite') {
      patch.custom.persona = { ...c.custom.persona };
      patch.custom.enhance = { ...c.custom.enhance };
      patch.custom.scenes = { ...c.custom.scenes };
    }
    return { patch, compiled: c };
  }
  async function applyDirect(mode) {
    if (!DRAFT) return;
    const v = PS.validate(DRAFT, SCHEMA);
    if (v.errors.length) { showToast('先处理阻断错误再应用。', 'bad'); return; }
    if (hostSavebarDirty()) { showHostDirty(); return; }
    if (!hostToken()) { showToast('没有拿到面板 token；请从控制台「工厂 → 人设工厂」打开。', 'bad'); return; }
    const btn = $('#modalRoot [data-modal-action="apply-' + mode + '"]');
    if (btn) btn.disabled = true;
    try {
      const { patch } = await buildApplyPatch(mode);
      const meaningful = ['persona', 'enhance', 'scenes', 'mbti', 'birthday'].some((k) => patch.custom[k]);
      if (mode === 'fill' && !meaningful) {
        if (btn) btn.disabled = false;
        showToast('没有可填的空字段；要用工厂内容覆盖，请选「覆盖当前人格」。', 'bad');
        return;
      }
      const r = await postConfig(patch);
      closeModal();
      showResult('已应用到当前人格', '写入已完成。回到控制台后约 3 秒，控制台会刷新到新人格；旧会话按「改人设后丢弃旧发言」的设置处理。' + (r && r.applied === false ? ' 机器人还没读入新配置，稍后看「运行 → 总览」的生效时间。' : ''));
    } catch (e) {
      if (btn) btn.disabled = false;
      showToast('应用失败：' + e.message, 'bad');
    }
  }
  function openApplyConfirm() {
    if (hostSavebarDirty()) { closeModal(); showHostDirty(); return; }
    openModal({
      title: '应用到现在的人格？',
      subtitle: '这一步会写入 config.json 并立即生效，不是写进草稿。',
      body: '<div class="ps-report">'
        + '<div class="ps-report-row"><b>只填空</b><span>只把当前人格里还空着的字段补上；已经写过的内容一律不动。推荐先试这个。</span></div>'
        + '<div class="ps-report-row is-warn"><b>覆盖</b><span>用工厂里的值覆盖当前人格的全部人格 / 增强 / 场景字段；空字段也会把原来的内容清空。</span></div>'
        + '</div><p class="ps-hint" style="margin-top:12px">改人格会改变 personaFingerprint；旧会话是否丢弃取决于「人格 → 人设」里的「改人设后丢弃旧发言」。想先留一份，请用「存为角色卡」。</p>',
      footer: '<button class="ps-btn" type="button" data-modal-action="__close">取消</button>'
        + '<button class="ps-btn" type="button" data-modal-action="apply-fill">只填空</button>'
        + '<button class="ps-btn danger" type="button" data-modal-action="apply-overwrite">覆盖当前人格</button>',
    });
    MODAL_ACTIONS = {
      __close: closeModal,
      'apply-fill': () => applyDirect('fill'),
      'apply-overwrite': () => applyDirect('overwrite'),
    };
  }
  function showResult(title, body) {
    openModal({
      title,
      subtitle: '可以回到人格总览查看',
      body: '<p class="ps-hint">' + body + '</p>',
      footer: '<button class="ps-btn" type="button" data-modal-action="__close">继续编辑</button>'
        + (hostPanel() ? '<button class="ps-btn primary" type="button" data-modal-action="close-overlay">回到人格总览</button>' : ''),
    });
    MODAL_ACTIONS = {
      __close: closeModal,
      'close-overlay': () => {
        closeModal();
        hostPanel()?.postMessage({ source: 'estrella-factory', action: 'panel.goto', group: 'persona', sub: 'overview' }, location.origin);
      },
    };
  }

  function openModal(cfg) {
    MODAL_ACTIONS = cfg.actions || {};
    const root = $('#modalRoot');
    root.hidden = false;
    root.innerHTML = '<div class="ps-modal" role="dialog" aria-modal="true" aria-labelledby="psModalTitle">'
      + '<div class="ps-modal-head"><div class="ps-modal-head-copy"><h2 id="psModalTitle">' + esc(cfg.title || '') + '</h2>'
      + (cfg.subtitle ? '<p>' + esc(cfg.subtitle) + '</p>' : '') + '</div>'
      + '<button class="ps-icon-btn" type="button" data-modal-action="__close" aria-label="关闭">×</button></div>'
      + '<div class="ps-modal-body">' + (cfg.body || '') + '</div>'
      + '<div class="ps-modal-actions">' + (cfg.footer || '<button class="ps-btn" type="button" data-modal-action="__close">关闭</button>') + '</div></div>';
    const first = root.querySelector('.ps-modal-actions .ps-btn, .ps-modal-actions button, .ps-modal-body button');
    if (first) requestAnimationFrame(() => first.focus());
  }
  function closeModal() {
    const root = $('#modalRoot');
    root.hidden = true;
    root.innerHTML = '';
    MODAL_ACTIONS = {};
  }

  function draftHasContent() {
    if (!DRAFT) return false;
    const p = DRAFT.fields.persona || {};
    return !!(String(DRAFT.personaName || '').trim() || String(p.role || '').trim() || String(p.traits || '').trim() || String(p.tone || '').trim());
  }
  function confirmReplace() {
    if (!EDITED || !draftHasContent()) return true;
    return window.confirm('当前草稿有改动；替换后不会保留这一版。确定继续？');
  }
  function startWithDraft(draft, note, save) {
    DRAFT = draft;
    STEP_DIR = 1;
    CHAPTER = 1;
    PREVIEW_TAB = 'prompt';
    VALIDATION_OPEN = false;
    FOCUS_AFTER_RENDER = '';
    EDITED = false;
    PS.applyAnswers(DRAFT);
    hideDraftBanner();
    renderAll();
    setMode();
    if (save === false) setStatus('new');
    else saveNow();
    if (note) showToast(note, 'ok');
  }
  function startNew(presetId) {
    const preset = PS.PRESETS.find((p) => p.id === presetId);
    startWithDraft(PS.createDraft(presetId), preset ? '已套用「' + preset.name + '」。继续改成你自己的角色。' : '已开始新草稿。');
  }
  function startBlank() {
    startWithDraft(PS.createDraft('blank'), null, false);
    showToast('已回到空白草稿；修改前不会覆盖上次保存。', 'ok');
  }
  function startCurrent() {
    if (!STATE) { showToast('现在连不上控制台，先用底色或空白开始。', 'bad'); return; }
    const d = PS.fromState(STATE);
    if (!d.personaName) d.personaName = '';
    startWithDraft(d, '已从当前人格复制一份草稿；不会自动写回控制台。');
  }
  function startContinue() {
    if (!SAVED) { showToast('没有找到上次的草稿。', 'bad'); return; }
    startWithDraft(PS.clone(SAVED.draft), '已载入上次草稿。');
  }
  function resetDraft() {
    if (!confirmReplace()) return;
    startWithDraft(PS.createDraft('blank'), null, false);
    showToast('已回到空白草稿；修改前不会覆盖上次保存。', 'ok');
  }
  function handleStart(btn) {
    const kind = btn.dataset.start;
    if (kind === 'preset') {
      if (!confirmReplace()) return;
      startNew(btn.dataset.value);
      return;
    }
    if (kind === 'blank') {
      if (!confirmReplace()) return;
      startBlank();
      return;
    }
    if (kind === 'current') {
      if (!confirmReplace()) return;
      startCurrent();
      return;
    }
    if (kind === 'card') {
      openCards();
    }
  }
  function onDraftBannerClick(ev) {
    const btn = ev.target.closest('[data-draft-action]');
    if (!btn) return;
    if (btn.dataset.draftAction === 'fresh') resetDraft();
    else hideDraftBanner();
  }

  function openCards() {
    const cards = (STATE?.custom?.skills || []).filter((s) => s && s.kind === 'persona');
    if (!cards.length) { showToast('当前没有角色卡。先在「记忆 → 知识包与角色卡」建一张，或从底色开始。', 'bad'); return; }
    openModal({
      title: '从角色卡开始',
      subtitle: '角色卡里存的是人格 11 项 + 增强 12 项 + 场景 9 项；MBTI 和生日会沿用当前人格。',
      body: '<div class="ps-report">' + cards.map((c, i) => '<button class="ps-report-row" type="button" data-card-index="' + i + '" style="text-align:left;cursor:pointer"><b>' + esc(c.name || '未命名卡') + '</b><span>' + esc((c.scope?.type || 'global')) + ' · ' + Object.keys(c.fields || {}).length + ' 项快照</span></button>').join('') + '</div>',
      footer: '<button class="ps-btn" type="button" data-modal-action="__close">取消</button>',
    });
    MODAL_ACTIONS = {
      __close: closeModal,
    };
    // 卡片按钮由全局点击处理（见下方 data-card-index）
    window.__psCards = cards;
  }

  function openQuiz() {
    QUIZ = { EI: null, SN: null, TF: null, JP: null };
    const qs = [
      { axis: 'EI', q: '周末更想怎么过？', left: '和人出去', right: '自己待着', leftLetter: 'E', rightLetter: 'I' },
      { axis: 'SN', q: '听到一个新点子，你先？', left: '问细节和例子', right: '想它还能变成什么', leftLetter: 'S', rightLetter: 'N' },
      { axis: 'TF', q: '朋友难过时，你更先？', left: '讲清道理和下一步', right: '先照顾感受', leftLetter: 'T', rightLetter: 'F' },
      { axis: 'JP', q: '出门旅行，你更习惯？', left: '提前排好', right: '走到哪算哪', leftLetter: 'J', rightLetter: 'P' },
    ];
    const body = '<div class="ps-quiz">' + qs.map((q) => '<div class="ps-quiz-q" data-quiz-q="' + q.axis + '"><b>' + q.q + '</b><div class="ps-quiz-opts">'
      + '<button class="ps-chip" type="button" data-quiz-axis="' + q.axis + '" data-quiz-value="left" data-quiz-letter="' + q.leftLetter + '">' + q.leftLetter + ' · ' + q.left + '</button>'
      + '<button class="ps-chip" type="button" data-quiz-axis="' + q.axis + '" data-quiz-value="right" data-quiz-letter="' + q.rightLetter + '">' + q.rightLetter + ' · ' + q.right + '</button>'
      + '</div></div>').join('') + '<div class="ps-budget-note">这不是心理测评，只是帮你想清楚表达倾向；选完还可以拖四轴微调。</div></div>';
    openModal({
      title: '4 个小问题',
      subtitle: '凭第一反应选，不用想太久。',
      body,
      footer: '<button class="ps-btn" type="button" data-modal-action="__close">取消</button><button class="ps-btn primary" type="button" data-modal-action="quiz-apply" disabled>按选择设置四轴</button>',
    });
    MODAL_ACTIONS = {
      __close: closeModal,
      'quiz-apply': () => {
        if (Object.values(QUIZ).some((v) => v == null)) return;
        const axes = {};
        for (const [axis, val] of Object.entries(QUIZ)) axes[axis] = val === 'left' ? 35 : 65;
        DRAFT.fields.mbti.axes = { ...DRAFT.fields.mbti.axes, ...axes };
        DRAFT.answers.mbtiTouched = true;
        closeModal();
        renderEditor();
        renderPreview();
        scheduleSave();
        showToast('已按四个选择设置四轴；可以继续拖滑块微调。', 'ok');
      },
    };
  }

  function updateQuizUi() {
    $$('#modalRoot [data-quiz-axis]').forEach((btn) => {
      const axis = btn.dataset.quizAxis;
      const val = btn.dataset.quizValue;
      const on = QUIZ[axis] === val;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const apply = $('#modalRoot [data-modal-action="quiz-apply"]');
    if (apply) apply.disabled = Object.values(QUIZ).some((v) => v == null);
  }

  function openDelivery() {
    if (!DRAFT) return;
    const v = PS.validate(DRAFT, SCHEMA);
    const c = PS.compile(DRAFT, SCHEMA);
    const canWrite = !!hostToken();
    const extras = Object.entries(DRAFT.extras || {}).filter(([, x]) => String(x || '').trim());
    const bounds = DRAFT.answers?.bounds || [];
    const errorRows = (v.errors || []).map((e) => '<div class="ps-report-row is-error"><b>待修</b><span>' + esc(e.msg || e) + '</span></div>').join('');
    const warnRows = (v.warnings || []).map((w) => '<div class="ps-report-row is-warn"><b>提醒</b><span>' + esc(w.msg || w) + '</span></div>').join('');
    const summary = '<div class="ps-report">'
      + '<div class="ps-report-row is-ok"><b>会写入</b><span>' + c.mapped.length + ' 个运行时字段（人格 / 增强 / 场景 / MBTI / 生日）</span></div>'
      + '<div class="ps-report-row"><b>可选层</b><span>MBTI：' + (c.included.mbti ? '会写进导出' : '没打开注入/没写备注，不写') + '；生日：' + (c.included.birthday ? '会写进导出' : '没填，不写') + '。这样不会把你当前人格里已有的设置清成默认值。</span></div>'
      + '<div class="ps-report-row"><b>只留草稿</b><span>' + (extras.length ? extras.length + ' 条作者备注不会进入运行时；导出 JSON 会保留。' : '没有作者备注。') + '</span></div>'
      + '<div class="ps-report-row"><b>已合并</b><span>' + (bounds.length ? bounds.length + ' 条安全边界会合并进「底线与禁忌」。' : '没有额外合并项。') + '</span></div>'
      + '<div class="ps-report-row"><b>预算</b><span>人格 ' + fmt(v.budget.used.persona) + ' / ' + fmt(v.budget.limits.persona) + ' · 增强 ' + fmt(v.budget.used.enhance) + ' / ' + fmt(v.budget.limits.enhance) + ' · 场景 ' + fmt(v.budget.used.scenes) + ' / ' + fmt(v.budget.limits.scenes) + '</span></div>'
      + '</div>';
    const writeNote = canWrite
      ? '<div class="ps-budget-note" style="margin-top:12px"><b>存为角色卡</b>不会切换当前人格；<b>应用到当前人格</b>会立即写入 config.json 并生效。应用前建议先存一张卡留底。</div>'
      : '<div class="ps-budget-note" style="margin-top:12px">这个页面没有拿到面板 token（可能是直接打开或离线打开）。请用控制台「工厂 → 人设工厂」打开，或先把 JSON 导出，在控制台「人格 → 导入」载入。</div>';
    const body = summary + '<div style="margin-top:12px" class="ps-report">' + (errorRows + warnRows || '<div class="ps-report-row is-ok"><b>检查</b><span>没有超限、没有预算警告。</span></div>') + '</div>' + writeNote;
    const footer = v.errors.length
      ? '<button class="ps-btn" type="button" data-modal-action="__close">返回修改</button>'
      : (canWrite
        ? '<button class="ps-btn" type="button" data-modal-action="export-json">下载 JSON</button>'
          + '<button class="ps-btn" type="button" data-modal-action="export-md">Markdown</button>'
          + '<button class="ps-btn" type="button" data-modal-action="apply-open">应用到当前人格</button>'
          + '<button class="ps-btn primary" type="button" data-modal-action="save-card">存为角色卡</button>'
        : '<button class="ps-btn" type="button" data-modal-action="copy-json">复制 JSON</button>'
          + '<button class="ps-btn" type="button" data-modal-action="export-md">下载 Markdown</button>'
          + '<button class="ps-btn primary" type="button" data-modal-action="export-json">下载工作台 JSON</button>');
    openModal({
      title: '交付这份人设',
      subtitle: DRAFT.personaName || '未命名人设',
      body,
      footer,
    });
    MODAL_ACTIONS = {
      __close: closeModal,
      'save-card': () => saveCardDirect(),
      'apply-open': () => openApplyConfirm(),
      'export-json': () => {
        if (v.errors.length) return;
        download(safeName() + '-' + dateTag() + '.json', JSON.stringify(PS.exportJson(DRAFT, SCHEMA), null, 2), 'application/json;charset=utf-8');
        showToast('已下载工作台 JSON。', 'ok');
      },
      'export-md': () => {
        if (v.errors.length) return;
        download(safeName() + '-' + dateTag() + '.md', PS.exportMarkdown(DRAFT, SCHEMA), 'text/markdown;charset=utf-8');
        showToast('已下载 Markdown。', 'ok');
      },
      'copy-json': async () => {
        if (v.errors.length) return;
        try {
          await navigator.clipboard.writeText(JSON.stringify(PS.exportJson(DRAFT, SCHEMA), null, 2));
          showToast('JSON 已复制。', 'ok');
        } catch {
          showToast('这个环境不允许剪贴板；请用「下载工作台 JSON」。', 'bad');
        }
      },
    };
  }

  function resetChapter() {
    if (!DRAFT) return;
    const base = DRAFT.base?.fields || PS.normalizeFields({});
    const paths = CHAPTER_FIELDS[CHAPTER].slice();
    if (CHAPTER === 1) {
      DRAFT.personaName = '';
      DRAFT.fields.birthday = PS.clone(base.birthday || { age: 0, month: 0, day: 0 });
      DRAFT.fields.astroOn = base.astroOn === true;
    }
    if (CHAPTER === 2) {
      DRAFT.fields.mbti = PS.clone(base.mbti || { on: false, axes: { EI: 62, SN: 58, TF: 57, JP: 46 }, note: '' });
      DRAFT.answers.traits = PS.splitTraits(base.persona.traits);
      DRAFT.answers.mbtiTouched = false;
    }
    if (CHAPTER === 3) { DRAFT.answers.tone = 'base'; DRAFT.answers.humor = 'base'; DRAFT.answers.length = base.replyStyle.length; }
    if (CHAPTER === 4) { DRAFT.answers.groupRole = 'base'; DRAFT.answers.conflict = 'base'; }
    if (CHAPTER === 5) { DRAFT.answers.bounds = []; DRAFT.answers.closeness = 'base'; }
    for (const p of paths) {
      const val = PS.getPath(base, p);
      PS.setPath(DRAFT.fields, p, val === undefined ? '' : val);
      if (DRAFT.meta?.sources) DRAFT.meta.sources[p] = 'preset';
    }
    PS.applyAnswers(DRAFT, false);
    renderAll();
    scheduleSave();
    showToast('已恢复本章的预设内容。', 'ok');
  }

  function onEditorInput(ev) {
    const el = ev.target.closest('[data-path]');
    if (!el || !DRAFT) return;
    EDITED = true;
    const path = el.dataset.path;
    PS.setField(DRAFT, path, el.value);
    if (path === 'persona.traits') DRAFT.answers.traits = PS.splitTraits(el.value);
    if (path === 'mbti.note') DRAFT.answers.mbtiTouched = true;
    updateFieldUi(el);
    updateTraitChips();
    schedulePreview();
    scheduleSave();
  }

  function updateFieldUi(el) {
    const path = el.dataset.path;
    const field = el.closest('.ps-field');
    const lim = PS.limitOf(SCHEMA, path);
    const count = PS.charCount(el.value);
    const over = count > lim;
    if (field) field.classList.add('is-user');
    el.classList.toggle('is-error', over);
    const counter = field && field.querySelector('[data-count-for="' + cssEsc(path) + '"]');
    if (counter) {
      counter.textContent = fmt(count) + ' / ' + fmt(lim);
      counter.classList.toggle('is-over', over);
    }
    const err = field && field.querySelector('[data-error-for="' + cssEsc(path) + '"]');
    if (err) err.hidden = !over;
  }
  function updateTraitChips() {
    if (!DRAFT) return;
    const selected = DRAFT.answers.traits || [];
    $$('#editor [data-action="trait"]').forEach((btn) => {
      const on = selected.includes(btn.dataset.value);
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function onEditorChange(ev) {
    const el = ev.target;
    if (!DRAFT) return;
    EDITED = true;
    if (el.matches('[data-birthday]')) {
      const key = el.dataset.birthday;
      const b = DRAFT.fields.birthday;
      if (key === 'month') {
        b.month = Number(el.value) || 0;
        if (b.day && b.day > maxDay(b.month)) b.day = maxDay(b.month);
      } else if (key === 'day') {
        b.day = Number(el.value) || 0;
      } else {
        b.age = Math.max(0, Math.min(120, Math.round(Number(el.value) || 0)));
      }
      const block = $('#birthdayBlock');
      if (block) block.outerHTML = birthdayBlock();
      renderPreview();
      scheduleSave();
      return;
    }
    if (el.matches('[data-action="mbti-type-select"]')) {
      const type = el.value;
      DRAFT.fields.mbti.axes = PS.axesForType(type);
      DRAFT.answers.mbtiTouched = true;
      const block = $('#mbtiBlock');
      if (block) block.outerHTML = mbtiBlock();
      renderPreview();
      scheduleSave();
    }
  }

  function onEditorClick(ev) {
    const startBtn = ev.target.closest('[data-start]');
    if (startBtn) { handleStart(startBtn); return; }
    const btn = ev.target.closest('[data-action]');
    if (!btn || !DRAFT) return;
    const action = btn.dataset.action;
    const value = btn.dataset.value;
    if (action === 'chapter') {
      goChapter(Number(value) || 1);
      return;
    }
    if (action === 'mbti-quiz') { openQuiz(); return; }
    EDITED = true;
    if (action === 'reset-chapter') { resetChapter(); return; }
    if (action === 'reset-field') {
      const path = btn.dataset.path;
      PS.resetField(DRAFT, path);
      renderEditor();
      renderPreview();
      scheduleSave();
      return;
    }
    if (action === 'trait') {
      const list = DRAFT.answers.traits || [];
      const i = list.indexOf(value);
      if (i >= 0) list.splice(i, 1); else if (list.length < 6) list.push(value);
      else { showToast('最多先选 6 个；再多就变成标签墙了。', 'bad'); return; }
      DRAFT.answers.traits = list;
      forceSources(['persona.traits']);
      PS.applyAnswers(DRAFT);
      FOCUS_AFTER_RENDER = '#editor [data-action="trait"][data-value="' + cssEsc(value) + '"]';
      renderEditor();
      renderRail();
      renderPreview();
      scheduleSave();
      return;
    }
    if (action === 'tone' || action === 'humor' || action === 'length' || action === 'group' || action === 'conflict' || action === 'closeness') {
      const key = action === 'group' ? 'groupRole' : action;
      DRAFT.answers[key] = value;
      if (action === 'tone') forceSources(['persona.tone']);
      if (action === 'humor' || action === 'length') forceSources(['enhance.speech']);
      if (action === 'group') forceSources(['persona.logic', 'persona.attitude']);
      if (action === 'conflict') forceSources(['enhance.stress']);
      if (action === 'closeness') forceSources(['enhance.relation']);
      PS.applyAnswers(DRAFT);
      FOCUS_AFTER_RENDER = '#editor [data-action="' + action + '"][data-value="' + cssEsc(value) + '"]';
      renderEditor();
      renderRail();
      renderPreview();
      scheduleSave();
      return;
    }
    if (action === 'bound') {
      const list = DRAFT.answers.bounds || [];
      const i = list.indexOf(value);
      if (i >= 0) list.splice(i, 1); else list.push(value);
      DRAFT.answers.bounds = list;
      forceSources(['enhance.limits']);
      PS.applyAnswers(DRAFT);
      FOCUS_AFTER_RENDER = '#editor [data-action="bound"][data-value="' + cssEsc(value) + '"]';
      renderEditor();
      renderPreview();
      scheduleSave();
      return;
    }
    if (action === 'mbti-toggle') {
      DRAFT.fields.mbti.on = !DRAFT.fields.mbti.on;
      DRAFT.answers.mbtiTouched = true;
      const block = $('#mbtiBlock');
      if (block) block.outerHTML = mbtiBlock();
      renderPreview();
      scheduleSave();
      return;
    }
    if (action === 'astro-toggle') {
      DRAFT.fields.astroOn = !DRAFT.fields.astroOn;
      const block = $('#birthdayBlock');
      if (block) block.outerHTML = birthdayBlock();
      renderPreview();
      scheduleSave();
      return;
    }
    if (action === 'mbti-quiz') { openQuiz(); return; }
  }

  function onEditorAxis(ev) {
    const el = ev.target.closest('[data-axis]');
    if (!el || !DRAFT) return;
    EDITED = true;
    const axis = el.dataset.axis;
    DRAFT.fields.mbti.axes[axis] = Number(el.value) || 0;
    DRAFT.answers.mbtiTouched = true;
    const row = el.closest('[data-axis-row]');
    if (row) {
      const heads = row.querySelectorAll('.ps-axis-head');
      const v = Number(el.value) || 0;
      if (heads[0]) heads[0].innerHTML = '<span><b class="' + (v >= 50 ? '' : 'is-on') + '">' + (SCHEMA.mbti.axes.find((a) => a.id === axis)?.left || '') + '</b> ' + (SCHEMA.mbti.axes.find((a) => a.id === axis)?.leftName || '') + ' ' + (100 - v) + '%</span><span><b class="' + (v >= 50 ? 'is-on' : '') + '">' + (SCHEMA.mbti.axes.find((a) => a.id === axis)?.right || '') + '</b> ' + (SCHEMA.mbti.axes.find((a) => a.id === axis)?.rightName || '') + ' ' + v + '%</span>';
    }
    const card = $('#mbtiTypeCard');
    if (card) {
      const m = PS.mbtiInfo(DRAFT.fields.mbti.axes, SCHEMA);
      card.innerHTML = '<div class="ps-type-code">' + esc(m.type) + '</div><div class="ps-type-copy"><div class="ps-type-name">' + esc(m.name) + '</div><div class="ps-type-tag">' + esc(m.tag) + '</div><div class="ps-type-traits">' + (m.traits || []).map((t) => '<span>' + esc(t) + '</span>').join('') + '</div></div>';
      const sel = $('#mbtiBlock [data-action="mbti-type-select"]');
      if (sel) sel.value = m.type;
    }
    schedulePreview();
    scheduleSave();
  }

  function onModalClick(ev) {
    const root = $('#modalRoot');
    if (ev.target === root) { closeModal(); return; }
    const cardBtn = ev.target.closest('[data-card-index]');
    if (cardBtn) {
      const idx = Number(cardBtn.dataset.cardIndex);
      const cards = window.__psCards || [];
      const card = cards[idx];
      if (card) {
        closeModal();
        if (!confirmReplace()) return;
        startWithDraft(PS.fromCard(card, STATE), '已从角色卡「' + (card.name || '未命名') + '」开始。');
      }
      return;
    }
    const quizBtn = ev.target.closest('[data-quiz-axis]');
    if (quizBtn) {
      QUIZ[quizBtn.dataset.quizAxis] = quizBtn.dataset.quizValue;
      updateQuizUi();
      return;
    }
    const actionBtn = ev.target.closest('[data-modal-action]');
    if (!actionBtn) return;
    const action = actionBtn.dataset.modalAction;
    if (action === '__close') { closeModal(); return; }
    const fn = MODAL_ACTIONS[action];
    if (fn) fn();
  }

  async function boot() {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const s = await r.json();
      if (!s || !s.customMeta) throw new Error('state 缺少 customMeta');
      STATE = s;
      SCHEMA = PS.schemaFromState(s);
      MODE = 'online';
    } catch {
      STATE = null;
      SCHEMA = PS.clone(PS.FALLBACK_SCHEMA);
      MODE = 'offline';
    }
    SAVED = loadSaved();
    setMode();

    const params = new URLSearchParams(location.search);
    const presetParam = params.get('preset');
    let draft = null;
    let restored = false;
    if (presetParam && PS.PRESETS.some((p) => p.id === presetParam)) {
      draft = PS.createDraft(presetParam);
    } else if (params.get('blank') === '1') {
      draft = PS.createDraft('blank');
    } else if (params.get('continue') === '1' && SAVED) {
      draft = PS.clone(SAVED.draft);
    } else if (SAVED) {
      draft = PS.clone(SAVED.draft);
      restored = true;
    } else {
      draft = PS.createDraft('blank');
    }
    DRAFT = draft;
    PS.applyAnswers(DRAFT);
    EDITED = false;
    renderAll();
    if (restored) {
      setStatus('saved');
      showDraftBanner();
    } else {
      setStatus('new');
    }

    // 测试钩子：只读状态 + 少量可控动作；不暴露任何配置写入。
    window.__personaStudio = {
      state: () => ({ mode: MODE, chapter: CHAPTER, hasDraft: !!DRAFT, previewTab: PREVIEW_TAB, saved: !!SAVED }),
      draft: () => (DRAFT ? PS.clone(DRAFT) : null),
      schema: () => PS.clone(SCHEMA),
      start: (id) => startNew(id),
      startBlank: () => startBlank(),
      reset: () => resetDraft(),
      exportJson: () => (DRAFT ? PS.exportJson(DRAFT, SCHEMA) : null),
      validate: () => (DRAFT ? PS.validate(DRAFT, SCHEMA) : null),
      setField: (path, value) => {
        if (!DRAFT) return null;
        EDITED = true;
        PS.setField(DRAFT, path, value);
        renderEditor();
        renderPreview();
        scheduleSave();
        return true;
      },
      go: (n) => { goChapter(n); },
      closeModal,
    };
  }

  function loadSaved() {
    try {
      const raw = JSON.parse(storageGet(DRAFT_KEY) || 'null');
      if (!raw || raw.version !== PS.VERSION || !raw.draft) return null;
      const d = raw.draft;
      d.fields = PS.normalizeFields(d.fields);
      if (!d.base || !d.base.fields) d.base = { fields: PS.clone(d.fields), answers: PS.clone(d.answers || {}), mbti: PS.clone(d.fields.mbti), birthday: PS.clone(d.fields.birthday), astroOn: d.fields.astroOn, replyStyle: PS.clone(d.fields.replyStyle) };
      d.answers = d.answers || { traits: PS.splitTraits(d.fields.persona.traits), tone: 'base', humor: 'base', length: d.fields.replyStyle.length, groupRole: 'base', conflict: 'base', closeness: 'base', bounds: [] };
      d.extras = d.extras || { pronouns: '', appearance: '', interests: '', notes: '' };
      d.meta = d.meta || { sources: {} };
      d.meta.sources = d.meta.sources || {};
      return { draft: d, savedAt: raw.savedAt || 0 };
    } catch { return null; }
  }

  // 事件接线
  $('#btnNew')?.addEventListener('click', resetDraft);
  $('#btnPrev')?.addEventListener('click', () => { if (CHAPTER > 1) goChapter(CHAPTER - 1); });
  $('#btnNext')?.addEventListener('click', () => {
    if (CHAPTER < 6) goChapter(CHAPTER + 1);
    else openDelivery();
  });
  $('#btnDeliver')?.addEventListener('click', openDelivery);
  $('#btnSaveDraft')?.addEventListener('click', () => { saveNow(); showToast('草稿已保存在这台设备。', 'ok'); });
  $('#btnLoadDraft')?.addEventListener('click', () => { if (confirmReplace()) startContinue(); });
  $('#btnResetDraft')?.addEventListener('click', resetDraft);
  $('#draftBanner')?.addEventListener('click', onDraftBannerClick);
  $('#editor')?.addEventListener('input', onEditorInput);
  $('#editor')?.addEventListener('change', onEditorChange);
  $('#editor')?.addEventListener('click', onEditorClick);
  $('#editor')?.addEventListener('input', onEditorAxis);
  $('#preview')?.addEventListener('click', (ev) => {
    const tab = ev.target.closest('[data-preview-tab]');
    if (tab) {
      PREVIEW_TAB = tab.dataset.previewTab;
      renderPreview();
      requestAnimationFrame(() => { const t = $('#preview [data-preview-tab="' + PREVIEW_TAB + '"]'); if (t) t.focus(); });
      return;
    }
    if (ev.target.closest('#btnCopyPreview')) { copyPreview(); return; }
    if (ev.target.closest('#btnDownloadPreview')) { downloadPreview(); return; }
    if (ev.target.closest('#btnValidation')) {
      VALIDATION_OPEN = !VALIDATION_OPEN;
      renderPreview();
      return;
    }
    const jump = ev.target.closest('[data-jump-path]');
    if (jump) {
      const path = jump.dataset.jumpPath;
      FOCUS_AFTER_RENDER = '#editor [data-path="' + cssEsc(path) + '"]';
      goChapter(chapterForPath(path));
    }
  });
  $('#preview')?.addEventListener('keydown', (ev) => {
    const tab = ev.target.closest('[data-preview-tab]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
    ev.preventDefault();
    const tabs = $$('#preview [data-preview-tab]');
    const i = tabs.indexOf(tab);
    let next = i;
    if (ev.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    if (ev.key === 'ArrowRight') next = (i + 1) % tabs.length;
    if (ev.key === 'Home') next = 0;
    if (ev.key === 'End') next = tabs.length - 1;
    const target = tabs[next];
    if (!target) return;
    PREVIEW_TAB = target.dataset.previewTab;
    renderPreview();
    requestAnimationFrame(() => { const t = $('#preview [data-preview-tab="' + PREVIEW_TAB + '"]'); if (t) t.focus(); });
  });
  $('#chapterRail')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action="chapter"]');
    if (!btn) return;
    goChapter(Number(btn.dataset.value) || 1);
  });
  $('#chapterRail')?.addEventListener('keydown', (ev) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(ev.key)) return;
    ev.preventDefault();
    let next = CHAPTER;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') next = Math.min(6, CHAPTER + 1);
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') next = Math.max(1, CHAPTER - 1);
    if (ev.key === 'Home') next = 1;
    if (ev.key === 'End') next = 6;
    goChapter(next);
    const btn = $('#chapterRail [data-action="chapter"][data-value="' + CHAPTER + '"]');
    if (btn) btn.focus();
  });
  $('#modalRoot')?.addEventListener('click', onModalClick);
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!$('#modalRoot').hidden) { closeModal(); return; }
    if (VALIDATION_OPEN) { VALIDATION_OPEN = false; renderPreview(); }
  });
  window.addEventListener('beforeunload', () => {
    if (DRAFT && (EDITED || draftHasContent())) saveNow();
  });
  let RESIZE_TIMER = 0;
  window.addEventListener('resize', () => {
    clearTimeout(RESIZE_TIMER);
    RESIZE_TIMER = setTimeout(scrollActiveStep, 100);
  });

  boot();
})();
