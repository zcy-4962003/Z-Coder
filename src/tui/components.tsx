import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { formatDuration } from '../loop.js';
import { renderMarkdown } from '../markdown.js';
import type { PermissionMode } from '../permissions.js';
import type { WorkerInfo } from '../subagents.js';
import type { ToolStartEvent } from '../view.js';
import { toneColor } from '../view.js';
import type { HistoryItem } from './store.js';

export interface BannerInfo {
  version: string;
  model: string;
  provider: string;
  cwd: string;
  resumed: number;
  skills: number;
  mcpServers: number;
}

export function Banner({ info }: { info: BannerInfo }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginBottom={1}>
      <Text>
        <Text color="magenta">✻ </Text>
        <Text bold>Welcome to Coder!</Text>
        <Text dimColor> v{info.version}</Text>
      </Text>
      <Text> </Text>
      <Text dimColor>  /help for help · shift+tab to switch permission mode</Text>
      <Text> </Text>
      <Text dimColor>  cwd:   {info.cwd}</Text>
      <Text dimColor>  model: {info.model} ({info.provider})</Text>
      {info.resumed > 0 && <Text dimColor>  resumed session with {info.resumed} messages</Text>}
      {info.skills + info.mcpServers > 0 && (
        <Text dimColor>
          {'  '}
          {info.skills ? `skills: ${info.skills} (/skills)` : ''}
          {info.skills && info.mcpServers ? ' · ' : ''}
          {info.mcpServers ? `mcp servers: ${info.mcpServers} (/mcp)` : ''}
        </Text>
      )}
    </Box>
  );
}

function Gutter({ children, color }: { children: string; color?: string }) {
  return (
    <Box width={2} flexShrink={0}>
      {color ? <Text color={color}>{children}</Text> : <Text>{children}</Text>}
    </Box>
  );
}

export function AssistantText({ text, continued, width }: { text: string; continued: boolean; width: number }) {
  // 流式拆分出的后续块原本以空行分隔，这里用 marginTop 还原
  return (
    <Box marginTop={1}>
      <Gutter>{continued ? ' ' : '●'}</Gutter>
      <Box flexDirection="column" flexGrow={1}>
        <Text>{renderMarkdown(text, width - 4)}</Text>
      </Box>
    </Box>
  );
}

function ToolResult({ display, error }: { display: string; error: boolean }) {
  if (!display) return null;
  return (
    <Box paddingLeft={2}>
      <Box width={3} flexShrink={0}>
        <Text dimColor>⎿ </Text>
      </Box>
      <Box flexGrow={1}>{error ? <Text color="red">{display}</Text> : <Text>{display}</Text>}</Box>
    </Box>
  );
}

function ToolHeader({ name, summary, dot, dotColor }: { name: string; summary: string; dot: string; dotColor: string }) {
  return (
    <Box>
      <Gutter color={dotColor}>{dot}</Gutter>
      <Text>
        <Text bold>{name}</Text>
        {summary ? <Text dimColor>({summary})</Text> : null}
      </Text>
    </Box>
  );
}

export function HistoryView({ item, banner, width }: { item: HistoryItem; banner: BannerInfo; width: number }) {
  switch (item.kind) {
    case 'banner':
      return <Banner info={banner} />;
    case 'user':
      return (
        <Box marginTop={1}>
          <Gutter color="gray">{'>'}</Gutter>
          <Text color="gray">{item.text}</Text>
        </Box>
      );
    case 'assistant':
      return <AssistantText text={item.text} continued={item.continued} width={width} />;
    case 'tool': {
      const color = item.status === 'ok' ? 'green' : item.status === 'error' ? 'red' : 'yellow';
      return (
        <Box flexDirection="column" marginTop={1}>
          <ToolHeader name={item.name} summary={item.summary} dot="●" dotColor={color} />
          <ToolResult display={item.display} error={item.status !== 'ok'} />
        </Box>
      );
    }
    case 'info':
      return (
        <Box marginTop={1}>
          <Text>{toneColor(item.tone)(item.text)}</Text>
        </Box>
      );
  }
}

/** 正在执行的工具：圆点闪烁 */
export function ActiveTool({ tool }: { tool: ToolStartEvent }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setOn((v) => !v), 500);
    return () => clearInterval(t);
  }, []);
  return (
    <Box marginTop={1}>
      <ToolHeader name={tool.name} summary={tool.summary} dot={on ? '●' : ' '} dotColor="gray" />
    </Box>
  );
}

const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const VERBS = ['Thinking', 'Pondering', 'Working', 'Brewing', 'Crafting', 'Computing', 'Musing', 'Cooking'];

export function Spinner({ label, startedAt }: { label: string; startedAt: number }) {
  const [frame, setFrame] = useState(0);
  // "Thinking" 时随机换一个动词，增加一点趣味
  const [verb] = useState(() => (label === 'Thinking' ? VERBS[Math.floor(Math.random() * VERBS.length)]! : label));
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, []);
  const sec = Math.floor((Date.now() - startedAt) / 1000);
  return (
    <Box marginTop={1}>
      <Gutter color="magenta">{FRAMES[frame % FRAMES.length]!}</Gutter>
      <Text>
        <Text color="magenta">{verb}…</Text>
        <Text dimColor> ({sec}s · esc to interrupt)</Text>
      </Text>
    </Box>
  );
}

function useTick(ms: number, enabled: boolean): void {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
}

/** 后台 worker 的实时状态 */
export function WorkersPanel({ workers }: { workers: WorkerInfo[] }) {
  const visible = workers.filter((w) => w.status === 'running' || (!w.consumed && w.status !== 'closed'));
  useTick(1000, visible.some((w) => w.status === 'running'));
  if (!visible.length) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {visible.map((w) => {
        const sec = Math.round(((w.endedAt ?? Date.now()) - w.startedAt) / 1000);
        const color = w.status === 'running' ? 'magenta' : w.status === 'completed' ? 'green' : 'red';
        return (
          <Box key={w.id}>
            <Gutter color={color}>{w.status === 'running' ? '◆' : w.status === 'completed' ? '✓' : '✗'}</Gutter>
            <Text wrap="truncate-end">
              <Text color={color}>{w.id}</Text>
              <Text> {w.description}</Text>
              <Text dimColor>
                {' '}
                · {w.status === 'running' ? w.activity : w.status === 'completed' ? 'done, waiting to be collected' : w.status} · {w.toolCalls} tools · {sec}s
              </Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export interface StatusInfo {
  mode: PermissionMode;
  hint: string | null;
  model: string;
  contextPct: number;
  contextEstimated: boolean;
  queued: number;
  goal: { status: 'active' | 'paused'; iterations: number; max: number } | null;
  loop: { intervalMs: number; nextAt: number | null; iterations: number } | null;
  mcp: { connected: number; total: number } | null;
}

export function StatusBar({ info }: { info: StatusInfo }) {
  useTick(1000, !!info.loop?.nextAt);
  let left;
  const compact = !!(info.goal || info.loop);
  if (info.hint) left = <Text color="yellow">{info.hint}</Text>;
  else if (info.mode === 'acceptEdits') left = <Text color="yellow">⏵⏵ accept edits on{compact ? '' : <Text dimColor> (shift+tab to cycle)</Text>}</Text>;
  else if (info.mode === 'yolo') left = <Text color="red">⚠ yolo mode on{compact ? '' : <Text dimColor> (shift+tab to cycle)</Text>}</Text>;
  else left = <Text dimColor>{compact ? '? /help' : '? /help for shortcuts · shift+tab to cycle modes'}</Text>;

  const pct = Math.round(info.contextPct);
  const ctxColor = pct >= 80 ? 'red' : pct >= 60 ? 'yellow' : undefined;
  const ctxText = `${info.contextEstimated && pct > 0 ? '~' : ''}${pct}%`;
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          {info.goal ? (
            <Text color={info.goal.status === 'active' ? 'green' : 'yellow'}>
              ◎ goal {info.goal.status === 'active' ? `${info.goal.iterations}/${info.goal.max}` : 'paused'}
              {'  '}
            </Text>
          ) : null}
          {info.loop ? (
            <Text color="cyan">
              ↻ loop {formatDuration(info.loop.intervalMs)} · {info.loop.nextAt ? `next ${formatDuration(info.loop.nextAt - Date.now())}` : `#${info.loop.iterations} running`}
              {'  '}
            </Text>
          ) : null}
          {left}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={1}>
        <Text dimColor>
          {info.queued > 0 ? `${info.queued} queued · ` : ''}
          {info.mcp ? `mcp ${info.mcp.connected}/${info.mcp.total} · ` : ''}
          {info.model} · {ctxColor ? <Text color={ctxColor}>{ctxText}</Text> : ctxText} context
        </Text>
      </Box>
    </Box>
  );
}
