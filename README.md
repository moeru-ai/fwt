# fwt

> Subagent harness, featherweight.

fwt is a headless coding agent that other programs run as a subagent.

You give fwt one task. It works in a directory with shell commands until the task is done, and then it prints the answer. A script, an editor, or another coding agent can start it. Each fwt process runs one agent, and the program that starts it decides what each agent does.

fwt skips the interactive terminal interface, MCP servers, and sub-agents of its own. The model gets three tools: one runs shell commands, one writes to a running command, and one reads images.

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

The [fwt skill](skills/fwt/SKILL.md) tells a coding agent how to give a task to fwt and how to read the result. Install it for all of your projects with the [`skills`](https://github.com/vercel-labs/skills) command:

```sh
npx skills add moeru-ai/fwt
```

Then ask your coding agent to give a task to fwt.

## Documentation

[The `fwt` command](packages/fwt/README.md) tells you how to add providers and run tasks. It also lists the flags, the environment variables, and the files.

## Acknowledgements

fwt takes ideas from [Codex](https://github.com/openai/codex) and [Pi](https://github.com/earendil-works/pi). From Codex, it takes the `exec_command` and `write_stdin` tools, the provider configuration in TOML, and the retry rules for model requests. From Pi, fwt draws inspiration from the idea of keeping an agent harness small and focused.

## License

[Apache-2.0](LICENSE)
