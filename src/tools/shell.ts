import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { defineTool } from './types.js';
import { checkCommand } from '../permissions.js';
import { previewLines } from '../ui.js';

export interface ShellInfo {
  name: 'powershell' | 'cmd' | 'bash' | 'sh';
  file: string;
  args(command: string): string[];
  verbatim: boolean;
}

function powershell(file: string): ShellInfo {
  return {
    name: 'powershell',
    file,
    // 强制 UTF-8 输出，避免中文 Windows 下 GBK 乱码
    args: (cmd) => [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ` +
        `$PSDefaultParameterValues['*:Encoding']='utf8'\n${cmd}\n` +
        // 透传真实退出码（PowerShell -Command 默认只返回 0/1）
        `$__ok=$?; if (-not $__ok) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }`,
    ],
    verbatim: false,
  };
}

let cached: ShellInfo | undefined;

/** CODER_SHELL 环境变量可覆盖；Windows 默认 PowerShell，其它平台默认 bash */
export function detectShell(): ShellInfo {
  if (cached) return cached;
  const custom = process.env.CODER_SHELL;
  if (custom) {
    const base = basename(custom).toLowerCase();
    if (base.includes('powershell') || base.includes('pwsh')) cached = powershell(custom);
    else if (base === 'cmd' || base === 'cmd.exe') cached = { name: 'cmd', file: custom, args: (cmd) => ['/d', '/s', '/c', `"${cmd}"`], verbatim: true };
    else cached = { name: base.includes('bash') ? 'bash' : 'sh', file: custom, args: (cmd) => ['-c', cmd], verbatim: false };
  } else if (process.platform === 'win32') {
    cached = powershell('powershell.exe');
  } else {
    const bash = existsSync('/bin/bash');
    cached = { name: bash ? 'bash' : 'sh', file: bash ? '/bin/bash' : '/bin/sh', args: (cmd) => ['-c', cmd], verbatim: false };
  }
  return cached;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

const MAX_BUFFER = 4 * 1024 * 1024;

export const bashTool = defineTool<{ command: string; timeout?: number; description?: string }>({
  name: 'Bash',
  kind: 'exec',
  description:
    'Execute a shell command in the working directory and return combined stdout/stderr. ' +
    'Stdin is closed, so interactive commands will not work. Default timeout 120000ms (max 600000). ' +
    'Do NOT use it for reading/searching files — use Read/Glob/Grep instead. Each call runs in a fresh shell (cd does not persist).',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute' },
      timeout: { type: 'integer', description: 'Timeout in milliseconds' },
      description: { type: 'string', description: 'Short description of what the command does (5-10 words)' },
    },
    required: ['command'],
  },
  summary: (i) => (i.command.length > 120 ? i.command.slice(0, 120) + '…' : i.command),
  permissionKey: (i) => {
    const [first = '', second = ''] = i.command.trim().split(/\s+/);
    return /^[a-z][\w-]*$/i.test(second) ? `${first} ${second}` : first;
  },
  preview: (i) => `${i.description ? i.description + '\n' : ''}$ ${i.command}`,
  checkPermission: (i) => checkCommand(i.command),
  run(input, ctx) {
    const timeout = Math.min(Math.max(input.timeout ?? 120000, 1000), 600000);
    const sh = detectShell();
    return new Promise((resolve, reject) => {
      const child = spawn(sh.file, sh.args(input.command), {
        cwd: ctx.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: sh.verbatim,
        detached: process.platform !== 'win32',
      });
      let out = '';
      let overflow = false;
      let killed = '';
      const onData = (d: string) => {
        if (out.length < MAX_BUFFER) out += d;
        else overflow = true;
      };
      child.stdout?.setEncoding('utf8').on('data', onData);
      child.stderr?.setEncoding('utf8').on('data', onData);

      const kill = (why: string) => {
        killed = why;
        killTree(child);
      };
      const timer = setTimeout(() => kill(`timed out after ${timeout}ms`), timeout);
      const onAbort = () => kill('interrupted by user');
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
      };

      child.on('error', (err) => {
        cleanup();
        reject(new Error(`Failed to start shell (${sh.file}): ${err.message}`));
      });
      child.on('close', (code) => {
        cleanup();
        // 不在这里截断：超大输出由 Agent 统一落盘，并在上下文中替换为预览
        let result = out.replace(/\r\n/g, '\n').trimEnd() || '(no output)';
        if (overflow) result += '\n[output exceeded buffer and was cut]';
        if (killed) result += `\n[Command ${killed}]`;
        else if (code) result += `\n[Exit code ${code}]`;
        resolve(result);
      });
    });
  },
  display: (out) => previewLines(out, 5),
});
