# fwt

`fwt` is a headless coding agent. You give it a task as a prompt. It runs shell commands in a working directory until the task is done, and then it prints the answer.

| Mode | Command | Use it when |
| --- | --- | --- |
| Text | `fwt -p "<prompt>"` | A person or a script needs only the answer. |
| JSON Lines | `fwt -p "<prompt>" -o jsonl` | A program follows the run or needs the session ID. |
| ACP | `fwt acp` | An editor or an orchestrator controls the agent. |

## Install fwt

```sh
npm install -g @moeru-ai/fwt
```

You can also use `npx @moeru-ai/fwt` in place of `fwt`.

## Add a provider

A provider is an API service that hosts models, for example DeepSeek or OpenCode Go. fwt fills in a provider from [models.dev](https://models.dev), then asks for the API key, the model, and whether it becomes the default:

```sh
fwt provider add deepseek
```

For a provider that is not on models.dev, give its base URL and wire protocol. To skip the questions, give every answer as a flag:

```sh
fwt provider add my-gateway --base-url https://gateway.example.com/v1 --protocol chat
fwt provider add deepseek --api-key "$DEEPSEEK_API_KEY" -m deepseek-v4-flash --default yes
```

`fwt provider list` shows your providers. `fwt provider remove <id>` removes one and its saved key.

## Run a task

```sh
fwt -p "Fix the failing test in src/parse.test.ts"
git diff | fwt "Review this diff"
fwt -p "Describe these screenshots" -i before.png -i after.png
```

fwt works in the current directory, or in `--cwd <path>`. Piped input goes into the prompt inside a `<stdin>` block. fwt reads it until it ends, so a program that starts fwt must close standard input or redirect it from `/dev/null`.

With `-o jsonl`, fwt writes one JSON object for each event. A `compaction` event reports a context summary as it starts and ends. The last line has the type `result`, with `sessionId`, `stopReason`, `stopReasonDetail`, `steps`, `text`, and `cacheStats`. The exit code tells you why the run stopped:

| Exit code | `stopReason` | Meaning |
| --- | --- | --- |
| 0 | `completed` | The model gave its final answer. |
| 3 | `context_limit` | fwt could not compact the context enough to continue. `stopReasonDetail` gives the reason. |
| 4 | `loop_detected` | The model made the same tool calls three times in a row. |
| 5 | `max_turns` | The run reached `--max-turns`. |
| 130 | `aborted` | The run was stopped, for example with Ctrl+C. |

## Continue or fork a session

fwt saves each run as a session. `--resume` adds a prompt to the same session. `--fork` copies a session into a new one, so several runs can continue from the same history:

```sh
fwt --resume <sessionId> -p "Also add a test for empty input"
fwt --fork <sessionId> -p "Try the other approach" --cwd ../worktree-b
```

Both accept a session ID, a session file path, or `latest`, which is the newest session in the working directory. A session keeps its provider and model unless you give `--provider`, `--base-url`, or `--model`. A fork runs in the source directory unless you give `--cwd`; fwt then tells the model about the new directory.

## Run fwt as an ACP server

`fwt acp` serves the [Agent Client Protocol](https://agentclientprotocol.com) over standard input and output. It supports version 1 and version 2 (`2.0.0-alpha.15`); the client picks one in `initialize`. Prompts can hold text, images, resources, and resource links.

In `auto` mode, which is the default, fwt runs each tool call. In `ask` mode (`--permission-mode ask`), it asks the client with `session/request_permission` first.

Each session has three config options: `mode`, `model`, and `effort`. A `model` value is `<provider>/<model>`, and the list holds the models of each provider in `config.toml` and on models.dev. A new model or effort applies from the next prompt. The session file keeps the model it started with, so a resumed session starts with that model again.

When no provider is set up, `session/new` fails with error `-32000`. The sign-in method in `initialize` tells the client to run `fwt provider add` in a terminal.

During a prompt, fwt reports token use in `usage_update` and each context summary in `compaction_update`.

## Reference

### Flags

| Flag | Value |
| --- | --- |
| `-p, --prompt <text>` | The prompt. You can also give it as the first argument or on standard input. |
| `-i, --image <path...>` | An image file for the prompt. Repeatable. |
| `-o, --output <text\|jsonl>` | The output format. The default is `text`. |
| `-r, --resume <session>` | Continue a session. |
| `--fork <session>` | Start a new session from a copy of another. |
| `--cwd <path>` | The working directory. |
| `-m, --model <model>` | The model ID. |
| `--provider <provider>` | A provider ID from `config.toml`. |
| `--protocol <chat\|responses\|messages>` | The wire protocol: OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages. |
| `--base-url <url>` | An API base URL. Without `--provider`, fwt uses no configured provider. |
| `--api-key <key>` | The API key. |
| `--effort <effort>` | The reasoning effort, sent as is. |
| `--context-length <tokens>` | The context window. The default comes from models.dev, or 250,000. |
| `--header <header...>` | An extra HTTP header as `"name: value"`. Repeatable. `{session}` becomes the session ID. |
| `--max-turns <count>` | The maximum number of model steps for one prompt. |
| `--permission-mode <auto\|ask>` | The ACP permission mode. |

With `fwt acp`, the model flags, `--max-turns`, and `--permission-mode` apply to each new session.

### Environment variables

`FWT_PROVIDER`, `FWT_MODEL`, `FWT_PROTOCOL`, `FWT_BASE_URL`, `FWT_API_KEY`, `FWT_EFFORT`, and `FWT_CONTEXT_LENGTH` work like their flags. A flag has priority over its variable, and a variable has priority over `config.toml`. `FWT_HOME` puts all fwt files in one directory.

fwt looks for the API key in `--api-key`, `FWT_API_KEY`, the variable that `env_key` names, and then `auth.json`.

### Files

| File | Default location |
| --- | --- |
| Configuration | `~/.config/fwt/config.toml` |
| API keys | `~/.local/share/fwt/auth.json` |
| Sessions | `~/.local/state/fwt/sessions/` |
| models.dev cache | `~/.cache/fwt/models.dev.json` |

fwt follows the `XDG_*_HOME` variables. It writes `config.toml` and `auth.json` with mode `0600`. Only `fwt provider add` connects to models.dev.

### config.toml

```toml
provider = "gateway"
shell = [
  "srt",
  "--settings",
  "/home/me/.config/fwt/srt.json"
]

[providers.gateway]
name = "My gateway"
model = "coder"
env_key = "GATEWAY_API_KEY"
base_url = { chat = "https://gateway.example.com/v1", messages = "https://gateway.example.com/anthropic/v1" }
headers = { x-session-id = "{session}" }

[providers.gateway.models.coder]
context = 131072
max_output = 8192
protocol = "chat"
effort = "high"
image = false
```

`shell` is the program that runs each command, with its arguments. fwt adds `-c <command>` after them. The default is `["/bin/bash"]`, or `["/bin/sh"]` when bash is missing. Model requests and session files do not go through `shell`.

A provider has one base URL for each protocol it serves. Values under `models.<model>` have priority over models.dev. fwt picks the protocol from `--protocol`, then the model's `protocol`, then models.dev, then the first base URL.

### Context and compaction

The output limit for one step is the lowest of the model's `max_output`, 32,768 tokens, and a quarter of the context window. When the input nears 80% of the space left, fwt asks the same model for a summary. The next requests send every user message, the summary, and the latest interactions. The session file keeps the full history, and resume and fork reuse the summary without a new request.

### Retries

fwt retries network errors, status 429, and status 500 and higher up to four times, and waits as `Retry-After` asks, up to 60 seconds. If a stream breaks or sends nothing for 300 seconds, fwt retries that step up to five times. Text that it already streamed can then appear twice.

### Tools

| Tool | Use |
| --- | --- |
| `exec_command` | Runs a shell command with `shell` from `config.toml`. `stdin` is written and then closed. |
| `write_stdin` | Writes to a running command, or reads its new output. |
| `view_image` | Reads a PNG, JPEG, GIF, or WebP file. Only for models that accept images. |

A command that runs longer than `yield_time_ms` (default 10 seconds) keeps running, and the model continues it with `write_stdin`. Commands get no terminal, no colors, and no pager. fwt has no file editing tool; the model edits files with shell commands.

### Project instructions and skills

On a new session, fwt reads `AGENTS.md` from its configuration directory and from each directory between the filesystem root and the working directory. Files closer to the working directory take precedence.

fwt lists the skills in `~/.agents/skills/` and `.agents/skills/`, and the model reads a `SKILL.md` when a task matches. To load a skill into the prompt, write its name after `/` at the start or after `$` anywhere:

```sh
fwt -p '/code-review Review the changes since main'
```
