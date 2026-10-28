import { defineTool } from './types.js';

export const askUserTool = defineTool<{ question: string; options?: string[]; multi_select?: boolean }>({
  name: 'AskUserQuestion',
  kind: 'read',
  description:
    'Ask the user a clarifying question and wait for the answer. Use it only when a decision materially changes the result ' +
    'and cannot be inferred from the code or context (e.g. ambiguous requirements, choosing between approaches). ' +
    'Provide 2-5 concise options when possible; the user can always type a custom answer.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask' },
      options: { type: 'array', items: { type: 'string' }, description: 'Suggested answers (optional)' },
      multi_select: { type: 'boolean', description: 'Allow selecting multiple options (default false)' },
    },
    required: ['question'],
  },
  summary: (i) => (i.question.length > 80 ? i.question.slice(0, 80) + '…' : i.question),
  async run(input, ctx) {
    const ask = ctx.runtime.askUser;
    if (!ask || ctx.agentId !== 'root') {
      throw new Error('No interactive user is available. Make a reasonable assumption, state it explicitly, and continue.');
    }
    const answer = await ask(
      { question: input.question, options: (input.options ?? []).filter((o) => typeof o === 'string' && o.trim()).slice(0, 8), multiSelect: !!input.multi_select },
      ctx.signal,
    );
    return answer.trim() ? `The user answered: ${answer}` : 'The user dismissed the question without answering. Proceed with your best judgment.';
  },
  display: (out) => out.replace(/^The user answered: /, '→ '),
});
