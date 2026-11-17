---
name: fwt
description: Give a coding task to fwt, a headless coding agent that runs as a separate process. Use when the user asks to delegate work to fwt, or asks for a subagent that runs on a model or provider from fwt.
---

# Delegate a task to fwt

`fwt` is a coding agent that has no user interface. You give it one prompt. It runs shell commands in a directory until the task is done, and it prints a final answer. It cannot ask you or the user a question while it works.

## Make sure that fwt can run

1. Run `fwt provider list`.
2. If the command is not found, use `npx -y @moeru-ai/fwt` in place of `fwt` in every command in this skill.
3. If the output says `No providers configured`, stop and ask the user to run `fwt provider add`. Do not run that command yourself. It asks for an API key, and only the user can give the key.

## Write the prompt

The fwt agent sees only your prompt and the files in its directory. It does not see this conversation. Put these items in the prompt:

1. The goal, in one or two sentences.
2. The files, commands, and facts that the agent needs, with exact paths and names.
3. What the agent must not change. Say if the agent can commit, and on which branch.
4. The checks that prove that the task is done, for example the test command.
5. What the final answer must contain, for example the changed files and the check results.

Do not put an API key, a token, or a password in the prompt. fwt saves each prompt in a session file.

## Run the task

Run fwt in the directory of the task, and ask for JSON Lines output. Redirect standard input from `/dev/null`: fwt reads piped standard input until it ends and adds it to the prompt, so an open pipe makes it wait forever:

```sh
fwt -p "<prompt>" --cwd <directory> -o jsonl < /dev/null
```

If the prompt is long, write it to a file and send the file on standard input:

```sh
fwt --cwd <directory> -o jsonl < prompt.md
```

A run can take many minutes, and fwt has no step limit by default. If your tool can run a command in the background, use it. To limit the cost, add `--max-turns <count>`.

To use a provider or a model that is not the default, add `--provider <id>`, `--model <id>`, or both. To set the reasoning effort, add `--effort <level>`.

If you start more than one fwt run at the same time, give each run its own directory, for example its own git worktree. Two runs in the same directory change the same files.

## Read the result

The last line of the output is a JSON object of type `result`. Its `text` field is the final answer. Its `sessionId` field is the ID that you need to continue the session. The exit code tells you why the run stopped:

| Exit code | Meaning | What you do |
| --- | --- | --- |
| 0 | The agent gave its final answer. | Read `text`. |
| 3 | fwt could not compact the context enough to continue. | Read `stopReasonDetail` in JSON Lines output or the `context_limit` message on standard error. Keep the session and reduce the task or provide a larger context window. |
| 4 | The agent made the same tool calls three times in a row. | Continue the session with a hint, or start a new run with a clearer prompt. |
| 5 | The run reached `--max-turns`. | Continue the session if the work is worth more steps. |
| 130 | The run was stopped. | Tell the user. |
| Other | fwt failed, for example because the provider returned an error. | Read standard error and tell the user. |

The final answer is what the model says. It is not proof that the work is done. Before you tell the user that the task is done, read the changes with `git diff` and run the checks yourself.

## Continue the session

To give the same agent more instructions, use the session ID from the `result` line:

```sh
fwt --resume <sessionId> -p "<follow-up>" --cwd <directory> -o jsonl < /dev/null
```

The agent keeps everything from the earlier run. Write only what is new.

## Fork a session

Use `--resume` when one run should keep working in the same conversation. Use `--fork` when several follow-up runs should start from the same conversation and remain independent:

```sh
fwt --fork <sessionId> -p "Implement one approach" --cwd <worktree-a> -o jsonl < /dev/null
fwt --fork <sessionId> -p "Implement another approach" --cwd <worktree-b> -o jsonl < /dev/null
```

Give each parallel run its own git worktree. A fork creates a new session ID and copies the source messages, including the initial user message and its saved environment context. It does not rebuild that context. The fork uses the source working directory unless you give `--cwd`; with `--cwd`, tools run in that worktree, and fwt tells the agent that the earlier messages refer to the source directory. The source provider and model carry over unless you override them. `latest` selects a session from the resolved working directory. `--fork` and `--resume` cannot be used together.
