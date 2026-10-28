// 本地 Skills：扫描各 skills 目录下的 <name>/SKILL.md，解析 frontmatter 中的 name / description
// 系统提示词里只列出名称和描述，模型需要时再通过 Skill 工具加载全文（渐进式披露）

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODER_HOME } from './config.js';
import { defineTool } from './tools/types.js';

export interface Skill {
  name: string;
  description: string;
  /** SKILL.md 的绝对路径 */
  path: string;
  dir: string;
  source: 'user' | 'project';
}

export function skillRoots(cwd: string): { dir: string; source: Skill['source'] }[] {
  return [
    { dir: join(homedir(), '.claude', 'skills'), source: 'user' },
    { dir: join(CODER_HOME, 'skills'), source: 'user' },
    { dir: join(cwd, '.claude', 'skills'), source: 'project' },
    { dir: join(cwd, '.coder', 'skills'), source: 'project' },
  ];
}

/** 极简 YAML frontmatter 解析：支持 key: value、带引号的值、| 和 > 多行块 */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1]!) && !/^[A-Za-z0-9_-]+\s*:/.test(lines[i + 1]!)) block.push(lines[++i]!.trim());
      value = block.join(value.startsWith('|') ? '\n' : ' ').trim();
    } else if (/^(['"]).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    meta[kv[1]!.toLowerCase()] = value;
  }
  return { meta, body: text.slice(m[0].length) };
}

export function discoverSkills(cwd: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const root of skillRoots(cwd)) {
    if (!existsSync(root.dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root.dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = join(root.dir, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const file = ['SKILL.md', 'skill.md'].map((f) => join(dir, f)).find((f) => existsSync(f));
      if (!file) continue;
      try {
        const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'));
        const fallback = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? '';
        const skill: Skill = {
          name: (meta.name || entry).trim(),
          description: (meta.description || fallback).slice(0, 500),
          path: file,
          dir,
          source: root.source,
        };
        byName.set(skill.name.toLowerCase(), skill); // 后扫描的（项目级）覆盖用户级同名 skill
      } catch {
        /* 跳过无法读取的 skill */
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const skillTool = defineTool<{ name: string }>({
  name: 'Skill',
  kind: 'read',
  description:
    'Load the full instructions of a local skill listed in the system prompt under "Available skills". ' +
    'Call it when the task matches a skill description, then follow the instructions. ' +
    'Files referenced by the skill are relative to the skill directory returned in the result.',
  input_schema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Skill name exactly as listed' } },
    required: ['name'],
  },
  summary: (i) => i.name,
  async run(input, ctx) {
    const skill = ctx.runtime.skills.find((s) => s.name.toLowerCase() === input.name.trim().toLowerCase());
    if (!skill) {
      const names = ctx.runtime.skills.map((s) => s.name).join(', ') || '(none)';
      throw new Error(`Skill "${input.name}" not found. Available skills: ${names}`);
    }
    const content = readFileSync(skill.path, 'utf8');
    return `Skill: ${skill.name}\nBase directory: ${skill.dir}\n(Relative paths in this skill are relative to the base directory.)\n\n${content}`;
  },
  display: (out) => `Loaded ${out.split('\n')[0]?.replace('Skill: ', '') ?? 'skill'}`,
});
