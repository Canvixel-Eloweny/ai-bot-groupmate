/**
 * Windows VM 的开机自启验收（B1a）。
 *
 * 用法：node verify-autostart.mjs <installRoot> [shortcutName]
 * 默认用 `Estrella Bot-B1Test.lnk`，绝不覆盖用户已有的 `Estrella Bot.lnk`。
 */

import { execFileSync } from 'node:child_process';
import { readAutostartState, setAutostart } from '../../src/desktop/autostart.js';

const installRoot = process.argv[2] || '';
const shortcutName = process.argv[3] || 'Estrella Bot-B1Test.lnk';
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder';

const out = { installRoot, shortcutName };
try {
  out.state0 = readAutostartState({ shortcutName });
  out.on = setAutostart(true, { installRoot, shortcutName });
  out.state1 = readAutostartState({ shortcutName });
  execFileSync('reg', ['add', REG_KEY, '/v', shortcutName, '/t', 'REG_BINARY', '/d', '03000000', '/f'], {
    windowsHide: true, timeout: 5000,
  });
  out.state2 = readAutostartState({ shortcutName });
} finally {
  out.off = setAutostart(false, { installRoot, shortcutName });
  out.state3 = readAutostartState({ shortcutName });
}

console.log(JSON.stringify(out, null, 2));
if (out.state1.state !== 'on') throw new Error(`开启后状态应为 on，实际 ${out.state1.state}`);
if (out.state2.state !== 'blocked') throw new Error(`写 0x03 后状态应为 blocked，实际 ${out.state2.state}`);
if (out.state3.state !== 'off') throw new Error(`关闭后状态应为 off，实际 ${out.state3.state}`);
