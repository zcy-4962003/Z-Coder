#!/usr/bin/env node
// Coder —— 一个迷你版 Claude Code 风格的终端编程 Agent

import { parseArgs } from 'node:util';
import { bootstrap, VERSION } from './bootstrap.js';
import { loadConfig } from './config.js';
import type { Message } from './llm/types.js';
import type { PermissionMode } from './permissions.js';
import { Session } from './session.js';
import { c, errorMessage } from './ui.js';
import { ConsoleView } from './view.js';

const HELP = `${c.bold('coder')} - a mini coding agent for your terminal

${c.bold('Usage')}
  coder [options]              start an interactive session (TUI)
  coder -p "prompt"            run once and exit (print mode)
  echo "prompt" | coder -p     read the prompt from stdin

${c.bold('Options')}
  -p, --print                  non-interactive: run the prompt and exit
  -c, --continue               resume the most recent session in this directory
  -r, --resume <ref>           resume a session by number, id or name (see /sessions)
  -m, --model <name>           model to use
      --provider <name>        anthropic | openai (OpenAI-compatible APIs)
      --accept-edits           auto-approve file edits inside the working directory
      --yolo                   auto-approve everything except dangerous operations
  -h, --help                   show help
  -v, --version                show version

${c.bold('Environment')}
  ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL     for --provider anthropic
  OPENAI_API_KEY    / OPENAI_BASE_URL        for --provider openai
  CODER_PROVIDER, CODER_MODEL, CODER_API_KEY, CODER_BASE_URL, CODER_MAX_TOKENS, CODER_CONTEXT_LIMIT
  CODER_TOOL_RESULT_LIMIT                     tool results larger than this (chars) are saved to disk (default 20000)
  CODER_WEB_SEARCH, TAVILY_API_KEY, BRAVE_API_KEY   web search provider (default: auto, falls back to Bing)
  CODER_SHELL                                 shell used by the Bash tool (default: PowerShell on Windows, bash elsewhere)
  Config file: ~/.coder/config.json   MCP servers: "mcpServers" in config.json or <project>/.mcp.json
`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      print: { type: 'boolean', short: 'p' },
      continue: { type: 'boolean', short: 'c' },
      resume: { type: 'string', short: 'r' },
      model: { type: 'string', short: 'm' },
      provider: { type: 'string' },
      'accept-edits': { type: 'boolean' },
      yolo: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help) return void console.log(HELP);
  if (values.version) return void console.log(VERSION);

  const cwd = process.cwd();
  const config = loadConfig({ provider: values.provider, model: values.model });
  const mode: PermissionMode = values.yolo ? 'yolo' : values['accept-edits'] ? 'acceptEdits' : 'default';

  let session = new Session(cwd);
  let resumed: Message[] = [];
  if (values.continue || values.resume) {
    const loaded = values.resume ? Session.load(cwd, values.resume) : Session.loadLatest(cwd);
    if (loaded) {
      session = loaded.session;
      resumed = loaded.messages;
    } else if (values.resume) {
      throw new Error(`Session "${values.resume}" not found in this directory.`);
    } else {
      console.log(c.dim('No previous session found in this directory, starting a new one.'));
    }
  }

  // ------------------------------------------------ print mode：纯文本输出，无交互
  if (values.print) {
    let prompt = positionals.join(' ');
    if (!process.stdin.isTTY) {
      const piped = (await readStdin()).trim();
      if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped;
    }
    if (!prompt) throw new Error('No prompt provided. Usage: coder -p "your prompt"');

    const { runtime, agent } = bootstrap({ config, cwd, mode, view: new ConsoleView(), prompter: null, askUser: null });
    agent.load(resumed);
    await runtime.mcp.startAll();
    for (const cl of runtime.mcp.clients.filter((x) => x.status === 'failed')) console.error(c.yellow(`⚠ MCP server "${cl.name}" failed: ${cl.error}`));

    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    try {
      await agent.run(prompt, controller.signal);
      // 不留下仍在后台运行的 worker
      if (runtime.workers?.running().length) {
        await runtime.workers.wait(undefined, 'all', 600_000, controller.signal);
      }
    } finally {
      session.save(agent.messages);
      runtime.workers?.closeAll();
      await runtime.mcp.closeAll();
    }
    process.exit(0);
  }

  // ------------------------------------------------ interactive mode：Ink TUI
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive mode requires a TTY. Use -p for non-interactive usage.');
  }
  // 按需加载 React/Ink，print 模式不受影响
  const { UIStore } = await import('./tui/store.js');
  const { startTui } = await import('./tui/index.js');
  const store = new UIStore();
  const { runtime, agent } = bootstrap({ config, cwd, mode, view: store, prompter: store.prompter, askUser: store.askUser });
  agent.load(resumed);

  startTui({
    store,
    agent,
    runtime,
    session,
    banner: {
      version: VERSION,
      model: runtime.provider.model,
      provider: runtime.provider.name,
      cwd,
      resumed: resumed.length,
      skills: runtime.skills.length,
      mcpServers: runtime.mcp.clients.length,
    },
  });
}

main().catch((err) => {
  console.error(c.red(`✗ ${errorMessage(err)}`));
  process.exit(1);
});
