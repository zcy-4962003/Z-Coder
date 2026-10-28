// 全局唯一的键盘输入入口
// Ink 的 useInput 在组件挂载/卸载时会切换 raw mode，组件切换（输入框 <-> 确认框）的瞬间按下的键可能丢失。
// 这里只在根组件挂一次 useInput/usePaste，子组件通过 useKeys 在 commit 阶段同步注册处理函数。

import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useInput, usePaste, type Key } from 'ink';

export type KeyHandler = (input: string, key: Key) => void;
export type PasteHandler = (text: string) => void;

interface Owner {
  token: object;
  onKey: KeyHandler;
  onPaste: PasteHandler | null;
}

const InputContext = createContext<{ current: Owner | null } | null>(null);

export function InputRoot({ children }: { children: ReactNode }) {
  const owner = useRef<Owner | null>(null);
  useInput((input, key) => owner.current?.onKey(input, key));
  usePaste((text) => owner.current?.onPaste?.(text));
  const value = useMemo(() => owner, []);
  return <InputContext.Provider value={value}>{children}</InputContext.Provider>;
}

/** 注册当前组件为键盘输入的接收者（最后挂载的组件生效） */
export function useKeys(onKey: KeyHandler, onPaste?: PasteHandler): void {
  const ctx = useContext(InputContext);
  if (!ctx) throw new Error('useKeys must be used inside <InputRoot>');
  const token = useRef({}).current;

  // 每次 commit 都更新为最新的处理函数，避免闭包过期
  useLayoutEffect(() => {
    ctx.current = { token, onKey, onPaste: onPaste ?? null };
  });
  useLayoutEffect(
    () => () => {
      if (ctx.current?.token === token) ctx.current = null;
    },
    [ctx, token],
  );
}
