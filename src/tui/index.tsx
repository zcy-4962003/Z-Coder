import { render } from 'ink';
import type { Agent } from '../agent.js';
import type { Runtime } from '../runtime.js';
import type { Session } from '../session.js';
import { App } from './App.js';
import type { BannerInfo } from './components.js';
import { Controller } from './controller.js';
import type { UIStore } from './store.js';

export function startTui(opts: { store: UIStore; agent: Agent; runtime: Runtime; session: Session; banner: BannerInfo }): void {
  const { store, agent, runtime, session, banner } = opts;
  store.push({ kind: 'banner' });
  if (agent.messages.length) store.replay(agent.messages);

  let instance: ReturnType<typeof render> | undefined;
  const controller = new Controller(store, agent, runtime, session, () => {
    instance?.unmount();
    process.stdout.write('\nBye!\n');
    process.exit(0);
  });

  // MCP 在后台连接，不阻塞界面；连接失败只提示，不影响其它功能
  if (runtime.mcp.clients.length) {
    void runtime.mcp.startAll().then(() => {
      const failed = runtime.mcp.clients.filter((c) => c.status === 'failed');
      if (failed.length) store.print(`⚠ MCP server(s) failed to connect: ${failed.map((c) => c.name).join(', ')} — see /mcp`, 'warn');
    });
  }

  instance = render(<App controller={controller} banner={banner} />, { exitOnCtrlC: false });
}
