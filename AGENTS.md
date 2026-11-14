## Agent skills

### Issue tracker

Issues live as Markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default Matt Pocock triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context layout. See `docs/agents/domain.md`.

## Layout

- `packages/` holds workspace packages.

## Git workflow

- Use short, descriptive kebab-case branch names.
- Use Conventional Commits for commit messages and PR titles: `type(scope): summary`, with an optional scope. Common types include `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `build`, and `ci`.

## Ownership

This codebase is yours: what it's for and how it's built are your call, and you'll keep building on it. Merge repeated code and fix related problems you meet on the way. Improving the structure means merging and deleting; a new concept still follows Occam's razor below.

## Finishing work

Carry the task through to its done condition. Diagnose ordinary obstacles, such as a failing command, a timeout, an empty result or a missing tool, and work through them with the access you have. These steps need no approval: retrying a command that is safe to repeat, running lint, typecheck and tests, editing files in your checkout, and committing on your branch. Stop only when nothing can move without the owner, or when the blocker is deliberate, such as a file you were told to leave alone; then say plainly what you found.

## Reports

Write the final report for a reader who has not seen your tool calls or the files you opened. Put the key points first. Use plain, full sentences, and no term you made up during the work. Name every change in behaviour, including small ones, because the reader may review only the report. Use prose where ideas connect and bullets for separate items.

## General principles

- **Occam's razor.** A new concept (a name, field, entry kind, hook or package) enters only when the work cannot be done with the ones that exist, and only after a spec or the owner names it. A concept that serves one caller lives with that caller.
- **Unix philosophy.** Each component does one thing well and composes with others through clear interfaces.
- **Standards first.** When an established standard or existing tool already answers a need, use that answer.
- Keep things in one function unless composable or reusable.
- Validate unknown values once at the boundary that owns them. Pass typed values inward instead of repeating `typeof value === "object"` and property-existence checks. Do not defensively revalidate values already guaranteed by a schema, constructor, or internal type.
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.

## Comments

- Write code without comments from the first draft. Express intent as a name, a type or a test. Write a comment only for a public API contract that its types cannot state, a rule forced by something outside this repository, or a license.
