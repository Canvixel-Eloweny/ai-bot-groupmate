/**
 * Win-v0.1.2 移植 · §128「好友私聊 / 夜间产出 / 巡逻热度」的定向变异（2026-10-21）。
 */
export default [
  {
    id: 'A1',
    note: '把夜间 owner 判定写死 false —— §128 的 owner 豁免判据应红',
    file: 'src/index.js',
    anchor: /const toOwner = isNightly\(s\) && nightlyTargetOf\(s\) === 'owner';/g,
    count: 1,
    apply: (s) => s.replace("const toOwner = isNightly(s) && nightlyTargetOf(s) === 'owner';", 'const toOwner = false;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'A2',
    note: '摘掉 tick 里的巡逻调用 —— §128 的「巡逻挂既有 tick」判据应红',
    file: 'src/index.js',
    anchor: /if \(runPatrolTick\(now\.getTime\(\)\) > 0\) return;/g,
    count: 1,
    apply: (s) => s.replace('if (runPatrolTick(now.getTime()) > 0) return;', 'if (false) return;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'A3',
    note: '把好友闸改成恒真 —— §128 的 isFriend 接线判据应红（陌生人也能私聊）',
    file: 'src/brain.js',
    anchor: /return isFriend\(this\.friendIds, evt\?\.user_id\);/g,
    count: 1,
    apply: (s) => s.replace('return isFriend(this.friendIds, evt?.user_id);', 'return true;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'A4',
    note: 'owner 投递也去记群账 —— §128 的「不记假群账」判据应红',
    file: 'src/index.js',
    anchor: /if \(!toOwner\) brain\.markReplied\(sessionOfGroup\(item\.group\)\);/g,
    count: 1,
    apply: (s) => s.replace('if (!toOwner) brain.markReplied(sessionOfGroup(item.group));', 'brain.markReplied(sessionOfGroup(item.group));'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
