import type { EvalCase, EvalEvent, GradeResult, TrajectoryMatchMode } from "./types.js";

function collectAssistantText(events: EvalEvent[]): string {
  const chunks: string[] = [];
  for (const event of events) {
    if (event.type === "text-delta" && typeof event.delta === "string") {
      chunks.push(event.delta);
      continue;
    }
    if (event.type === "text" && typeof event.text === "string") {
      chunks.push(event.text);
      continue;
    }
  }
  return chunks.join("").trim();
}

function collectToolTrajectory(events: EvalEvent[]): string[] {
  const tools: string[] = [];
  for (const event of events) {
    if (event.type === "tool-input-start" && event.toolName) {
      tools.push(event.toolName);
    }
  }
  return tools;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function includesSubsequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) {
    return true;
  }
  let j = 0;
  for (let i = 0; i < haystack.length && j < needle.length; i += 1) {
    if (haystack[i] === needle[j]) {
      j += 1;
    }
  }
  return j === needle.length;
}

function matchTrajectory(expected: string[], actual: string[], mode: TrajectoryMatchMode): boolean {
  switch (mode) {
    case "strict":
      return arraysEqual(expected, actual);
    case "subset":
      return includesSubsequence(expected, actual);
    case "superset":
      return includesSubsequence(actual, expected);
    case "unordered": {
      const expectedSorted = [...expected].toSorted();
      const actualSorted = [...actual].toSorted();
      return arraysEqual(expectedSorted, actualSorted);
    }
    default:
      return false;
  }
}

export function gradeOutput(testCase: EvalCase): GradeResult {
  const details: string[] = [];
  const expectation = testCase.expectations.output;
  if (!expectation) {
    return { grader: "output", passed: true, details: ["no output expectation configured"] };
  }

  const text = collectAssistantText(testCase.events);
  if (!text) {
    details.push("assistant text was empty");
  }

  for (const required of expectation.mustContain ?? []) {
    if (!text.includes(required)) {
      details.push(`missing required output fragment: "${required}"`);
    }
  }

  for (const forbidden of expectation.mustNotContain ?? []) {
    if (text.includes(forbidden)) {
      details.push(`found forbidden output fragment: "${forbidden}"`);
    }
  }

  return {
    grader: "output",
    passed: details.length === 0,
    details: details.length > 0 ? details : ["output matched expectations"],
  };
}

export function gradeTrajectory(testCase: EvalCase): GradeResult {
  const details: string[] = [];
  const expectation = testCase.expectations.trajectory;
  if (!expectation) {
    return {
      grader: "trajectory",
      passed: true,
      details: ["no trajectory expectation configured"],
    };
  }

  const actual = collectToolTrajectory(testCase.events);
  const matched = matchTrajectory(expectation.tools, actual, expectation.mode);
  if (!matched) {
    details.push(
      `trajectory mismatch for mode=${expectation.mode}: expected=${JSON.stringify(expectation.tools)} actual=${JSON.stringify(actual)}`,
    );
  }

  return {
    grader: "trajectory",
    passed: matched,
    details: matched ? ["trajectory matched expectation"] : details,
  };
}

export function gradeTraceIntegrity(testCase: EvalCase): GradeResult {
  const details: string[] = [];
  const expectation = testCase.expectations.trace;

  if (!expectation) {
    return { grader: "trace", passed: true, details: ["no trace expectation configured"] };
  }

  const requiredTypes = expectation.requiredTypes ?? [];
  const eventTypes = new Set(testCase.events.map((event) => event.type));
  for (const requiredType of requiredTypes) {
    if (!eventTypes.has(requiredType)) {
      details.push(`missing required event type: ${requiredType}`);
    }
  }

  if (expectation.requireMonotonicGlobalSeq) {
    let lastSeq = -1;
    const seen = new Set<number>();
    for (const event of testCase.events) {
      if (typeof event.globalSeq !== "number") {
        continue;
      }
      if (seen.has(event.globalSeq)) {
        details.push(`duplicate globalSeq detected: ${event.globalSeq}`);
      }
      seen.add(event.globalSeq);
      if (event.globalSeq <= lastSeq) {
        details.push(`non-monotonic globalSeq transition: ${lastSeq} -> ${event.globalSeq}`);
      }
      lastSeq = event.globalSeq;
    }
  }

  const toolState = new Map<string, { started: boolean; terminalCount: number }>();
  for (const event of testCase.events) {
    if (!event.toolCallId) {
      continue;
    }

    if (event.type === "tool-input-start") {
      const current = toolState.get(event.toolCallId) ?? {
        started: false,
        terminalCount: 0,
      };
      current.started = true;
      toolState.set(event.toolCallId, current);
      continue;
    }

    if (event.type === "tool-output-available" || event.type === "tool-output-error") {
      const current = toolState.get(event.toolCallId);
      if (!current?.started) {
        details.push(`terminal tool event without start for ${event.toolCallId}`);
        continue;
      }
      current.terminalCount += 1;
      toolState.set(event.toolCallId, current);
    }
  }

  for (const [toolCallId, state] of toolState.entries()) {
    if (state.started && state.terminalCount === 0) {
      details.push(`tool call without terminal output: ${toolCallId}`);
    }
    if (state.terminalCount > 1) {
      details.push(`tool call produced multiple terminal outputs: ${toolCallId}`);
    }
  }

  return {
    grader: "trace",
    passed: details.length === 0,
    details: details.length > 0 ? details : ["trace integrity checks passed"],
  };
}
