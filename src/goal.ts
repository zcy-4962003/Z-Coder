// 进程内 Goal：用户设定目标后，每轮结束自动推进，直到 Agent 显式调用 goal_complete 或被暂停

import { defineTool } from './tools/types.js';

export type GoalStatus = 'active' | 'paused' | 'completed';

export interface Goal {
  text: string;
  status: GoalStatus;
  /** 已自动推进的轮数 */
  iterations: number;
  maxIterations: number;
  createdAt: number;
  pausedReason?: string;
  summary?: string;
  evidence?: string;
}

export class GoalManager {
  goal: Goal | null = null;
  private readonly listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  isActive(): boolean {
    return this.goal?.status === 'active';
  }

  set(text: string, maxIterations = 20): Goal {
    this.goal = { text, status: 'active', iterations: 0, maxIterations, createdAt: Date.now() };
    this.emit();
    return this.goal;
  }

  pause(reason = 'paused by user'): boolean {
    if (this.goal?.status !== 'active') return false;
    this.goal.status = 'paused';
    this.goal.pausedReason = reason;
    this.emit();
    return true;
  }

  resume(): boolean {
    if (this.goal?.status !== 'paused') return false;
    this.goal.status = 'active';
    delete this.goal.pausedReason;
    // 因达到上限而暂停的，恢复时再给一轮额度
    if (this.goal.iterations >= this.goal.maxIterations) this.goal.maxIterations = this.goal.iterations + 10;
    this.emit();
    return true;
  }

  complete(summary: string, evidence: string): void {
    if (!this.goal) return;
    this.goal.status = 'completed';
    this.goal.summary = summary;
    this.goal.evidence = evidence;
    this.emit();
  }

  clear(): void {
    this.goal = null;
    this.emit();
  }

  /** 首轮提示词 */
  startPrompt(): string {
    const g = this.goal!;
    return (
      `[Goal] The user has set a goal for this session:\n\n${g.text}\n\n` +
      `Work toward it autonomously across multiple turns. Plan with update_plan, make concrete progress each turn, and verify your work. ` +
      `When — and only when — the goal is fully achieved and verified, call the goal_complete tool with a summary and evidence. ` +
      `If you are blocked and need the user's input, say so clearly and stop.`
    );
  }

  /** 自动推进的提示词（会递增轮数） */
  continuePrompt(): string {
    const g = this.goal!;
    g.iterations++;
    this.emit();
    return (
      `[Goal auto-continue ${g.iterations}/${g.maxIterations}] Continue working toward the goal:\n\n${g.text}\n\n` +
      `Review the current plan and state, then take the next concrete step. ` +
      `If the goal is fully achieved and verified, call goal_complete with a summary and evidence instead of doing more work.`
    );
  }

  /** 显式完成检查 */
  checkPrompt(): string {
    const g = this.goal!;
    return (
      `[Goal completion check] Rigorously verify whether this goal is fully achieved:\n\n${g.text}\n\n` +
      `Inspect the actual current state (files, build/test output, etc.) instead of relying on memory. ` +
      `If it is achieved, call goal_complete with a summary and concrete evidence. ` +
      `If not, list exactly what remains and do NOT call goal_complete. Do not make code changes during this check.`
    );
  }
}

export const goalCompleteTool = defineTool<{ summary: string; evidence: string }>({
  name: 'goal_complete',
  kind: 'read',
  description:
    'Mark the active session goal as completed. Only call this after verifying that the goal is fully achieved. ' +
    'Provide a short summary of what was done and concrete evidence (e.g. tests passing, files changed, command output).',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'What was accomplished' },
      evidence: { type: 'string', description: 'How you verified it' },
    },
    required: ['summary', 'evidence'],
  },
  summary: () => 'mark goal complete',
  async run(input, ctx) {
    const goal = ctx.runtime.goal;
    if (!goal.isActive()) throw new Error('There is no active goal.');
    goal.complete(input.summary, input.evidence);
    return 'Goal marked as completed. Give the user a brief final summary.';
  },
  display: (_out, input) => `◎ Goal completed: ${input.summary}`,
});
