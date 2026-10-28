// 运行时容器：把 Plan、子 Agent、Goal、Skills、MCP 等跨模块共享的状态集中在一处，供工具和命令访问

import type { LLMProvider } from './llm/types.js';
import type { McpManager } from './mcp/manager.js';
import type { Permissions } from './permissions.js';
import type { ResultStore } from './results.js';
import type { Skill } from './skills.js';
import type { GoalManager } from './goal.js';
import type { WorkerManager } from './subagents.js';
import type { WebSearchConfig } from './tools/web.js';

export type PlanStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanItem {
  step: string;
  status: PlanStatus;
}

export interface Plan {
  items: PlanItem[];
  explanation: string;
}

export interface Question {
  question: string;
  options: string[];
  multiSelect: boolean;
}

export interface Runtime {
  cwd: string;
  provider: LLMProvider;
  permissions: Permissions;
  maxTokens: number;
  contextLimit: number;
  /** 同一进程内、跨 root 回合共享的计划清单（内存，不持久化） */
  plan: Plan;
  skills: Skill[];
  mcp: McpManager;
  results: ResultStore;
  goal: GoalManager;
  /** 由 index.ts 创建后注入（WorkerManager 依赖 Runtime 自身） */
  workers: WorkerManager | null;
  /** 交互模式下向用户提问；非交互模式为 null */
  askUser: ((q: Question, signal: AbortSignal) => Promise<string>) | null;
  /** 允许读取的工作目录之外的根目录（工具结果落盘目录、skills 目录等） */
  trustedReadRoots: string[];
  webSearch: WebSearchConfig;
}
