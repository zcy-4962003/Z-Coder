// 组装运行时：Provider、权限、Skills、MCP、结果落盘、Goal、子 Agent 和 root Agent

import { Agent } from './agent.js';
import type { Config } from './config.js';
import { createProvider } from './config.js';
import { GoalManager } from './goal.js';
import { loadMcpConfigs, McpManager } from './mcp/manager.js';
import { Permissions, type PermissionMode, type Prompter } from './permissions.js';
import { buildSystemPrompt, buildWorkerPrompt } from './prompt.js';
import { ResultStore } from './results.js';
import type { Runtime } from './runtime.js';
import { discoverSkills, skillRoots } from './skills.js';
import { WorkerManager } from './subagents.js';
import { rootTools, workerTools } from './tools/index.js';
import type { AgentView } from './view.js';

export const VERSION = '0.3.0';

export interface BootstrapOptions {
  config: Config;
  cwd: string;
  mode: PermissionMode;
  view: AgentView;
  prompter: Prompter | null;
  askUser: Runtime['askUser'];
}

export function bootstrap(opts: BootstrapOptions): { runtime: Runtime; agent: Agent } {
  const { config, cwd } = opts;
  const results = new ResultStore(cwd, config.toolResultLimit);
  results.cleanup();
  const skills = discoverSkills(cwd);

  const runtime: Runtime = {
    cwd,
    provider: createProvider(config),
    permissions: new Permissions(opts.mode, opts.prompter),
    maxTokens: config.maxTokens,
    contextLimit: config.contextLimit,
    plan: { items: [], explanation: '' },
    skills,
    mcp: new McpManager(loadMcpConfigs(cwd, config.mcpServers), cwd, VERSION),
    results,
    goal: new GoalManager(),
    workers: null,
    askUser: opts.askUser,
    trustedReadRoots: [results.dir, ...skillRoots(cwd).map((r) => r.dir)],
    webSearch: config.webSearch,
  };
  runtime.workers = new WorkerManager(runtime, () => workerTools(runtime), () => buildWorkerPrompt(runtime));

  const agent = new Agent({
    runtime,
    view: opts.view,
    agentId: 'root',
    tools: () => rootTools(runtime),
    systemPrompt: () => buildSystemPrompt(runtime),
  });
  return { runtime, agent };
}
