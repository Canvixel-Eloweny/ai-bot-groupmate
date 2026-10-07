/**
 * 用真实 Chromium（headless shell）点一遍控制台，验证三件用户直接报的事：
 *   ① 技能 / 知识包 / 角色卡点得动（以前点了没反应）
 *   ② 「保存」不再弹"还在读服务端配置"，而是给出圆绿勾
 *   ③ 能力开关两处都是 4 个且同步
 * 顺带存三张截图当证据。
 *
 * 用 CDP 直连而不是 playwright：playwright 的 npm 包没装（只缓存了浏览器二进制），
 * 而 Node 22 自带全局 WebSocket，直接说协议就够了。
 *
 * ⚠️ 第 11 轮（M-07）：CDP 脚手架（启动 / 连接 / send / evalJs / shot / 收尾）**搬到
 *    `lib/cdp.mjs`**，两支 e2e 脚本共用一份 —— 此前这里与 `browser-restart-verify.mjs`
 *    各抄了一份逐字重复的实现（约 70–90 行）。
 * ⚠️ 本脚本需要面板正在 `127.0.0.1:8788` 上跑；**不进 `npm test`**。
 */
import { launchCdp, makeCounter, sleep } from './lib/cdp.mjs';

const PORT = 9333;
const PANEL = 'http://127.0.0.1:8788';
const OUT = '/tmp/qqbot-shots';

const { check, counts } = makeCounter();

const { evalJs, shot, close } = await launchCdp({
  port: PORT,
  panelUrl: PANEL,
  outDir: OUT,
  userDataDir: '/tmp/cdp-profile-qqbot',
  extraArgs: ['--no-default-browser-check'],
  preOverrideMs: 3500,   // 等首屏 refresh + 轮询把工作台铺好
  postOverrideMs: 1200,
  captureBeyondViewport: true,
});

console.log('【真浏览器 1】页面基本可用');
{
  check('页面没有 JS 异常', await evalJs('true'));
  check('/api/state 已经拿到（工作台有本地副本）', await evalJs('!!wbCustom && !!lastState.custom'));
  check('面板自检没有报「旧代码」', await evalJs("document.getElementById('panelStale').style.display === 'none'"));
}

console.log('\n【真浏览器 2】能力开关：机器人设置 4 个');
{
  const st = await evalJs(`(() => {
    const row = document.getElementById('featRow');
    const boxes = [...row.querySelectorAll('input[type=checkbox]')];
    window.__scrollTo = () => document.getElementById('sec-setup').scrollIntoView({block:'start'});
    return boxes.map((b) => (b.dataset.feat || b.dataset.mirror) + '=' + b.checked);
  })()`);
  check('机器人设置里有 4 个能力开关', st.length === 4, st.join(' '));
  check('其中一个是主动发言（allowProactive）', st.some((x) => x.startsWith('allowProactive')), st.join(' '));
  await evalJs('document.getElementById("featRow").closest(".sect").scrollIntoView({block:"center"})');
  await sleep(500);
  await shot('1-机器人设置-能力开关.png', '#featRow');
}

console.log('\n【真浏览器 3】能力开关：自定义工作台 4 个 + 与上面同步');
{
  await evalJs('document.querySelector("#wbMenu button[data-wb=\\"caps\\"]").click()');
  await sleep(600);
  const st = await evalJs(`(() => {
    const row = document.getElementById('wbFeatRow');
    return [...row.querySelectorAll('input[type=checkbox]')].map((b) => (b.dataset.feat || b.dataset.mirror) + '=' + b.checked);
  })()`);
  check('工作台里也有 4 个能力开关', st.length === 4, st.join(' '));
  const same = await evalJs(`(() => {
    const k = (row) => [...document.querySelectorAll(row + ' input[type=checkbox]')]
      .map((b) => (b.dataset.feat || b.dataset.mirror) + '=' + b.checked).sort().join('|');
    return k('#featRow') === k('#wbFeatRow');
  })()`);
  check('★ 两处的 4 个开关键名与勾选状态完全一致（用户报的"不同步"）', same === true);
  await evalJs('document.getElementById("wbFeatRow").scrollIntoView({block:"center"})');
  await sleep(500);
  await shot('2-工作台-能力开关.png', '#wbFeatRow');
}

console.log('\n【真浏览器 4】技能 / 知识包 / 角色卡 —— 用户报的"点不了"');
{
  await evalJs('document.querySelector("#wbMenu button[data-wb=\\"skills\\"]").click()');
  await sleep(400);
  const before = await evalJs('document.querySelectorAll("#wbSkillList .wb-skill").length');
  await evalJs('window.wbAddSkill("pack")');
  await sleep(500);
  const afterPack = await evalJs('document.querySelectorAll("#wbSkillList .wb-skill").length');
  check('★ 点「加知识包」真的出现了一条技能（以前静默无反应）', afterPack === before + 1, `${before} → ${afterPack}`);

  await evalJs('window.wbAddSkill("persona")');
  await sleep(500);
  const afterCard = await evalJs('document.querySelectorAll("#wbSkillList .wb-skill").length');
  check('★ 点「加角色卡」也出现了（第 2 条）', afterCard === before + 2, `${before} → ${afterCard}`);
  check('角色卡带「从当前人设存进这张卡 / 套用到人格设定」两个按钮',
    await evalJs('document.querySelector("#wbSkillList").innerHTML.includes("从当前人设存进这张卡")'));

  await evalJs('window.wbSkillDel(1); window.wbSkillDel(0)');
  await sleep(400);
  check('能从页面移除（× 不是死的）',
    await evalJs('document.querySelectorAll("#wbSkillList .wb-skill").length') === before);
  await evalJs('document.getElementById("wbSkillList").scrollIntoView({block:"center"})');
  await sleep(400);
}

console.log('\n【真浏览器 5】点「保存」→ 圆绿勾（用户报的第 3 件事）');
{
  const toastBefore = await evalJs('document.getElementById("toast").textContent');
  await evalJs('window.wbSave()');
  // 绿勾 2.4 秒后会自动淡出（失败的红叉不会），所以断言和截图都必须在这之前做
  await sleep(1300);
  await evalJs('document.querySelector(".wb-dl").scrollIntoView({block:"center"})');
  await sleep(300);
  const ind = await evalJs('document.getElementById("wbSaveInd").className');
  const toast = await evalJs('document.getElementById("toast").textContent');
  check('★ 结果指示变成圆绿勾（.save-ind.ok 且可见）',
    /(^| )ok( |$)/.test(ind) && /show/.test(ind), ind);
  check('★ 不再出现"还在读服务端配置，等一两秒再点"', !/等一两秒/.test(toast), toast);
  check('toast 说的是保存成功', /保存/.test(toast), `${toast}（上一次：${toastBefore}）`);
  await shot('3-保存成功-圆绿勾.png', '.wb-dl');
}

console.log('\n【真浏览器 6】回复长短的选项确实来自后端下发的表');
{
  await evalJs('document.querySelector("#wbMenu button[data-wb=\\"reply\\"]").click()');
  await sleep(400);
  const r = await evalJs(`(() => {
    const t = lastState.customMeta.replyLengths;
    const rs = [...document.querySelectorAll('#wbLenRow input[name=wbLen]')];
    return { n: rs.length, keys: rs.map((x) => x.value).join(','), labels: rs.map((x) => x.closest('label').textContent.trim()).join(','),
             want: Object.keys(t).join(','), wantLabels: Object.values(t).map((v) => v.label).join(',') };
  })()`);
  check('选项数量 / 键名 / 标签都与后端表一致',
    r.n === r.want.split(',').length && r.keys === r.want && r.labels === r.wantLabels, JSON.stringify(r));
}

const { pass, fail } = counts();
console.log(`\n──────── 真浏览器：${pass} 通过 / ${fail} 失败 ────────`);
close();
process.exit(fail ? 1 : 0);
