# fwt

> Subagent harness, featherweight.

[![npm version](https://flat.badgen.net/npm/v/@moeru-ai/fwt?color=gray)](https://npmjs.com/package/@moeru-ai/fwt)
[![npm downloads](https://flat.badgen.net/npm/dm/@moeru-ai/fwt?color=gray)](https://npm.chart.dev/@moeru-ai/fwt)
[![install size](https://flat.badgen.net/packagephobia/install/@moeru-ai/fwt?color=gray)](https://packagephobia.com/result?p=@moeru-ai/fwt)
[![license](https://flat.badgen.net/github/license/moeru-ai/fwt?color=gray)](https://github.com/moeru-ai/fwt/blob/main/LICENSE)

fwt is a headless coding agent that other programs run as a subagent.

You give fwt one task. It works in a directory with shell commands until the task is done, and then it prints the answer. A script, an editor, or another coding agent can start it. Each fwt process runs one agent, and the program that starts it decides what each agent does.

## Why fwt?

A coding agent that hands work to a subagent needs that subagent to be cheap, predictable, and easy to read from a program. Interactive agents are built for a person at a terminal. fwt is built for the program that starts it:

- **One task, one process.** fwt takes a prompt and returns the answer on standard output, or every step as JSON Lines. The exit code says whether it finished, ran out of context, looped, or hit the step limit. There is no terminal interface, no MCP server, and no subagent of its own.
- **A small tool set.** The model gets three tools: one runs shell commands, one writes to a running command, and one reads images. It edits files with shell commands, so there is no patch format to learn.
- **Built around the prompt cache.** The system prompt and tools never change, and history only grows. When the context fills up, the same model writes a summary from the prefix that is already cached, and the session continues.
- **Sessions you can branch.** You can resume a session, or fork it so that several runs continue from the same history in separate worktrees and share its cached prefix.
- **Any provider.** fwt speaks OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages, and sets up providers from [models.dev](https://models.dev). Routine tests run on small, inexpensive models such as DeepSeek V4.1 Flash and GLM-5.3 Flash.
- **ACP when you need it.** Editors and orchestrators can drive the same agent through the Agent Client Protocol.

## Get started

Install fwt from npm:

```sh
npm install -g @moeru-ai/fwt
```

You can also run it without an install, with `npx @moeru-ai/fwt` in place of `fwt`.

Add a provider. fwt finds it on [models.dev](https://models.dev), asks for your API key, and lets you select a model:

```sh
fwt provider add deepseek
```

Give fwt a task in the directory where you want it to work:

```sh
cd /path/to/project
fwt -p "Fix the failing test in src/parse.test.ts"
```

## Let another coding agent use fwt

The [fwt skill](skills/fwt/SKILL.md) tells a coding agent how to give a task to fwt and how to read the result. Install it for your projects with the [`skills`](https://github.com/vercel-labs/skills) command:

```sh
npx skills add moeru-ai/fwt
```

Then ask your coding agent to give a task to fwt.

## Run commands in a sandbox

fwt runs each command with `bash -c <command>`. To run commands in a sandbox, set `shell` in `~/.config/fwt/config.toml` to a program that also accepts `-c <command>`. fwt itself does not include a sandbox, and the model requests, API keys, and session files stay outside it.

For example, [sandbox-runtime](https://github.com/anthropics/sandbox-runtime) (`srt`) limits file writes and network access. On Linux it needs `bubblewrap` and `socat`:

```sh
npm install -g @anthropic-ai/sandbox-runtime
```

```toml
shell = [
  "srt",
  "--settings",
  "/home/me/.config/fwt/srt.json"
]
```

This `srt.json` lets commands write only in one project directory and blocks the network:

```json
{
  "filesystem": { "allowWrite": ["/home/me/project"], "denyRead": [], "denyWrite": [] },
  "network": { "allowedDomains": [], "deniedDomains": [] }
}
```

Use absolute paths in `srt.json`. srt resolves a relative path from the directory where the command starts, which can be a subdirectory.

## Documentation

[The `fwt` command](packages/fwt/README.md) tells you how to add providers and run tasks. It also lists the flags, the environment variables, and the files.

## Acknowledgements

fwt takes ideas from [Codex](https://github.com/openai/codex) and [Pi](https://github.com/earendil-works/pi). From Codex, it takes the `exec_command` and `write_stdin` tools, the provider configuration in TOML, and the retry rules for model requests. From Pi, fwt draws inspiration from the idea of keeping an agent harness small and focused.

## License

[Apache-2.0](LICENSE)
