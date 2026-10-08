/**
 * 真机端到端验收：直接打真人面板的接口，走"改 → 落盘 → 读回来 → 还原"一整圈。
 *
 * 安全策略：开工前把**整个 custom 对象**存下来，收尾时原样 POST 回去
 * （后端 patchCustom 是深合并 + 归一化，整份回灌 = 精确还原）。
 * 中途任何一步炸掉都不会留下半截状态 —— 收尾放在 finally 里。
 */
const BASE = 'http://127.0.0.1:8788';

const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return { status: r.status, data: await r.json() };
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};

const st0 = await get('/api/state');
const ORIGINAL_CUSTOM = JSON.parse(JSON.stringify(st0.custom));
console.log(`改动前：allowProactive=${ORIGINAL_CUSTOM.allowProactive}｜回复长短=${ORIGINAL_CUSTOM.replyStyle.length}`
  + `｜技能 ${(ORIGINAL_CUSTOM.skills || []).length} 条｜手动记忆 ${(ORIGINAL_CUSTOM.memory.manual || []).length} 条`);

try {
  console.log('\n【真机 1】主动发言总闸（本轮新加的字段）能不能改');
  {
    const off = await post('/api/config', { custom: { allowProactive: false } });
    let st = await get('/api/state');
    check('关掉它：接口 ok，真机读回来是 false',
      off.status === 200 && off.data.ok === true && st.custom.allowProactive === false,
      JSON.stringify(off.data).slice(0, 140));
    const on = await post('/api/config', { custom: { allowProactive: true } });
    st = await get('/api/state');
    check('再打开：接口 ok，读回来是 true', on.data.ok === true && st.custom.allowProactive === true);
  }

  console.log('\n【真机 2】技能（知识包）能不能存 —— 用户报的"点不了"就是这一步');
  {
    const skill = {
      id: 'verify-e2e', kind: 'pack', name: '验收用知识包', enabled: true,
      scope: { type: 'global', id: '' }, triggers: ['验收'], background: '这是一条临时技能，跑完会删掉', examples: [],
    };
    const r = await post('/api/config', { custom: { skills: [...(st0.custom.skills || []), skill] } });
    const st = await get('/api/state');
    const got = (st.custom.skills || []).find((s) => s.id === 'verify-e2e');
    check('知识包存得进去并读得回来', r.data.ok === true && !!got, (st.custom.skills || []).map((s) => s.name).join(','));
    check('触发词 / 背景 / 范围都没丢',
      got?.triggers?.join(',') === '验收' && got?.background?.includes('临时技能') && got?.scope?.type === 'global',
      JSON.stringify(got || {}).slice(0, 160));
  }

  console.log('\n【真机 3】角色卡（带 12 项人格快照）也能存');
  {
    const st1 = await get('/api/state');
    const card = {
      id: 'verify-card', kind: 'persona', name: '验收用角色卡', enabled: true,
      scope: { type: 'global', id: '' }, triggers: [], background: '',
      examples: [], fields: { age: '看起来 20 岁', tone: '话少' },
    };
    const r = await post('/api/config', { custom: { skills: [...(st1.custom.skills || []), card] } });
    const st = await get('/api/state');
    const got = (st.custom.skills || []).find((s) => s.id === 'verify-card');
    check('角色卡存得进去，人格快照跟着一起存', r.data.ok === true && got?.fields?.tone === '话少',
      JSON.stringify(got?.fields || {}));
    check('两类技能同时存在（1 知识包 + 1 角色卡）', (st.custom.skills || []).length === 2,
      String((st.custom.skills || []).length));
  }

  console.log('\n【真机 4】「全区通用保存」：一次请求改多个区块');
  {
    const st1 = await get('/api/state');
    const r = await post('/api/config', {
      custom: {
        skills: st1.custom.skills,
        replyStyle: { ...st1.custom.replyStyle, length: 'long' },
        persona: { ...st1.custom.persona, tone: '验收时写的语气' },
        scenes: { ...st1.custom.scenes, typo: '验收场景内容' },
        memory: { ...st1.custom.memory, manual: [{ id: 'verify-m1', text: '验收记忆', on: true, t: Date.now() }] },
      },
    });
    const st = await get('/api/state');
    check('一次请求同时改到 4 个区块（回复长短 / 人格 / 特殊场景 / 自我记忆）',
      r.data.ok === true
      && st.custom.replyStyle.length === 'long'
      && st.custom.persona.tone === '验收时写的语气'
      && st.custom.scenes.typo === '验收场景内容'
      && (st.custom.memory.manual || []).some((m) => m.id === 'verify-m1'),
      JSON.stringify({
        len: st.custom.replyStyle.length, tone: st.custom.persona.tone,
        typo: st.custom.scenes.typo, mem: (st.custom.memory.manual || []).length,
      }));
  }

  console.log('\n【真机 5】导入前预览接口活着（第 31 轮新增；旧面板里它 404）');
  {
    const r = await post('/api/custom/preview', { persona: { traits: '预览用' } });
    const keys = Object.keys(r.data || {});
    check('/api/custom/preview 有响应', r.status === 200 && keys.length > 0, `status=${r.status} keys=${keys.join(',')}`);
  }

  console.log('\n【真机 6】面板自检与重启接口（幂等，不能真重启）');
  {
    const st = await get('/api/state');
    check('state 下发 panel，且 stale=false（代码是新的）',
      !!st.panel && st.panel.stale === false, JSON.stringify(st.panel));
    const pid0 = st.panel.pid;
    const r = await post('/api/panel/restart', {});
    const st2 = await get('/api/state');
    check('重启接口在没有新代码时不动手（restarted:false）', r.data.ok === true && r.data.restarted === false,
      JSON.stringify(r.data).slice(0, 130));
    check('调用后面板还是同一个进程', st2.panel?.pid === pid0, `${pid0} → ${st2.panel?.pid}`);
  }
} finally {
  console.log('\n【还原】把整份 custom 原样回灌');
  const r = await post('/api/config', { custom: ORIGINAL_CUSTOM });
  const st = await get('/api/state');
  const same = JSON.stringify(st.custom) === JSON.stringify(ORIGINAL_CUSTOM);
  check('custom 逐字节还原（含技能 / 记忆 / 回复长短 / 人格 / 场景）', r.data.ok === true && same,
    same ? '' : `diff: 技能${(st.custom.skills || []).length}条 记忆${(st.custom.memory.manual || []).length}条 len=${st.custom.replyStyle.length}`);
}

console.log(`\n──────── 真机验收：${pass} 通过 / ${fail} 失败 ────────`);
process.exit(fail ? 1 : 0);
