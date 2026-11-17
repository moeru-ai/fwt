# fwt

`fwt` is a headless coding agent. You give it a task as a prompt. It runs shell commands in a working directory until the task is done, and then it prints the answer.

fwt runs in one of three modes. All of them use the same agent, providers, and sessions:

| Mode | Command | Output | Use it when |
| --- | --- | --- | --- |
| Text | `fwt -p "<prompt>"` | The final answer on standard output | A person or a script needs only the answer. |
| JSON Lines | `fwt -p "<prompt>" -o jsonl` | One JSON object for each event, and a `result` line | A program follows the run or needs the session ID. |
| ACP | `fwt acp` | JSON-RPC over standard input and standard output | An editor or an orchestrator controls the agent. |

fwt connects to a model through a provider. A provider is an API service that hosts models, for example DeepSeek or OpenCode Go. Before your first task, you add a provider.

## Install fwt

```sh
npm install -g @moeru-ai/fwt
```

You can also run it without an install, with `npx @moeru-ai/fwt` in place of `fwt`.

## Add a provider

fwt can fill in a provider from [models.dev](https://models.dev), a public list of providers and models. Use the provider ID from models.dev, for example `deepseek` or `opencode-go`.

1. Start the setup:

	```sh
	fwt provider add deepseek
	```

2. When fwt asks for the API key, type it. fwt does not show the key on the screen. It saves the key in `auth.json`.
3. When fwt shows the list of models, type the number or the ID of the model that you want.
4. When fwt asks if the provider becomes the default, type `y` or `n`. fwt uses the default provider when you do not give `--provider`.

fwt writes the provider and the model to `config.toml`. The [files](#files) section gives the location of each file.

If the provider is not on models.dev, give its base URL and its wire protocol. fwt then gets the list of models from the `/models` endpoint of that URL:

```sh
fwt provider add my-gateway --base-url https://gateway.example.com/v1 --protocol chat
```

To add a provider from a script, give every answer as a flag. fwt then asks no questions:

```sh
fwt provider add deepseek --api-key "$DEEPSEEK_API_KEY" -m deepseek-v4-flash --default yes
```

To see the providers that you added, run `fwt provider list`. To remove a provider and its saved key, run `fwt provider remove <id>`.

## Run a task

Give the prompt with `-p`:

```sh
fwt -p "Fix the failing test in src/parse.test.ts"
```

You can also give the prompt as the first argument, or on standard input:

```sh
git diff | fwt "Review this diff"
```

When you give both a prompt and piped input, fwt adds the input to the prompt inside a `<stdin>` block. fwt reads the input until it ends, so a program that starts fwt with a pipe on standard input must close the pipe, or redirect standard input from `/dev/null`. You can attach an image with `-i` or `--image`; give the flag once for each image:

```sh
fwt -p "Describe these screenshots" -i before.png -i after.png
```

Image paths are relative to the run's working directory. Each image can be up to 20 MiB. Images must be PNG, JPEG, GIF, or WebP, and the model must accept image input.

fwt works in the current directory. To use a different directory, add `--cwd <path>`.

In the default text output, fwt writes the answer to standard output as the model writes it. To read each step from a program, add `-o jsonl`. fwt then writes one JSON object per line for each event. The last line has the type `result` and these fields:

- `sessionId`: the ID of the session.
- `stopReason`: the reason why the run stopped.
- `steps`: the number of model steps.
- `text`: the final answer.
- `cacheStats`: statistics about the prompt cache.

The exit code tells you why the run stopped:

| Exit code | `stopReason` | Meaning |
| --- | --- | --- |
| 0 | `completed` | The model gave its final answer. |
| 3 | `context_limit` | fwt could not compact the context enough to continue. Read `stopReasonDetail` in JSON Lines output or standard error for the reason. |
| 4 | `loop_detected` | The model made the same tool calls three times in a row. |
| 5 | `max_turns` | The run reached the limit that you set with `--max-turns`. |
| 130 | `aborted` | The run was stopped, for example with Ctrl+C. |

## Continue a session

fwt saves each run as a session. To give more instructions in the same conversation, use `--resume` with the session ID:

```sh
fwt --resume 0f9c2a1e-5b7d-4c3a-9e21-6d8f4a0b1c2d -p "Also add a test for empty input"
```

The `sessionId` field of the `result` line gives the ID. `--resume latest` continues the most recent session in the resolved working directory. You can also give the path of the session file.

A resumed session uses the provider and the model that it used before. If you give `--provider`, `--base-url`, or `--model`, fwt uses the new value. fwt rebuilds its active context from the original message log and the latest compaction record. It does not send messages covered by that summary or call the model to rebuild it.

Use `--fork` to continue from the same history in a new session file:

```sh
fwt --fork 0f9c2a1e-5b7d-4c3a-9e21-6d8f4a0b1c2d -p "Implement the first approach"
```

`--fork` accepts a session ID, a session file path, or `latest`. It copies the source session's messages and compaction records in order, including its initial user message and saved environment context. It then adds your new prompt. The source file stays unchanged, and the new session has its own ID and usage statistics. Without `--cwd`, the fork uses the source session's working directory. Give `--cwd <path>` to run it in another worktree. The copied messages still name the source directory, so fwt adds the new working directory to your prompt and tells the model not to change files in the source directory. A fork uses the source provider and model unless you override them with `--provider`, `--base-url`, or `--model`. You cannot use `--fork` and `--resume` together.

The copied request message prefix stays byte-identical. Headers that contain `{session}`, including OpenCode's `x-opencode-session`, use the fork's new ID. A provider that scopes its cache by that header may not share cache entries across forks.

## Use a model without a provider

To use an API endpoint that you did not add, give `--base-url`. fwt then uses no `config.toml` entry and no saved key:

```sh
fwt -p "Explain src/index.ts" \
	--base-url https://api.example.com/v1 \
	--protocol responses \
	--model example-coder \
	--api-key "$EXAMPLE_API_KEY"
```

fwt does not know the context window of such a model. It uses 250,000 tokens. If the model has a different window, give `--context-length`.

To resume a session that used `--base-url` without a provider, give `--base-url` and `--model` again.

Some providers need extra HTTP headers. Give each one with `--header`. fwt replaces `{session}` with the session ID:

```sh
fwt -p "…" --header "x-trace-id: {session}" --header "x-team: tools"
```

## Run fwt as an ACP server

`fwt acp` serves the Agent Client Protocol (ACP) over standard input and standard output. An ACP client, for example an editor, starts the process and sends JSON-RPC requests. fwt supports ACP version 1 and ACP version 2 (the `2.0.0-alpha.15` schema). The client picks the version in `initialize`.

Both versions support `initialize`, `session/new`, `session/resume`, `session/prompt`, and `session/cancel`. The other methods depend on the version:

| Method | Version 1 | Version 2 |
| --- | --- | --- |
| `session/load` | Yes | No. Use `session/resume` with `replayFrom`. |
| `session/set_mode` | Yes | No. Use `session/set_config_option` with `configId` `mode`. |
| `session/list` and `session/close` | No | Yes |
| `session/prompt` result | The stop reason, after the turn ends | A `messageId`, after fwt writes the user message to the session. `state_update` reports `running`, `requires_action`, and `idle` with the stop reason. |

`session/new`, `session/load`, and `session/resume` need an absolute `cwd`. On resume, `cwd` must be the working directory of the session. A prompt holds `text`, `resource_link`, text `resource`, and `image` blocks. fwt adds a `resource_link` to the prompt as a Markdown link, and it does not read the file. An `image` block must be PNG, JPEG, GIF, or WebP, and the model must accept image input. fwt rejects other block types with `-32602`.

A session has one of two modes. In `auto` mode, which is the default, fwt runs each tool call. In `ask` mode, fwt sends `session/request_permission` to the client before each tool call. To start in `ask` mode, add `--permission-mode ask`.

The model flags, for example `--provider` and `--model`, apply to each new session.

## Reference

### Flags

These flags apply to `fwt` and to `fwt acp`:

| Flag | Value |
| --- | --- |
| `--cwd <path>` | The working directory. The default is the current directory. |
| `-m, --model <model>` | The model ID. |
| `--provider <provider>` | A provider ID from `config.toml`. |
| `--protocol <chat\|responses\|messages>` | The wire protocol. |
| `--base-url <url>` | The API base URL. |
| `--api-key <key>` | The API key. |
| `--effort <effort>` | The reasoning effort. fwt sends the value without a change, for example `low`, `high`, or `max`. |
| `--context-length <tokens>` | The context window in tokens. |
| `--header <header...>` | An extra HTTP header as `"name: value"`. You can give it more than once. |
| `--permission-mode <auto\|ask>` | The ACP permission mode. `ask` works only with `fwt acp`. |
| `--max-turns <count>` | The maximum number of model steps for one prompt. The default is no limit. |

These flags apply only to `fwt`:

| Flag | Value |
| --- | --- |
| `-p, --prompt <text>` | The prompt. |
| `-i, --image <path...>` | An image to include in the prompt. You can give it more than once. |
| `-r, --resume <session>` | A session ID, a session file path, or `latest`. |
| `--fork <session>` | Start a new session from a session ID, file path, or `latest`. |
| `-o, --output <text\|jsonl>` | The output format. The default is `text`. |
| `--acp` | The same as `fwt acp`. |

### Wire protocols

| Protocol | API |
| --- | --- |
| `chat` | OpenAI Chat Completions |
| `responses` | OpenAI Responses |
| `messages` | Anthropic Messages |

A provider can have one base URL for each protocol. fwt uses the first protocol from this list that applies:

1. The `--protocol` flag or `FWT_PROTOCOL`.
2. The `protocol` of the model in `config.toml`.
3. The first protocol that models.dev gives for the model, if the provider has a base URL for it.
4. The first base URL of the provider.

### Environment variables

| Variable | Same as |
| --- | --- |
| `FWT_HOME` | Puts all fwt files in this one directory. See [files](#files). |
| `FWT_PROVIDER` | `--provider` |
| `FWT_MODEL` | `--model` |
| `FWT_PROTOCOL` | `--protocol` |
| `FWT_BASE_URL` | `--base-url` |
| `FWT_API_KEY` | `--api-key` |
| `FWT_EFFORT` | `--effort` |
| `FWT_CONTEXT_LENGTH` | `--context-length` |

A flag has priority over its variable. A variable has priority over `config.toml`.

fwt looks for the API key in this order: `--api-key`, `FWT_API_KEY`, the variable that `env_key` names in `config.toml`, and then `auth.json`.

### Files

fwt puts its files in the XDG base directories on Linux and on macOS:

| File | Location |
| --- | --- |
| Configuration | `$XDG_CONFIG_HOME/fwt/config.toml` (default `~/.config/fwt/config.toml`) |
| API keys | `$XDG_DATA_HOME/fwt/auth.json` (default `~/.local/share/fwt/auth.json`) |
| Sessions | `$XDG_STATE_HOME/fwt/sessions/` (default `~/.local/state/fwt/sessions/`) |
| models.dev cache | `$XDG_CACHE_HOME/fwt/models.dev.json` (default `~/.cache/fwt/models.dev.json`) |

If `FWT_HOME` is set, all four go in that directory. fwt writes `config.toml` and `auth.json` with mode `0600`.

`fwt provider add` downloads the models.dev list and keeps it in the cache. A task run reads only the cache. It does not connect to models.dev.

### config.toml

`fwt provider add` writes this file. You can also edit it yourself:

```toml
provider = "gateway"

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

| Key | Meaning |
| --- | --- |
| `provider` | The default provider. |
| `providers.<id>.base_url` | One base URL for each protocol. You must give at least one. |
| `providers.<id>.model` | The model that fwt uses when you do not give `--model`. |
| `providers.<id>.env_key` | The environment variable that holds the API key. |
| `providers.<id>.headers` | Extra HTTP headers. fwt replaces `{session}` with the session ID. |
| `providers.<id>.name` | A display name. |
| `providers.<id>.models.<model>` | Values for one model. These values have priority over models.dev. |

For the `opencode` and `opencode-go` providers, `fwt provider add` sets the `x-opencode-session` header to `{session}`.

### Context window and output limit

fwt takes the context window from `--context-length`, from `FWT_CONTEXT_LENGTH`, from `config.toml`, or from models.dev, in that order. If none of them gives a value, the window is 250,000 tokens.

The output limit for one step is the lowest of three values: the `max_output` of the model, 32,768 tokens, and a quarter of the context window. fwt sends the output limit to the API only with the `messages` protocol, because the Anthropic Messages API requires it.

For a context window of `W` tokens and output limit `O`, fwt reserves `M = max(2048, ceil(0.02 × W))` tokens and sets the input budget to `B = W - O - M`. It compacts when estimated input reaches `floor(0.80 × B)`. After compaction, estimated input must fit within `floor(0.40 × B)`. The summary asks for a target of `min(4096, floor(0.05 × B))` tokens; the recent suffix targets `min(16384, floor(0.15 × B))` tokens. The suffix keeps complete interactions, and fwt retains every real user message before its cut. If required user text and the latest complete interaction do not fit after compaction, the run stops with exit code 3 and reports `stopReasonDetail` in JSON Lines output or standard error.

Session files keep the original messages and record each adopted summary. Resume rebuilds the active context without another summary request.

Compaction uses the main model once without running tools. It keeps the same system prompt, tools, effort, endpoint, and session ID. A valid summary replaces the previous summary in later model requests. Compaction does not reset tool execution sessions, turn limits, or repeated-call detection. ACP session load and resume replay the active context, including its summary and recent suffix, instead of replaying messages already covered by the summary.

### Retries

If a request to the model fails before the response starts, fwt sends it again up to four times. fwt does this for network errors, for status 429, and for status 500 and higher. It waits 200 ms before the first new attempt, and it doubles the wait each time. If the response has a `Retry-After` header, fwt waits that long, up to 60 seconds.

If the response sends no bytes for 300 seconds, fwt stops that attempt. If a stream stops after it starts, fwt retries the model step up to five times, using the same waits. It does not retry other 4xx errors or a request you abort. The run saves only the successful assistant message. Text or reasoning deltas already sent to the caller can appear again after a retry.

### Tools

The model has these tools:

| Tool | Use |
| --- | --- |
| `exec_command` | Runs a shell command with `bash -c`. If the input has `stdin`, fwt writes it to the command and then closes standard input. |
| `write_stdin` | Writes to a command that is still running, or gets its new output. |
| `view_image` | Reads a PNG, JPEG, GIF, or WebP file. fwt gives this tool only to a model that accepts images. |

`exec_command` returns after the command ends, or after `yield_time_ms` (default 10 seconds). If the command is still running, it keeps running, and the model can use `write_stdin` with the session ID. Commands do not get a terminal (TTY). Up to 64 commands can run at the same time. When the run ends or stops, fwt stops all of its commands.

Commands inherit the fwt process environment, with these values set for each command: `NO_COLOR=1`, `TERM=dumb`, `COLORTERM` empty, and `PAGER`, `GIT_PAGER`, and `GH_PAGER` set to `cat`. These settings disable color and prevent pager programs from waiting for input. fwt does not change the command's locale.

fwt has no tool that edits files. The model edits files with shell commands, for example a Python script on `stdin`.

### Project instructions

On a new session, fwt reads `AGENTS.md` in its configuration directory, the working directory, and each parent directory up to the filesystem root. The configuration directory is `$XDG_CONFIG_HOME/fwt` by default, or `FWT_HOME` when set. It sends the global file first, followed by the files from the root to the working directory. Instructions closer to the working directory take precedence. fwt does not discover files below the working directory.

The initial instructions are saved in the session. A resumed session keeps those instructions, even if the files have changed. Start a new session to load changes.

### Skills

A skill is a directory with a `SKILL.md` file. The file gives the model instructions for one kind of task. fwt reads skills from two directories:

- `~/.agents/skills/`
- `.agents/skills/` in the working directory

If a skill with the same name is in both directories, fwt uses the one in the working directory. fwt gives the model the name and the description of each skill. The model reads the full `SKILL.md` when a task matches the description.

To use a skill in a prompt, write its name after `/` at the start of the prompt, or after `$` anywhere in the prompt. fwt then adds the full `SKILL.md` to the prompt:

```sh
fwt -p '/code-review Review the changes since main'
```
