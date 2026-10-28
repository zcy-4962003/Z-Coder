import { useReducer, useRef } from 'react';
import { Box, Text } from 'ink';
import type { PermissionAnswer } from '../permissions.js';
import { theme } from '../theme.js';
import { useKeys } from './input.js';
import type { PendingPermission } from './store.js';

const TITLES: Record<string, string> = {
  Bash: 'Bash command',
  Edit: 'Edit file',
  Write: 'Write file',
  Read: 'Read file',
  Glob: 'Find files',
  Grep: 'Search files',
  WebFetch: 'Fetch URL',
  WebSearch: 'Web search',
};

interface Option {
  label: string;
  answer: PermissionAnswer['type'];
}

export function PermissionDialog({ pending, queued, onInterrupt }: { pending: PendingPermission; queued: number; onInterrupt: () => void }) {
  const { req } = pending;
  // 用 ref 保存状态：连续快速按键时不会读到过期值
  const st = useRef({ sel: 0, feedback: '', done: false }).current;
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  const options: Option[] = [{ label: 'Yes', answer: 'yes' }];
  if (req.allowAlways) options.push({ label: `Yes, and don't ask again for ${req.scope} this session`, answer: 'always' });
  options.push({ label: 'No, and tell Coder what to do differently (esc)', answer: 'no' });
  const noIndex = options.length - 1;

  const setSel = (n: number) => {
    st.sel = (n + options.length) % options.length;
    rerender();
  };
  const resolve = (a: PermissionAnswer) => {
    if (st.done) return;
    st.done = true;
    pending.resolve(a);
  };
  const choose = (i: number) => {
    const opt = options[i]!;
    if (opt.answer === 'no') return resolve(st.feedback.trim() ? { type: 'no', feedback: st.feedback } : { type: 'no' });
    resolve({ type: opt.answer });
  };

  useKeys((input, key) => {
    if (key.ctrl && input === 'c') return onInterrupt();
    if (key.escape) return resolve({ type: 'no' });
    if (key.upArrow) return setSel(st.sel - 1);
    if (key.downArrow || key.tab) return setSel(st.sel + 1);
    if (key.return) return choose(st.sel);
    // 选中"No"时可以直接输入反馈
    if (st.sel === noIndex) {
      if (key.backspace || key.delete) {
        st.feedback = Array.from(st.feedback).slice(0, -1).join('');
        return rerender();
      }
      if (input && !key.ctrl && !key.meta) {
        st.feedback += input.replace(/\r?\n/g, ' ');
        return rerender();
      }
      return;
    }
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      if (n - 1 === noIndex) return setSel(noIndex);
      return choose(n - 1);
    }
    if (input === 'y') return choose(0);
    if (input === 'a' && req.allowAlways) return choose(1);
    if (input === 'n') return setSel(noIndex);
  });

  const title = TITLES[req.tool.name] ?? req.tool.name;
  // 有风险提示时边框用警告色，其余用主题紫
  const accent = req.reason ? theme.warning : theme.brandDeep;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginTop={1}>
      <Text>
        <Text bold color={req.reason ? theme.warning : theme.brand}>
          {title}
        </Text>
        {req.agentId !== 'root' ? <Text color={theme.brandLight}> · requested by {req.agentId}</Text> : null}
        {queued > 1 ? <Text color={theme.muted}> · {queued - 1} more waiting</Text> : null}
      </Text>
      {req.reason ? <Text color={theme.warning}>⚠ {req.reason}</Text> : null}
      {req.preview ? (
        <Box marginY={1} paddingLeft={1}>
          <Text>{req.preview}</Text>
        </Box>
      ) : (
        <Text> </Text>
      )}
      <Text>Do you want to proceed?</Text>
      {options.map((opt, i) => (
        <Text key={i} {...(i === st.sel ? { color: theme.brand } : {})}>
          {i === st.sel ? '❯ ' : '  '}
          {i + 1}. {opt.label}
        </Text>
      ))}
      {st.sel === noIndex && (
        <Box paddingLeft={5}>
          <Text>
            <Text color={theme.muted}>› </Text>
            {st.feedback ? <Text>{st.feedback}</Text> : <Text color={theme.muted}>type feedback, or press Enter to just stop</Text>}
            <Text inverse> </Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}
