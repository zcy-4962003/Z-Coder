import type { Plan, PlanItem } from '../runtime.js';
import { defineTool } from './types.js';
import { c } from '../ui.js';

export function renderPlan(plan: Plan, color = true): string {
  if (!plan.items.length) return '(no plan)';
  const lines = plan.items.map((t) => {
    if (!color) return `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'} ${t.step}`;
    if (t.status === 'completed') return c.green('☒ ') + c.dim(t.step);
    if (t.status === 'in_progress') return c.yellow('◐ ') + c.bold(t.step);
    return '☐ ' + t.step;
  });
  if (plan.explanation) lines.unshift(color ? c.dim(plan.explanation) : plan.explanation);
  return lines.join('\n');
}

const STATUSES = new Set(['pending', 'in_progress', 'completed']);

export const updatePlanTool = defineTool<{ plan: PlanItem[]; explanation?: string }>({
  name: 'update_plan',
  kind: 'read',
  description:
    'Create or update the shared task plan. It persists across turns in this session (the user can view it with /plan). ' +
    'Use it for multi-step tasks (3+ steps). Always send the FULL list. Keep at most one step in_progress, and mark steps completed as soon as they are done.',
  input_schema: {
    type: 'object',
    properties: {
      explanation: { type: 'string', description: 'Optional short note about why the plan changed' },
      plan: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            step: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['step', 'status'],
        },
      },
    },
    required: ['plan'],
  },
  summary: (i) => `${i.plan?.length ?? 0} steps`,
  async run(input, ctx) {
    for (const t of input.plan) {
      if (typeof t?.step !== 'string' || !STATUSES.has(t.status)) throw new Error(`Invalid plan item: ${JSON.stringify(t)}`);
    }
    if (input.plan.filter((t) => t.status === 'in_progress').length > 1) throw new Error('At most one step can be in_progress.');
    const plan = ctx.runtime.plan;
    plan.items = input.plan.map((t) => ({ step: t.step, status: t.status }));
    plan.explanation = input.explanation ?? '';
    return `Plan updated:\n${renderPlan(plan, false)}`;
  },
  display: (_out, input) => renderPlan({ items: input.plan, explanation: input.explanation ?? '' }),
});
