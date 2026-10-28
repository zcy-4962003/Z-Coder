import { useReducer, useRef } from 'react';
import { Box, Text } from 'ink';
import { useKeys } from './input.js';
import type { PendingQuestion } from './store.js';

/** AskUserQuestion 的提问框：方向键选择，最后一项可自由输入；多选时用空格勾选 */
export function QuestionDialog({ pending, onInterrupt }: { pending: PendingQuestion; onInterrupt: () => void }) {
  const { question } = pending;
  const st = useRef({ sel: 0, custom: '', checked: new Set<number>(), done: false }).current;
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const opts = question.options;
  const customIndex = opts.length; // 最后一项：自定义回答
  const total = opts.length + 1;

  const finish = (answer: string) => {
    if (st.done) return;
    st.done = true;
    pending.resolve(answer);
  };
  const submit = () => {
    if (st.sel === customIndex || !opts.length) return finish(st.custom.trim());
    if (question.multiSelect) {
      const picked = [...st.checked].sort().map((i) => opts[i]!);
      if (st.custom.trim()) picked.push(st.custom.trim());
      return finish(picked.length ? picked.join('; ') : opts[st.sel]!);
    }
    finish(opts[st.sel]!);
  };

  useKeys((input, key) => {
    if (key.ctrl && input === 'c') return onInterrupt();
    if (key.escape) return finish('');
    if (key.upArrow) {
      st.sel = (st.sel - 1 + total) % total;
      return rerender();
    }
    if (key.downArrow || key.tab) {
      st.sel = (st.sel + 1) % total;
      return rerender();
    }
    if (key.return) return submit();
    if (st.sel === customIndex) {
      if (key.backspace || key.delete) st.custom = Array.from(st.custom).slice(0, -1).join('');
      else if (input && !key.ctrl && !key.meta) st.custom += input.replace(/\r?\n/g, ' ');
      return rerender();
    }
    if (question.multiSelect && input === ' ') {
      if (st.checked.has(st.sel)) st.checked.delete(st.sel);
      else st.checked.add(st.sel);
      return rerender();
    }
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= opts.length) {
      st.sel = n - 1;
      if (!question.multiSelect) return submit();
      if (st.checked.has(st.sel)) st.checked.delete(st.sel);
      else st.checked.add(st.sel);
      return rerender();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text bold color="cyan">
        ? {question.question}
      </Text>
      <Text> </Text>
      {opts.map((o, i) => (
        <Text key={i} {...(i === st.sel ? { color: 'cyan' } : {})}>
          {i === st.sel ? '❯ ' : '  '}
          {question.multiSelect ? (st.checked.has(i) ? '[x] ' : '[ ] ') : `${i + 1}. `}
          {o}
        </Text>
      ))}
      <Text {...(st.sel === customIndex ? { color: 'cyan' } : {})}>
        {st.sel === customIndex ? '❯ ' : '  '}
        {opts.length ? `${question.multiSelect ? '    ' : `${opts.length + 1}. `}` : ''}
        {st.custom ? <Text>{st.custom}</Text> : <Text dimColor>{opts.length ? 'Other (type your answer)' : 'Type your answer'}</Text>}
        {st.sel === customIndex ? <Text inverse> </Text> : null}
      </Text>
      <Text dimColor>
        {question.multiSelect ? 'space to toggle · ' : ''}enter to submit · esc to dismiss
      </Text>
    </Box>
  );
}
