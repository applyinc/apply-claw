# Regression Verification Report

Date: 2026-03-02

## Stability Loops

### Web interaction regressions

Command:

```bash
for i in {1..20}; do
  pnpm vitest run app/workspace/object-view-active-view.test.ts app/components/workspace/object-filter-bar.test.tsx --silent
done
```

Result: **20/20 passes** (no flaky failures observed).

### CLI edge-case regressions

Command:

```bash
for i in {1..20}; do
  ../../node_modules/.bin/vitest run --config vitest.config.ts argv.test.ts run-main.test.ts windows-argv.test.ts --silent
done
```

Result: **20/20 passes** (no flaky failures observed).

## Mutation Probes (Manual)

The following intentional mutations were applied, tested, and reverted:

1. `apps/web/app/workspace/object-view-active-view.ts`
   - Mutation: `shouldApply` reduced to `nameMismatch` only.
   - Expected break: initial-load active view bug returns.
   - Caught by: `app/workspace/object-view-active-view.test.ts` (`applies active view on initial load ...`).
   - Outcome: **failed as expected**, then reverted.

2. `apps/web/app/components/chat-panel.tsx`
   - Mutation: tool error state changed from `"error"` to `"output-available"`.
   - Expected break: tool terminal state classification regression.
   - Caught by: `app/components/chat-panel.stream-parser.test.ts` (`accumulates tool input/output ...`).
   - Outcome: **failed as expected**, then reverted.

3. `src/cli/run-main.ts`
   - Mutation: disable-delegation branch changed to incorrectly return `true`.
   - Expected break: delegation safety bypass.
   - Caught by: `src/cli/run-main.test.ts` (`disables delegation when explicit env disable flag is set`).
   - Outcome: **failed as expected**, then reverted.

4. `test/evals/graders.ts`
   - Mutation: duplicate `globalSeq` detection removed.
   - Expected break: trace-integrity duplicate-sequence protection.
   - Caught by: `test/evals/graders.test.ts` (`fails trace grader for duplicate globalSeq ...`).
   - Outcome: **failed as expected**, then reverted.

## Final Verification Runs

- Web interaction suite: pass (`34` tests)
- CLI edge-case suite: pass (`42` tests)
- Eval grader unit suite: pass (`3` tests)
- Eval harness:
  - `pnpm test:evals`: pass (`9/9` graders across `3` cases)
  - `pnpm test:evals:enforce`: pass (`critical` cases all passing)

## Residual Risks

- Some large end-to-end UI flows (`workspace/page.tsx` URL orchestration and multi-panel state transitions) still rely on unit/component-level coverage rather than browser E2E.
- The eval dataset currently includes representative high-risk cases, but not production trace replay at scale yet.
- Additional CRM mutation permutations (large view/filter combinations) can be added to the eval dataset over time.
