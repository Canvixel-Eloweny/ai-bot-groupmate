export function setup(api) {
  api.registerTool({
    id: 'ping',
    description: '混合型样例工具',
    parameters: { type: 'object', properties: {} },
    execute: () => 'pong',
  });
}

export const hooks = {
  'after-response': () => {},
};
