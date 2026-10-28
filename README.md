# Coder

一个用 TypeScript 编写的迷你版 Claude Code 风格终端编程 Agent。界面基于 Ink（React），模型调用、MCP 客户端、Web 工具等均基于 Node 原生 `fetch` / `child_process` 实现，不依赖任何 SDK。

## 快速开始

```bash
npm install
npm run build

# 使用 Anthropic
set ANTHROPIC_API_KEY=sk-ant-xxx           # PowerShell：$env:ANTHROPIC_API_KEY="sk-ant-xxx"
node dist/index.js
# 使用任意 OpenAI 兼容接口（以 DeepSeek 为例）
set OPENAI_API_KEY=sk-xxx
set OPENAI_BASE_URL=https://api.deepseek.com/v1
node dist/index.js --provider openai -m deepseek-chat

# 单次运行模式
node dist/index.js -p "讲解一下这个项目的结构"
```

Agent 的工作目录就是启动时所在的目录。执行 `npm link` 后即可在任意目录使用 `coder` 命令。

## 配置文件

`~/.coder/config.json`（全局）：

```json
{
  "provider": "openai",
  "model": "deepseek-chat",
  "apiKey": "sk-xxx",
  "baseUrl": "https://api.deepseek.com/v1",
  "maxTokens": 8192,
  "contextLimit": 128000,
  "toolResultLimit": 20000,
  "webSearch": { "provider": "auto" },
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${MY_TOKEN}" } }
  }
}
```

配置优先级：命令行参数 > 环境变量 > `config.json` > 默认值。

## 命令行参数

| 参数 | 说明 |
| --- | --- |
| `-p, --print` | 非交互模式：执行提示词后退出（也可从管道读取输入） |
| `-c, --continue` | 恢复当前目录最近一次会话 |
| `-r, --resume <ref>` | 按序号、ID 或名称恢复会话（见 `/sessions`） |
| `-m, --model <name>` | 指定模型 |
| `--provider <name>` | `anthropic` 或 `openai`（OpenAI 兼容接口） |
| `--accept-edits` | 自动允许工作目录内的文件修改 |
| `--yolo` | 自动允许所有操作（危险命令仍需确认） |
| `-h, --help` / `-v, --version` | 帮助 / 版本 |

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Anthropic 的密钥和接口地址 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI 兼容接口的密钥和地址 |
| `CODER_PROVIDER` / `CODER_MODEL` | 默认提供方 / 模型 |
| `CODER_API_KEY` / `CODER_BASE_URL` | 通用密钥 / 地址（优先于上面两组） |
| `CODER_MAX_TOKENS` | 单次回复最大 token 数，默认 8192 |
| `CODER_CONTEXT_LIMIT` | 上下文窗口大小（Anthropic 默认 200k，其它默认 128k） |
| `CODER_TOOL_RESULT_LIMIT` | 工具结果超过该字符数时落盘，默认 20000 |
| `CODER_WEB_SEARCH` | 搜索提供方：`auto` / `tavily` / `brave` / `bing` |
| `TAVILY_API_KEY` / `BRAVE_API_KEY` | 搜索 API 密钥；`auto` 模式下有哪个用哪个，都没有时退回解析 Bing 网页 |
| `CODER_SHELL` | Bash 工具使用的 shell（Windows 默认 PowerShell，其它平台默认 bash） |

## 功能

| 功能 | 说明 |
| --- | --- |
| Agent 循环 | 单轮内 model → tool → model 闭环，直到模型不再调用工具（每次请求最多 50 轮） |
| 双协议 | Anthropic Messages API，以及 OpenAI 兼容的 Chat Completions 接口 |
| 内置工具 | `Read` `Write` `Edit` `Glob` `Grep` `Bash` `WebFetch` `WebSearch` `AskUserQuestion` `update_plan` `Skill`，以及子 Agent 工具 |
| 子 Agent | `spawn_agent` 启动只读 worker（最多 3 个并发，后台运行，只能读文件 / 搜索 / 上网）；root 通过 `wait_agent` 等待结果、`close_agent` 主动关闭；所有代码修改只由 root 完成 |
| 计划清单 | 内存中的 Plan，同一进程内跨回合共享；Agent 通过 `update_plan` 更新，用户通过 `/plan` 查看 |
| Goal | `/goal <目标>` 设置后，每轮结束自动推进，直到 Agent 调用 `goal_complete` 显式完成；支持暂停、恢复、完成检查；中断或出错时自动暂停；默认最多自动推进 20 轮 |
| Loop | `/loop 5m <提示词>` 每轮完成后按固定间隔重复执行；与 Goal 共用 Plan，与启用中的 Goal 互斥 |
| 安全编辑 | 必须先 Read 才能 Edit/Write；文件被外部修改后需要重新读取；保留 CRLF/LF；修改前展示 diff 预览 |
| 权限检查 | 见下文"权限" |
| 上下文管理 | 统计优先使用 provider 返回的 usage，加上之后新增消息的估算（tail estimate）；超过 60% 折叠较早的大块工具结果；超过 80% 自动总结压缩；总结失败或请求超长时裁剪最早的对话后重试 |
| 结果落盘 | 超过 `toolResultLimit` 的工具结果完整保存到 `~/.coder/tool-results/`，上下文中只保留头尾预览和文件路径（保留 7 天） |
| Skills | 从 `~/.coder/skills/`、`~/.claude/skills/`、`<项目>/.coder/skills/`、`<项目>/.claude/skills/` 下发现 `<name>/SKILL.md`；系统提示词只列名称和描述，需要时通过 `Skill` 工具加载全文 |
| MCP | 支持 stdio 和远程 Streamable HTTP（JSON / SSE 响应）；接入 tools（`mcp__<server>__<tool>`）、resources（`ListMcpResources` / `ReadMcpResource`）和 prompts（作为 `/mcp__<server>__<prompt>` 斜杠命令）；配置来自 `config.json` 的 `mcpServers` 和项目根目录的 `.mcp.json`，支持 `${环境变量}` |
| 会话 | 按项目隔离保存到 `~/.coder/sessions/`；支持列出、恢复、重命名、分叉 |
| 项目记忆 | 自动加载 `~/.coder/CODER.md`，以及项目根目录下的 `CODER.md` / `AGENTS.md` / `CLAUDE.md`（存在的全部加载）；`/init` 自动生成 |
| 中断 | `Esc` 或 `Ctrl+C` 中断当前任务（同时终止正在运行的子进程）；连按两次 `Ctrl+C` 退出 |

## 权限

| 模式 | 行为 |
| --- | --- |
| `default` | 修改文件、执行命令、访问网络都需要确认 |
| `acceptEdits` | 工作目录内的文件修改自动允许，其余仍需确认 |
| `yolo` | 除危险操作外全部自动允许 |

额外规则（任何模式下都生效）：

- **路径边界**：写入工作目录以外的文件始终需要确认；读取工作目录以外的文件需要确认（工具结果落盘目录、skills 目录除外）。
- **敏感文件**：`.env*`、私钥、`.ssh` 等目录、`~/.coder/config.json`，读取需确认，写入在 yolo 模式下也需确认。
- **危险命令**：`rm -rf`、`git push`、`git reset --hard`、`Remove-Item -Recurse`、`curl ... | sh` 等，yolo 模式下也需确认，且不提供"始终允许"。
- **安全命令**：`git status/diff/log`、`ls`、`node --version` 等只读命令（不含管道、重定向、串联）无需确认。
- **复合命令**：含管道、重定向、`;`、`&&` 的命令不提供"始终允许"，避免借前缀绕过。
- "始终允许"的粒度：Bash 按命令首词，WebFetch 按域名，其它按工具名。
- 只读 worker 发起的确认请求会标注来源，多个请求排队逐个展示。

## 斜杠命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 查看命令列表和快捷键 |
| `/clear` | 清空对话和计划，开始新会话 |
| `/compact [说明]` | 压缩对话以释放上下文 |
| `/context` | 查看上下文用量（provider usage + tail estimate） |
| `/model [名称]` | 查看或切换模型 |
| `/mode [default\|acceptEdits\|yolo]` | 查看或切换权限模式（不带参数时循环切换） |
| `/cost` | 查看 token 用量 |
| `/plan` | 查看计划清单（`/todos` 为别名） |
| `/agents [close <id\|all>]` | 查看或关闭子 Agent |
| `/goal [<目标>\|pause\|resume\|check\|clear]` | 设置 / 查看 / 暂停 / 恢复 / 检查 / 清除 Goal |
| `/loop [<间隔> <提示词>\|stop]` | 启动 / 查看 / 停止 Loop，间隔如 `30s`、`5m`、`1h`（最小 10 秒） |
| `/sessions` | 列出当前项目的会话 |
| `/resume <序号\|ID\|名称>` | 恢复会话 |
| `/rename <名称>` | 重命名当前会话 |
| `/fork [名称]` | 把当前对话复制为新会话并切换过去（原会话不变） |
| `/skills [reload]` | 查看已发现的 skills；`reload` 重新扫描 skills 目录（无需重启） |
| `/mcp` | 查看 MCP 服务器状态、工具、资源和 prompts |
| `/memory` | 查看已加载的项目记忆文件 |
| `/init` | 分析项目并生成 `CODER.md` |
| `/exit` | 退出 |

输入以 `\` 结尾（或 `Alt+Enter`）可以换行继续输入；输入 `@` 可补全文件路径。

## 目录结构

```
src/
├── index.ts          CLI 入口：参数解析，分流到交互模式 / 单次运行模式
├── bootstrap.ts      组装运行时（Provider、权限、Skills、MCP、Goal、子 Agent）
├── runtime.ts        运行时共享状态的类型定义（Plan、Question 等）
├── agent.ts          Agent 主循环、工具调度、上下文治理（root 与 worker 共用）
├── context.ts        token 估算、usage + tail 统计、折叠、裁剪
├── results.ts        超大工具结果落盘
├── subagents.ts      只读 worker 管理 + spawn_agent / wait_agent / close_agent
├── goal.ts           Goal 状态与 goal_complete 工具
├── loop.ts           Loop 调度与时间间隔解析
├── skills.ts         SKILL.md 发现 + Skill 工具
├── commands.ts       斜杠命令（含 MCP prompts）
├── config.ts         配置加载
├── permissions.ts    权限模式、路径边界、敏感文件、危险命令规则
├── prompt.ts         系统提示词（root / worker）、项目记忆、/init 和 /compact 的提示词
├── session.ts        会话持久化：列出、恢复、重命名、分叉
├── markdown.ts       Markdown → 终端彩色文本
├── view.ts           Agent 与界面之间的接口；单次运行模式的控制台输出
├── ui.ts             颜色、diff、输出预览
├── llm/              Anthropic / OpenAI 兼容流式适配器、HTTP 重试与 SSE 解析
├── mcp/
│   ├── client.ts     MCP 客户端（JSON-RPC 2.0，stdio / Streamable HTTP）
│   └── manager.ts    多服务器管理，tools / resources / prompts 接入
├── tools/
│   ├── index.ts      root / worker 工具集组装
│   ├── types.ts      工具接口定义
│   ├── validate.ts   参数校验
│   ├── file-tools.ts Read / Write / Edit
│   ├── search-tools.ts Glob / Grep
│   ├── shell.ts      Bash（Windows 默认 PowerShell）
│   ├── web.ts        WebFetch / WebSearch
│   ├── ask.ts        AskUserQuestion
│   └── plan.ts       update_plan
└── tui/              Ink 界面：状态容器、控制器、输入框、权限确认框、提问框、组件
```

## 添加新工具

1. 在 `src/tools/` 下用 `defineTool({...})` 创建工具。`kind` 取值：`read`（只读，无需确认）、`edit`（修改文件）、`exec`（执行命令）、`network`（访问网络）。需要自定义权限规则时实现 `checkPermission`。
2. 在 `src/tools/index.ts` 的 `rootTools`（以及只读工具的 `workerTools`）中注册。
3. 执行 `npm run build` 重新编译。
