import type { Agent } from './agent.js';
import type { Message } from './llm/types.js';
import { formatDuration, parseDuration, type LoopManager } from './loop.js';
import { PERMISSION_MODES, type PermissionMode } from './permissions.js';
import { INIT_PROMPT, loadMemory } from './prompt.js';
import type { Runtime } from './runtime.js';
import { Session } from './session.js';
import { discoverSkills, skillRoots } from './skills.js';
import { formatWorker } from './subagents.js';
import { renderPlan } from './tools/plan.js';
import { c, errorMessage } from './ui.js';
import type { Tone } from './view.js';

export interface CommandContext {
  agent: Agent;
  session: Session;
  runtime: Runtime;
  print: (text: string, tone?: Tone) => void;
  /** 执行需要可中断的异步操作（如 /compact） */
  runAbortable: (fn: (signal: AbortSignal) => Promise<void>) => Promise<unknown>;
  /** 以下仅交互界面提供 */
  clearScreen?: () => void;
  /** 切换到另一段对话后重绘界面 */
  showConversation?: (messages: Message[]) => void;
  loop?: LoopManager;
}

export interface CommandResult {
  exit?: boolean;
  /** 需要作为用户消息发送给 Agent 的内容 */
  prompt?: string;
  /** prompt 的来源，用于 Goal / Loop 的调度 */
  origin?: 'loop' | 'goal';
}

export interface CommandInfo {
  name: string;
  args?: string;
  description: string;
}

interface Command extends CommandInfo {
  aliases?: string[];
  run(arg: string, ctx: CommandContext): Promise<CommandResult | void> | CommandResult | void;
}

export const MODE_LABEL: Record<PermissionMode, string> = {
  default: 'default (ask before edits, commands and network)',
  acceptEdits: 'acceptEdits (auto-approve edits inside the working directory)',
  yolo: 'yolo (auto-approve everything except dangerous operations)',
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return iso;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function goalStatus(rt: Runtime): string {
  const g = rt.goal.goal;
  if (!g) return 'No goal set. Usage: /goal <description>';
  const color = g.status === 'active' ? c.green : g.status === 'paused' ? c.yellow : c.cyan;
  const lines = [`${c.bold('Goal')} ${color(`[${g.status}]`)} ${c.dim(`auto-continues: ${g.iterations}/${g.maxIterations}`)}`, g.text];
  if (g.pausedReason && g.status === 'paused') lines.push(c.dim(`paused: ${g.pausedReason}`));
  if (g.summary) lines.push(`${c.bold('Summary:')} ${g.summary}`, `${c.bold('Evidence:')} ${g.evidence ?? ''}`);
  return lines.join('\n');
}

const commands: Command[] = [
  {
    name: 'help',
    description: 'Show available commands and shortcuts',
    run(_arg, { print, runtime }) {
      const lines = [c.bold('Commands')];
      for (const cmd of commandList(runtime)) lines.push(`  ${c.cyan(`/${cmd.name}${cmd.args ? ' ' + cmd.args : ''}`.padEnd(34))} ${c.dim(cmd.description)}`);
      lines.push('', c.bold('Shortcuts'));
      const keys: [string, string][] = [
        ['Enter', 'send message (queued if the agent is busy)'],
        ['\\ + Enter / Alt+Enter', 'new line'],
        ['Esc', 'interrupt the agent / clear input'],
        ['Ctrl+C', 'interrupt · press twice on empty input to exit'],
        ['Shift+Tab', 'cycle permission mode'],
        ['↑ / ↓', 'input history'],
        ['/', 'command menu (Tab to complete)'],
        ['@', 'file path completion'],
      ];
      for (const [k, d] of keys) lines.push(`  ${k.padEnd(34)} ${c.dim(d)}`);
      print(lines.join('\n'));
    },
  },
  {
    name: 'clear',
    description: 'Clear conversation history and plan, start a new session',
    run(_arg, { agent, session, runtime, print, clearScreen }) {
      agent.reset();
      session.renew();
      runtime.plan.items = [];
      runtime.plan.explanation = '';
      clearScreen?.();
      print('Conversation cleared.', 'dim');
    },
  },
  {
    name: 'compact',
    args: '[instructions]',
    description: 'Summarize the conversation to free up context',
    async run(arg, { agent, runAbortable, print }) {
      await runAbortable(async (signal) => {
        const ok = await agent.compact(signal, arg);
        if (!ok) print('Nothing to compact.', 'dim');
      });
    },
  },
  {
    name: 'context',
    description: 'Show context window usage',
    run(_arg, { agent, runtime, print }) {
      const s = agent.contextStats();
      const limit = runtime.contextLimit;
      const pct = (n: number) => `${((n / limit) * 100).toFixed(1)}%`;
      const width = 40;
      const filled = Math.min(width, Math.round((s.total / limit) * width));
      const bar = c.cyan('█'.repeat(filled)) + c.dim('░'.repeat(width - filled));
      print(
        [
          `${bar} ${s.total.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct(s.total)})`,
          s.estimated
            ? c.dim('  estimated (no provider usage yet)')
            : `  provider usage: ${s.fromUsage.toLocaleString()}  +  tail estimate: ${s.tail.toLocaleString()}`,
          c.dim(`  messages: ${agent.messages.length} · fold at 60% · auto-compact at 80% · trim on overflow`),
        ].join('\n'),
      );
    },
  },
  {
    name: 'model',
    args: '[name]',
    description: 'Show or switch the model',
    run(arg, { runtime, print }) {
      if (arg) runtime.provider.model = arg;
      print(`Model: ${c.bold(runtime.provider.model)} ${c.dim(`(${runtime.provider.name})`)}`);
    },
  },
  {
    name: 'mode',
    args: '[default|acceptEdits|yolo]',
    description: 'Show or switch the permission mode',
    run(arg, { runtime, print }) {
      const p = runtime.permissions;
      if (arg) {
        if (!PERMISSION_MODES.includes(arg as PermissionMode)) {
          print(`Unknown mode "${arg}". Options: ${PERMISSION_MODES.join(', ')}`, 'error');
          return;
        }
        p.mode = arg as PermissionMode;
      } else {
        p.cycleMode();
      }
      print(`Permission mode: ${c.bold(MODE_LABEL[p.mode])}`);
    },
  },
  {
    name: 'cost',
    description: 'Show token usage for this session',
    run(_arg, { agent, print }) {
      const u = agent.usage;
      print(`Requests: ${u.requests}  Input tokens: ${u.input.toLocaleString()}  Output tokens: ${u.output.toLocaleString()}`);
    },
  },
  {
    name: 'plan',
    aliases: ['todos'],
    description: 'Show the shared task plan',
    run(_arg, { runtime, print }) {
      print(runtime.plan.items.length ? `${c.bold('Plan')}\n${renderPlan(runtime.plan)}` : c.dim('No plan yet. The agent creates one with update_plan for multi-step tasks.'));
    },
  },
  {
    name: 'agents',
    args: '[close <id|all>]',
    description: 'List sub-agents (workers) or close them',
    run(arg, { runtime, print }) {
      const wm = runtime.workers;
      if (!wm) return print('Sub-agents are not available.', 'error');
      const [sub, target] = arg.split(/\s+/);
      if (sub === 'close') {
        if (!target) return print('Usage: /agents close <id|all>', 'error');
        if (target === 'all') return print(`Closed ${wm.closeAll()} worker(s).`);
        try {
          return print(formatWorker(wm.close(target), false));
        } catch (e) {
          return print(errorMessage(e), 'error');
        }
      }
      const list = wm.list();
      print(list.length ? list.map((w) => formatWorker(w, false)).join('\n') : c.dim('No workers have been started in this session.'));
    },
  },
  {
    name: 'goal',
    args: '[<description>|pause|resume|check|clear]',
    description: 'Set a goal that auto-continues across turns',
    run(arg, { runtime, print, loop }) {
      const goal = runtime.goal;
      const sub = arg.trim();
      if (!sub) return print(goalStatus(runtime));
      if (sub === 'pause') return print(goal.pause() ? 'Goal paused. /goal resume to continue.' : 'No active goal.', goal.goal ? 'normal' : 'dim');
      if (sub === 'clear') {
        goal.clear();
        return print('Goal cleared.', 'dim');
      }
      if (sub === 'resume') {
        if (loop?.state) return print('A loop is running; goals and loops are mutually exclusive. Run /loop stop first.', 'error');
        if (!goal.resume()) return print('No paused goal to resume.', 'dim');
        print('Goal resumed.');
        return { prompt: goal.continuePrompt(), origin: 'goal' };
      }
      if (sub === 'check') {
        if (!goal.goal || goal.goal.status === 'completed') return print(goal.goal ? 'The goal is already completed.' : 'No goal set.', 'dim');
        return { prompt: goal.checkPrompt() };
      }
      if (loop?.state) return print('A loop is running; goals and loops are mutually exclusive. Run /loop stop first.', 'error');
      if (goal.goal && goal.goal.status !== 'completed') print(c.dim('Replacing the previous goal.'));
      goal.set(sub);
      print(`${c.green('◎')} Goal set. It will auto-continue after each turn until completed (max ${goal.goal!.maxIterations} rounds). /goal pause to pause.`);
      return { prompt: goal.startPrompt(), origin: 'goal' };
    },
  },
  {
    name: 'loop',
    args: '[<interval> <prompt>|stop]',
    description: 'Repeat a prompt at a fixed interval, e.g. /loop 5m check CI',
    run(arg, { runtime, print, loop }) {
      if (!loop) return print('Loops are only available in interactive mode.', 'error');
      const trimmed = arg.trim();
      if (!trimmed) {
        const st = loop.state;
        if (!st) return print(c.dim('No loop running. Usage: /loop <interval> <prompt>, e.g. /loop 5m check the build'));
        const next = st.nextAt ? `next run in ${formatDuration(st.nextAt - Date.now())}` : 'running now';
        return print(`${c.bold('Loop')} every ${formatDuration(st.intervalMs)} · iteration ${st.iterations} · ${next}\n${st.prompt}`);
      }
      if (trimmed === 'stop') {
        const st = loop.stop();
        return print(st ? `Loop stopped after ${st.iterations} iteration(s).` : 'No loop running.', 'dim');
      }
      const [interval = '', ...rest] = trimmed.split(/\s+/);
      const ms = parseDuration(interval);
      const prompt = rest.join(' ').trim();
      if (!ms || !prompt) return print('Usage: /loop <interval> <prompt>   (interval like 30s, 5m, 1h)', 'error');
      if (runtime.goal.isActive()) return print('A goal is active; goals and loops are mutually exclusive. Pause or clear it first (/goal pause).', 'error');
      try {
        loop.start(prompt, ms);
      } catch (e) {
        return print(errorMessage(e), 'error');
      }
      print(`${c.green('↻')} Loop started: every ${formatDuration(ms)} after each round finishes. /loop stop to stop.`);
      return { prompt, origin: 'loop' };
    },
  },
  {
    name: 'sessions',
    args: '[delete <number|id|name>|cleanup]',
    description: 'List saved sessions, delete one, or clean up expired sessions',
    run(arg, { runtime, session, print }) {
      const sub = arg.trim();
      if (sub === 'cleanup') {
        const n = Session.cleanup();
        return print(n ? `Removed ${n} expired session${n === 1 ? '' : 's'}.` : 'No expired sessions to remove.', 'dim');
      }
      const del = /^delete\s+(\S.*)$/.exec(sub);
      if (del) {
        const ref = del[1]!.trim();
        const target = Session.find(runtime.cwd, ref);
        if (!target) return print(`Session "${ref}" not found. See /sessions.`, 'error');
        if (target.id === session.id) return print('Cannot delete the active session. Start a new one with /clear first.', 'error');
        if (!Session.remove(runtime.cwd, target.id)) return print(`Failed to delete session "${ref}".`, 'error');
        return print(`Deleted ${c.bold(target.name || target.id)} ${c.dim(`(${target.messageCount} messages)`)}.`, 'dim');
      }
      const list = Session.list(runtime.cwd);
      if (!list.length) return print('No saved sessions for this project yet.', 'dim');
      const lines = list.slice(0, 30).map((m, i) => {
        const current = m.id === session.id ? c.green(' ● current') : '';
        const title = m.name ? c.bold(m.name) : m.firstPrompt || c.dim('(empty)');
        const fork = m.forkedFrom ? c.dim(' (fork)') : '';
        return `${String(i + 1).padStart(3)}. ${title}${fork}${current}\n     ${c.dim(`${m.id} · ${m.messageCount} messages · ${relTime(m.updatedAt)}`)}`;
      });
      print(`${lines.join('\n')}\n${c.dim('Resume with /resume <number|id|name> · delete with /sessions delete <ref> · prune with /sessions cleanup')}`);
    },
  },
  {
    name: 'resume',
    args: '<number|id|name>',
    description: 'Resume a saved session',
    run(arg, { agent, session, runtime, print, showConversation }) {
      if (!arg) return print('Usage: /resume <number|id|name>  (see /sessions)', 'error');
      const loaded = Session.load(runtime.cwd, arg);
      if (!loaded) return print(`Session "${arg}" not found. See /sessions.`, 'error');
      session.save(agent.messages);
      session.adopt(loaded.session);
      agent.load(loaded.messages);
      runtime.plan.items = [];
      runtime.plan.explanation = '';
      showConversation?.(loaded.messages);
      print(`Resumed ${c.bold(session.name || session.id)} (${loaded.messages.length} messages).`);
    },
  },
  {
    name: 'rename',
    args: '<name>',
    description: 'Rename the current session',
    run(arg, { agent, session, print }) {
      if (!arg) return print('Usage: /rename <name>', 'error');
      session.rename(arg, agent.messages);
      print(`Session renamed to ${c.bold(session.name)}.`);
    },
  },
  {
    name: 'fork',
    args: '[name]',
    description: 'Copy the conversation into a new session and switch to it',
    run(arg, { agent, session, print }) {
      if (!agent.messages.length) return print('Nothing to fork yet.', 'dim');
      const { from } = session.fork(agent.messages, arg);
      print(`Forked into ${c.bold(session.name)} ${c.dim(`(${session.id}, from ${from})`)}. The original session is unchanged.`);
    },
  },
  {
    name: 'skills',
    args: '[reload]',
    aliases: ['skill'],
    description: 'List discovered local skills (SKILL.md); /skills reload rescans the skill directories',
    run(arg, { runtime, print }) {
      const action = arg.toLowerCase();
      if (action && action !== 'reload') return print('Usage: /skills [reload]', 'error');

      if (action === 'reload') {
        const before = runtime.skills;
        const next = discoverSkills(runtime.cwd);
        const had = new Set(before.map((s) => s.name.toLowerCase()));
        const has = new Set(next.map((s) => s.name.toLowerCase()));
        const brief = (names: string[]) => (names.length > 5 ? `${names.slice(0, 5).join(', ')}, … ${names.length - 5} more` : names.join(', '));
        const added = next.filter((s) => !had.has(s.name.toLowerCase())).map((s) => s.name);
        const removed = before.filter((s) => !has.has(s.name.toLowerCase())).map((s) => s.name);
        // 原地更新：Skill 工具与系统提示词每轮都会重新读取 runtime.skills，无需重启
        runtime.skills.splice(0, runtime.skills.length, ...next);
        const changes = [added.length ? `+${added.length} (${brief(added)})` : '', removed.length ? `-${removed.length} (${brief(removed)})` : ''].filter(Boolean);
        print(c.dim(`Rescanned ${skillRoots(runtime.cwd).map((r) => r.dir).join(', ')} — ${next.length} skill(s)${changes.length ? `: ${changes.join(' ')}` : ', no changes'}`));
      }

      if (!runtime.skills.length) {
        return print(c.dim('No skills found. Put skills in ~/.coder/skills/<name>/SKILL.md or <project>/.coder/skills/<name>/SKILL.md (.claude/skills is also scanned), then run /skills reload.'));
      }
      print(runtime.skills.map((s) => `${c.green('●')} ${c.bold(s.name)} ${c.dim(`[${s.source}]`)}\n  ${s.description}\n  ${c.dim(s.path)}`).join('\n'));
    },
  },
  {
    name: 'mcp',
    description: 'Show MCP server status, tools, resources and prompts',
    run(_arg, { runtime, print }) {
      const clients = runtime.mcp.clients;
      if (!clients.length) return print(c.dim('No MCP servers configured. Add "mcpServers" to ~/.coder/config.json or <project>/.mcp.json.'));
      print(
        clients
          .map((cl) => {
            const st = cl.status === 'connected' ? c.green('connected') : cl.status === 'failed' ? c.red('failed') : c.yellow(cl.status);
            const head = `${c.bold(cl.name)} ${c.dim(`(${cl.transport})`)} ${st}`;
            if (cl.status === 'failed') return `${head}\n  ${c.red(cl.error)}`;
            if (cl.status !== 'connected') return head;
            const lines = [head, `  tools: ${cl.tools.map((t) => t.name).join(', ') || '-'}`];
            if (cl.resources.length) lines.push(`  resources: ${cl.resources.length}`);
            if (cl.prompts.length) lines.push(`  prompts: ${cl.prompts.map((p) => `/mcp__${cl.name}__${p.name}`).join(', ')}`);
            return lines.join('\n');
          })
          .join('\n'),
      );
    },
  },
  {
    name: 'memory',
    description: 'Show loaded project memory files',
    run(_arg, { agent, print }) {
      const mem = loadMemory(agent.cwd);
      if (!mem.length) print('No memory files found. Run /init to create CODER.md.', 'dim');
      else print(mem.map((m) => `${c.green('●')} ${m.path} ${c.dim(`(${m.content.length} chars)`)}`).join('\n'));
    },
  },
  {
    name: 'init',
    description: 'Analyze the project and create a CODER.md memory file',
    run: () => ({ prompt: INIT_PROMPT }),
  },
  {
    name: 'exit',
    aliases: ['quit'],
    description: 'Exit Coder',
    run: () => ({ exit: true }),
  },
];

/** 内置命令 + MCP prompts */
export function commandList(runtime?: Runtime): CommandInfo[] {
  const builtin = commands.map(({ name, args, description }) => (args ? { name, args, description } : { name, description }));
  const mcp = runtime?.mcp.promptCommands().map((p) => (p.args ? { name: p.name, args: p.args, description: p.description } : { name: p.name, description: p.description })) ?? [];
  return [...builtin, ...mcp];
}

export async function handleCommand(line: string, ctx: CommandContext): Promise<CommandResult> {
  const [, name = '', arg = ''] = /^\/(\S+)\s*([\s\S]*)$/.exec(line.trim()) ?? [];
  const cmd = commands.find((c) => c.name === name || c.aliases?.includes(name));
  try {
    if (cmd) return (await cmd.run(arg.trim(), ctx)) ?? {};
    const mcpPrompt = ctx.runtime.mcp.promptCommands().find((p) => p.name === name);
    if (mcpPrompt) return { prompt: await ctx.runtime.mcp.renderPrompt(mcpPrompt, arg) };
    ctx.print(`Unknown command /${name}. Type /help for a list of commands.`, 'error');
    return {};
  } catch (err) {
    ctx.print(`Error: ${errorMessage(err)}`, 'error');
    return {};
  }
}
