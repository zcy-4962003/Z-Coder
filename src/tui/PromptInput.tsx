import { useReducer, useRef } from 'react';
import { Box, Text } from 'ink';
import type { CommandInfo } from '../commands.js';
import { useKeys } from './input.js';

interface Props {
  busy: boolean;
  commands: CommandInfo[];
  getFiles: () => string[];
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  /** 空输入时按 Ctrl+C */
  onCtrlCEmpty: () => void;
  onShiftTab: () => void;
}

interface MenuItem {
  label: string;
  hint: string;
  /** 补全后的完整输入与光标位置 */
  apply: () => { value: string; cursor: number };
  /** Enter 时直接提交的内容（斜杠命令） */
  submit?: string;
}

const MAX_MENU = 8;
const PLACEHOLDER = 'Try "explain this codebase" · / for commands · @ for files';

// ---- 光标按 Unicode 码点移动，避免把代理对（emoji 等）切成两半
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
function prevPos(s: string, i: number): number {
  if (i <= 0) return 0;
  return i >= 2 && isLow(s.charCodeAt(i - 1)) ? i - 2 : i - 1;
}
function nextPos(s: string, i: number): number {
  if (i >= s.length) return s.length;
  return isLow(s.charCodeAt(i + 1)) ? i + 2 : i + 1;
}

function lineInfo(value: string, cursor: number) {
  const before = value.slice(0, cursor);
  const line = before.split('\n').length - 1;
  const lineStart = before.lastIndexOf('\n') + 1;
  return { line, col: cursor - lineStart, lineStart };
}

function lineStarts(value: string): number[] {
  const starts = [0];
  for (let i = 0; i < value.length; i++) if (value[i] === '\n') starts.push(i + 1);
  return starts;
}

function buildMenu(value: string, cursor: number, commands: CommandInfo[], files: () => string[]): MenuItem[] {
  // 斜杠命令：整行只有 /xxx 且光标在末尾
  const slash = /^\/(\S*)$/.exec(value);
  if (slash && cursor === value.length) {
    const q = slash[1]!.toLowerCase();
    const matched = commands
      .filter((c) => c.name.includes(q))
      .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)));
    if (matched.length === 1 && matched[0]!.name === q) return [];
    return matched.map((c) => ({
      label: `/${c.name}${c.args ? ' ' + c.args : ''}`,
      hint: c.description,
      apply: () => ({ value: `/${c.name} `, cursor: c.name.length + 2 }),
      submit: `/${c.name}`,
    }));
  }
  // @ 文件补全
  const m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, cursor));
  if (m) {
    const q = m[2]!.toLowerCase().replace(/\\/g, '/');
    const start = cursor - m[2]!.length - 1;
    const scored: { path: string; score: number }[] = [];
    for (const p of files()) {
      const lower = p.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx < 0) continue;
      const base = lower.slice(lower.lastIndexOf('/') + 1);
      scored.push({ path: p, score: (base.startsWith(q) ? 0 : idx === 0 ? 1 : 2) * 10000 + p.length });
      if (scored.length > 2000) break;
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, MAX_MENU).map(({ path }) => ({
      label: path,
      hint: '',
      apply: () => {
        const insert = `@${path} `;
        return { value: value.slice(0, start) + insert + value.slice(cursor), cursor: start + insert.length };
      },
    }));
  }
  return [];
}

export function PromptInput(props: Props) {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  // 用 ref 保存编辑状态，避免快速连续按键时读到过期的闭包状态
  const st = useRef({ value: '', cursor: 0, sel: 0, dismissed: null as string | null, history: [] as string[], histIdx: -1, draft: '' });
  const s = st.current;

  const currentMenu = () => (s.dismissed === s.value ? [] : buildMenu(s.value, s.cursor, props.commands, props.getFiles));
  const menu = currentMenu();
  if (s.sel >= menu.length) s.sel = 0;

  const setValue = (value: string, cursor = value.length) => {
    if (value !== s.value) s.sel = 0;
    s.value = value;
    s.cursor = Math.max(0, Math.min(cursor, value.length));
    rerender();
  };
  const insert = (text: string) => setValue(s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor), s.cursor + text.length);
  const applyItem = (item: MenuItem) => {
    const r = item.apply();
    setValue(r.value, r.cursor);
  };
  const submit = (text: string) => {
    if (text.trim()) {
      if (s.history.at(-1) !== text) s.history.push(text);
      if (s.history.length > 200) s.history.shift();
    }
    s.histIdx = -1;
    s.dismissed = null;
    setValue('', 0);
    if (text.trim()) props.onSubmit(text.trim());
  };
  const historyNav = (dir: -1 | 1) => {
    if (!s.history.length) return;
    if (s.histIdx === -1) {
      if (dir === 1) return;
      s.draft = s.value;
      s.histIdx = s.history.length - 1;
    } else {
      s.histIdx += dir;
      if (s.histIdx >= s.history.length) {
        s.histIdx = -1;
        return setValue(s.draft);
      }
      s.histIdx = Math.max(0, s.histIdx);
    }
    setValue(s.history[s.histIdx] ?? '');
  };

  useKeys(
    (input, key) => {
      // 从 ref 重新计算菜单：两次渲染之间可能已处理了多个按键
      const menu = currentMenu();
      if (s.sel >= menu.length) s.sel = 0;
      if (key.ctrl && input === 'c') {
        if (props.busy) props.onInterrupt();
        else if (s.value) setValue('', 0);
        else props.onCtrlCEmpty();
        return;
      }
      if (key.escape) {
        if (menu.length) {
          s.dismissed = s.value;
          rerender();
        } else if (props.busy) props.onInterrupt();
        else if (s.value) setValue('', 0);
        return;
      }
      if (key.tab && key.shift) return props.onShiftTab();
      if (key.tab) {
        if (menu[s.sel]) applyItem(menu[s.sel]!);
        return;
      }
      if (menu.length && (key.upArrow || key.downArrow)) {
        s.sel = (s.sel + (key.upArrow ? -1 : 1) + menu.length) % menu.length;
        rerender();
        return;
      }
      if (key.return) {
        const item = menu[s.sel];
        if (item) {
          if (item.submit) return submit(item.submit);
          return applyItem(item);
        }
        // "\" + Enter 或 Alt+Enter 换行
        if (s.value[s.cursor - 1] === '\\') {
          return setValue(s.value.slice(0, s.cursor - 1) + '\n' + s.value.slice(s.cursor), s.cursor);
        }
        if (key.meta || key.shift) return insert('\n');
        return submit(s.value);
      }

      const { line, col } = lineInfo(s.value, s.cursor);
      const starts = lineStarts(s.value);
      if (key.upArrow || key.downArrow) {
        const target = line + (key.upArrow ? -1 : 1);
        if (target < 0 || target >= starts.length) return historyNav(key.upArrow ? -1 : 1);
        const tStart = starts[target]!;
        const tEnd = target + 1 < starts.length ? starts[target + 1]! - 1 : s.value.length;
        return setValue(s.value, Math.min(tStart + col, tEnd));
      }
      if (key.leftArrow) return setValue(s.value, prevPos(s.value, s.cursor));
      if (key.rightArrow) return setValue(s.value, nextPos(s.value, s.cursor));
      const lineStart = starts[line]!;
      const lineEnd = line + 1 < starts.length ? starts[line + 1]! - 1 : s.value.length;
      if (key.home || (key.ctrl && input === 'a')) return setValue(s.value, lineStart);
      if (key.end || (key.ctrl && input === 'e')) return setValue(s.value, lineEnd);
      if (key.backspace) {
        const p = prevPos(s.value, s.cursor);
        return setValue(s.value.slice(0, p) + s.value.slice(s.cursor), p);
      }
      if (key.delete) return setValue(s.value.slice(0, s.cursor) + s.value.slice(nextPos(s.value, s.cursor)), s.cursor);
      if (key.ctrl) {
        if (input === 'u') return setValue(s.value.slice(0, lineStart) + s.value.slice(s.cursor), lineStart);
        if (input === 'k') return setValue(s.value.slice(0, s.cursor) + s.value.slice(lineEnd), s.cursor);
        if (input === 'w') {
          const before = s.value.slice(0, s.cursor).replace(/\S+\s*$|\s+$/, '');
          return setValue(before + s.value.slice(s.cursor), before.length);
        }
        return;
      }
      if (key.meta) return;
      if (input) insert(input.replace(/\r\n?/g, '\n'));
    },
    (text) => insert(text.replace(/\r\n?/g, '\n')),
  );

  // ---------------------------------------------------------------- 渲染
  const { line: curLine, col: curCol } = lineInfo(s.value, s.cursor);
  const lines = s.value.split('\n');
  // 菜单超过 MAX_MENU 项时，让可见窗口跟随选中项滚动
  const offset = Math.max(0, Math.min(s.sel - MAX_MENU + 1, menu.length - MAX_MENU));
  const labelWidth = Math.min(44, Math.max(0, ...menu.map((m) => m.label.length)) + 3);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={props.busy ? 'gray' : 'white'} borderDimColor paddingX={1}>
        <Box width={2} flexShrink={0}>
          <Text bold>{'>'}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {s.value === '' ? (
            <Text>
              <Text inverse>{PLACEHOLDER[0]}</Text>
              <Text dimColor>{PLACEHOLDER.slice(1)}</Text>
            </Text>
          ) : (
            lines.map((l, i) => {
              if (i !== curLine) return <Text key={i}>{l || ' '}</Text>;
              const end = nextPos(l, curCol);
              const ch = l.slice(curCol, end);
              return (
                <Text key={i}>
                  {l.slice(0, curCol)}
                  <Text inverse>{ch || ' '}</Text>
                  {l.slice(end)}
                </Text>
              );
            })
          )}
        </Box>
      </Box>
      {menu.length > 0 && (
        <Box flexDirection="column" paddingX={2}>
          {menu.slice(offset, offset + MAX_MENU).map((item, j) => {
            const i = j + offset;
            return (
            <Box key={item.label}>
              <Box width={labelWidth} flexShrink={0}>
                <Text {...(i === s.sel ? { color: 'cyan' } : { dimColor: true })}>
                  {item.label}
                </Text>
              </Box>
              <Text {...(i === s.sel ? { color: 'cyan' } : { dimColor: true })} wrap="truncate-end">
                {item.hint}
              </Text>
            </Box>
            );
          })}
          {menu.length > MAX_MENU && <Text dimColor>  ({s.sel + 1}/{menu.length})</Text>}
        </Box>
      )}
    </Box>
  );
}
