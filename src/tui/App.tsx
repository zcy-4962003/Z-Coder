import { useSyncExternalStore } from 'react';
import { Box, Static, Text, useWindowSize } from 'ink';
import { ActiveTool, AssistantText, HistoryView, Spinner, StatusBar, WorkersPanel, type BannerInfo, type StatusInfo } from './components.js';
import type { Controller } from './controller.js';
import { PermissionDialog } from './PermissionDialog.js';
import { PromptInput } from './PromptInput.js';
import { QuestionDialog } from './QuestionDialog.js';
import { InputRoot } from './input.js';

export function App({ controller, banner }: { controller: Controller; banner: BannerInfo }) {
  const { store, agent, runtime } = controller;
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const { columns } = useWindowSize();
  const width = Math.max(40, columns || 80);
  const interaction = state.interaction;

  const showSpinner = !interaction && (!!state.status || state.activeTools.length > 0);
  const stats = agent.contextStats();
  const goal = runtime.goal.goal;
  const loop = controller.loop.state;
  const mcp = runtime.mcp.clients;
  const status: StatusInfo = {
    mode: runtime.permissions.mode,
    hint: state.hint,
    model: runtime.provider.model,
    contextPct: (stats.total / runtime.contextLimit) * 100,
    contextEstimated: stats.estimated,
    queued: state.queue.length,
    goal: goal && goal.status !== 'completed' ? { status: goal.status, iterations: goal.iterations, max: goal.maxIterations } : null,
    loop: loop ? { intervalMs: loop.intervalMs, nextAt: loop.nextAt, iterations: loop.iterations } : null,
    mcp: mcp.length ? { connected: mcp.filter((c) => c.status === 'connected').length, total: mcp.filter((c) => c.status !== 'disabled').length } : null,
  };

  return (
    <InputRoot>
      <Static key={state.staticKey} items={state.history}>
        {(item) => (
          <Box key={item.id} width={width} flexDirection="column">
            <HistoryView item={item} banner={banner} width={width} />
          </Box>
        )}
      </Static>

      <Box flexDirection="column" width={width}>
        {state.streaming ? <AssistantText text={state.streaming} continued={state.streamingContinued} width={width} /> : null}
        {state.activeTools.map((t) => (
          <ActiveTool key={t.id} tool={t} />
        ))}
        <WorkersPanel workers={state.workers} />
        {interaction?.kind === 'permission' ? (
          <PermissionDialog key={interaction.id} pending={interaction} queued={state.pendingInteractions} onInterrupt={controller.interrupt} />
        ) : null}
        {interaction?.kind === 'question' ? <QuestionDialog key={interaction.id} pending={interaction} onInterrupt={controller.interrupt} /> : null}
        {showSpinner ? <Spinner key={state.busySince} label={state.status?.label ?? 'Working'} startedAt={state.busySince} /> : null}
        {state.queue.map((q, i) => (
          <Box key={i} paddingLeft={2}>
            <Text dimColor>
              ⎿ queued: {(q.display ?? q.text).length > 80 ? (q.display ?? q.text).slice(0, 80) + '…' : q.display ?? q.text}
            </Text>
          </Box>
        ))}

        <Box flexDirection="column" marginTop={1}>
          {interaction ? null : (
            <PromptInput
              busy={state.busy}
              commands={controller.commands()}
              getFiles={controller.getFiles}
              onSubmit={controller.submit}
              onInterrupt={controller.interrupt}
              onCtrlCEmpty={controller.ctrlCEmpty}
              onShiftTab={controller.cycleMode}
            />
          )}
          <StatusBar info={status} />
        </Box>
      </Box>
    </InputRoot>
  );
}
