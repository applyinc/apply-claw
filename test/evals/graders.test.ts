import { describe, expect, it } from "vitest";
import { chatAgentEvalDataset } from "./dataset.js";
import { gradeOutput, gradeTraceIntegrity, gradeTrajectory } from "./graders.js";

describe("eval graders", () => {
  it("passes output/trajectory/trace graders for baseline success case", () => {
    const baseline = chatAgentEvalDataset[0];
    expect(gradeOutput(baseline).passed).toBe(true);
    expect(gradeTrajectory(baseline).passed).toBe(true);
    expect(gradeTraceIntegrity(baseline).passed).toBe(true);
  });

  it("fails trajectory grader when tool order does not match strict expectation", () => {
    const mismatched = {
      ...chatAgentEvalDataset[0],
      events: [
        {
          type: "tool-input-start",
          toolCallId: "tool-other",
          toolName: "saveFile",
          globalSeq: 1,
        },
      ],
    };
    const result = gradeTrajectory(mismatched);
    expect(result.passed).toBe(false);
    expect(result.details.join(" ")).toContain("trajectory mismatch");
  });

  it("fails trace grader for duplicate globalSeq and missing tool terminal events", () => {
    const brokenTrace = {
      ...chatAgentEvalDataset[0],
      events: [
        { type: "tool-input-start", toolCallId: "tool-1", toolName: "searchDocs", globalSeq: 4 },
        { type: "text-delta", delta: "partial", globalSeq: 4 },
      ],
    };
    const result = gradeTraceIntegrity(brokenTrace);
    expect(result.passed).toBe(false);
    expect(result.details.some((detail) => detail.includes("duplicate globalSeq"))).toBe(true);
    expect(result.details.some((detail) => detail.includes("without terminal output"))).toBe(true);
  });
});
