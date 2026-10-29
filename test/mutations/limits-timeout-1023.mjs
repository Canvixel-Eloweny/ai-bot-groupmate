/**
 * §144–§145「技能/记忆预算 + 钩子超时」的定向变异（2026-10-23）。
 *
 * 每条只打一个失效面；全部 BLOCKED 才说明这两段不是假绿。
 * 跑法（⚠️ 串行；会改写真实工作树，跑完按提示还原，或 `--restore`）：
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/limits-timeout-1023.mjs --layer check-wb
 *   NODE_OPTIONS= node scripts/mutate.mjs test/mutations/limits-timeout-1023.mjs --layer smoke
 */
export default [
  {
    id: 'L1',
    note: 'skillItems 又按 20 条截断 —— §144② 必须变红。预期 BLOCKED',
    file: 'src/custom-config.js',
    anchor: /\.\.\.\(it\.kind === 'persona' \? \{ fields: cardFields\(it\.fields\) \} : \{\}\),\n    \}\);/,
    count: 1,
    apply: (s) => s.replace(
      "...(it.kind === 'persona' ? { fields: cardFields(it.fields) } : {}),\n    });",
      "...(it.kind === 'persona' ? { fields: cardFields(it.fields) } : {}),\n    });\n    if (out.length >= 20) break;"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L2',
    note: 'memoryItems 又按 60 条截断 —— §144② 必须变红。预期 BLOCKED',
    file: 'src/custom-config.js',
    anchor: /\(it\.from === undefined \? \{\} : \{ from: str\(it\.from, 40\) \}\),\n    \}\);/,
    count: 1,
    apply: (s) => s.replace(
      "(it.from === undefined ? {} : { from: str(it.from, 40) }),\n    });",
      "(it.from === undefined ? {} : { from: str(it.from, 40) }),\n    });\n    if (out.length >= 60) break;"
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L3',
    note: 'pickSkillsForPrompt 忽略传入的 max（恒用默认 3）—— T433 必须变红。预期 BLOCKED',
    file: 'src/skills.js',
    anchor: /if \(out\.length >= maxSkills\) break;/,
    count: 1,
    apply: (s) => s.replace('if (out.length >= maxSkills) break;', 'if (out.length >= SKILL_IN_PROMPT) break;'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L4',
    note: 'activeManualMemory 忽略 promptMax（恒用 12）—— T434 必须变红。预期 BLOCKED',
    file: 'src/custom-config.js',
    anchor: /const cap = numOr\('memoryPromptMax', custom\?\.memory\?\.promptMax\);/,
    count: 1,
    apply: (s) => s.replace(
      "const cap = numOr('memoryPromptMax', custom?.memory?.promptMax);",
      'const cap = MANUAL_MEMORY_IN_PROMPT;'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L5',
    note: '超时哨兵不再被识别（setTimeout resolve null）—— T432 必须变红。预期 BLOCKED',
    file: 'src/hook-bus.js',
    anchor: /setTimeout\(\(\) => resolve\(TIMED_OUT\), cap\)/,
    count: 1,
    apply: (s) => s.replace('setTimeout(() => resolve(TIMED_OUT), cap)', 'setTimeout(() => resolve(null), cap)'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L6',
    note: 'index.js 不把 hookTimeoutMs 注入总线 —— §145③ 必须变红。预期 BLOCKED',
    file: 'src/index.js',
    anchor: /createHookBus\(\{\n\s*log,\n\s*timeoutMs: cfg\.custom\?\.extensions\?\.hookTimeoutMs \?\? cfg\.custom\?\.plugins\?\.hookTimeoutMs,\n\s*\}\)/,
    count: 1,
    apply: (s) => s.replace(
      /createHookBus\(\{\n\s*log,\n\s*timeoutMs: cfg\.custom\?\.extensions\?\.hookTimeoutMs \?\? cfg\.custom\?\.plugins\?\.hookTimeoutMs,\n\s*\}\)/,
      'createHookBus({ log })'
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L7',
    note: '发布模板删掉 hookTimeoutMs —— §145⑤ 必须变红。预期 BLOCKED',
    file: 'config.example.json',
    anchor: /"hookTimeoutMs": 5000/,
    count: 1,
    apply: (s) => s.replace('"hookTimeoutMs": 5000', '"hookTimeoutMs_removed": 5000'),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
  {
    id: 'L8',
    note: 'readCustom 不返回 skillPrompt —— §144③ 必须变红。预期 BLOCKED',
    file: 'src/custom-config.js',
    anchor: /skillPrompt: \{\n      max: numOr\('skillPromptMax', c\.skillPrompt\?\.max\),\n      chars: numOr\('skillPromptChars', c\.skillPrompt\?\.chars\),\n    \},/,
    count: 1,
    apply: (s) => s.replace(
      "    skillPrompt: {\n      max: numOr('skillPromptMax', c.skillPrompt?.max),\n      chars: numOr('skillPromptChars', c.skillPrompt?.chars),\n    },\n",
      ''
    ),
    layer: 'check-wb',
    expect: 'BLOCKED',
  },
];
