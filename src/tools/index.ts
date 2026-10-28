// 工具集组装：root agent 拥有全部工具；worker 只有只读工具

import { goalCompleteTool } from '../goal.js';
import type { Runtime } from '../runtime.js';
import { skillTool } from '../skills.js';
import { closeAgentTool, spawnAgentTool, waitAgentTool } from '../subagents.js';
import { askUserTool } from './ask.js';
import { editTool, readTool, writeTool } from './file-tools.js';
import { updatePlanTool } from './plan.js';
import { globTool, grepTool } from './search-tools.js';
import { bashTool } from './shell.js';
import type { Tool } from './types.js';
import { webFetchTool, webSearchTool } from './web.js';

export function rootTools(runtime: Runtime): Tool[] {
  const tools: Tool[] = [readTool, writeTool, editTool, globTool, grepTool, bashTool, updatePlanTool, webFetchTool, webSearchTool];
  if (runtime.askUser) tools.push(askUserTool);
  if (runtime.skills.length) tools.push(skillTool);
  if (runtime.workers) tools.push(spawnAgentTool, waitAgentTool, closeAgentTool);
  if (runtime.goal.isActive()) tools.push(goalCompleteTool);
  tools.push(...runtime.mcp.tools());
  return tools;
}

export function workerTools(runtime: Runtime): Tool[] {
  const tools: Tool[] = [readTool, globTool, grepTool, webFetchTool, webSearchTool];
  if (runtime.skills.length) tools.push(skillTool);
  tools.push(...runtime.mcp.tools().filter((t) => t.kind === 'read'));
  return tools;
}

export type { Tool, ToolContext } from './types.js';
