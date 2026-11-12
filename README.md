# dsh-subagent-agy

把 [Antigravity](https://antigravity.google) 的 CLI（`agy`）接成 DeepSeek Harness 的子智能体：每次委派在独立进程里跑一个 ACP 会话，只把最终答案带回父会话。

相对上游 `@deepseek-ai/dsh-subagent-acp` 的增强：

| 能力 | 说明 |
| --- | --- |
| **按会话键复用** | `subagent_agy(session: "alpha")` 与 `"beta"` 是两条独立 agy 会话，可并行；同名再调则续接该会话 |
| **完整 transcript** | 每条 ACP `session/update`（文本、思考、工具调用、工具结果、计划）落成 Markdown + 原始 JSONL |
| **模型固定** | 通过 `session/set_model` 指定每次运行使用的模型 |
| **用量记录** | `session/prompt` 返回的 input/output/cache/thought token 写入运行元数据 |
| **重放隔离** | `session/load` 会重放历史；重放只进 JSONL，不进最终答案 |

## 安装

### 从 GitHub 安装（推荐）

在 DSH 的 Plugins → Add plugin 填：

```
github:douglarek/dsh-subagent-agy
```

**更新与切换安装方式后需要重启 App**：宿主的模块加载器会缓存包的解析路径，热重载不足以切到新副本。

## 工具参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `session` | 否 | 会话键（`[A-Za-z0-9_-]{1,32}`）。同名续接，异名并行；省略时按当前 DSH 会话复用 |
| `description` | 是 | 3–5 词的任务描述，显示在子智能体列表 |
| `prompt` | 是 | 自包含的任务；子 agent 看不到本对话 |
| `cwd` | 否 | 子进程工作目录，省略则继承 |

并发语义：不同 `session` 的委派互不阻塞；同一个 `session` 并发调用会竞争同一条 agy 会话（agy 端可能报错），需要并行就换键。

## Provider 配置

改 `cordis.patch.yml` 里 `subagent-agy` 行的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `providerName` | `agy` | 注册在 `ctx.subagents` 上的名字 |
| `command` | `agy` | ACP 可执行文件，默认走 PATH。从 GUI 启动的 App 通常没有 `~/.local/bin`，装在那里就填绝对路径（见下方「常见问题」） |
| `args` | `['acp']` | 可追加 `--sandbox`、`--agent <name>` |
| `permission` | `allow` | `allow` 自动选第一个 allow 选项；`reject` 一律拒绝 |
| `model` | `''` | 非空时每次运行前 `session/set_model` |
| `reuseSession` | `true` | 按会话键复用 agy 会话 |
| `transcriptDir` | `''` | 空 = `~/.dsh/agy-runs` |
| `env` | `{}` | 叠加在清洗过的父环境之上 |

## Transcript 在哪

```
~/.dsh/agy-runs/<父会话 id>/
├── sessions/<键>.json        # 该键当前复用的 agy 会话 id / cwd
├── <时间戳>-<runId>.md       # 可读：思考、工具调用、参数、结果、最终答案
├── <时间戳>-<runId>.jsonl    # 原始 session/update（含 replay 标记）
├── <时间戳>-<runId>.meta.json# 该次运行的 runId/sessionId/stopReason/usage
├── latest.md -> 最近一次 .md
└── latest.json -> 最近一次 .meta.json
```

`tail -f latest.md` 可近实时查看；DSH 文件预览打开 `.md` 即可阅读。

## 常见问题

### 委派立刻失败：`spawn agy ENOENT`

`cordis.patch.yml` 里的 `command` 在**宿主的** PATH 上找不到（GUI 启动的 App 通常不含 `~/.local/bin`）。把绝对路径写进 profile 补丁层覆盖 bundle 默认值——`~/.dsh/profiles/<profile>/cordis.patch.yml`，它在所有 bundle 层之后应用：

```yaml
- id: subagent-agy
  name: '@douglarek/dsh-subagent-agy/provider'
  config:
    providerName: agy
    command: /home/<you>/.local/bin/agy
    args: ['acp']
    permission: allow
    model: ''
    reuseSession: true
    transcriptDir: ''
```

改完重启 App。二进制本身可先用 `agy --version` 和一次 `agy acp` 的 `initialize` 握手确认。

## 已知限制

1. **父会话里没有实时流**：DSH 外部 run 没有进度通道，流式内容只能看 transcript。
2. **子智能体列表里不可点开**：外部 run 没有本地 Session（`mode: 'external'`），core UI 的会话历史入口不适用。
3. **权限只有两档**：`allow` / `reject`。

## License

MIT
