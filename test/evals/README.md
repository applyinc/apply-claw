# Chat-Agent Evals

This folder contains a dataset-driven eval harness for web chat-agent behavior.

## What is graded

- `output`: final assistant text quality checks (`mustContain`, `mustNotContain`)
- `trajectory`: tool-call ordering checks (`strict`, `subset`, `superset`, `unordered`)
- `trace`: event-stream integrity checks (required event types, monotonic `globalSeq`,
  and tool-call lifecycle completeness)

## Run

```bash
pnpm test:evals
```

This mode is informational and prints a full summary.

## Enforce critical checks

```bash
pnpm test:evals:enforce
```

When `EVALS_ENFORCE=1`, the runner exits non-zero if any **critical** eval case fails.
