import type { EvalCase } from "./types.js";

export const chatAgentEvalDataset: EvalCase[] = [
  {
    id: "tool-call-success",
    description: "single-tool answer includes expected retrieval summary",
    critical: true,
    events: [
      { type: "user-message", id: "u-1", text: "Find docs for workspace lock", globalSeq: 1 },
      { type: "tool-input-start", toolCallId: "tool-1", toolName: "searchDocs", globalSeq: 2 },
      {
        type: "tool-input-available",
        toolCallId: "tool-1",
        globalSeq: 3,
        output: { query: "workspace lock" },
      },
      {
        type: "tool-output-available",
        toolCallId: "tool-1",
        globalSeq: 4,
        output: { hits: 3 },
      },
      { type: "text-start", globalSeq: 5 },
      {
        type: "text-delta",
        delta: "Found 3 matching documents about workspace lock.",
        globalSeq: 6,
      },
      { type: "text-end", globalSeq: 7 },
    ],
    expectations: {
      output: {
        mustContain: ["Found 3 matching documents"],
        mustNotContain: ["NO_REPLY"],
      },
      trajectory: {
        tools: ["searchDocs"],
        mode: "strict",
      },
      trace: {
        requiredTypes: ["tool-input-start", "tool-output-available", "text-delta"],
        requireMonotonicGlobalSeq: true,
      },
    },
  },
  {
    id: "subagent-roundtrip",
    description:
      "subagent spawn followed by completion announcement is preserved in final response",
    critical: true,
    events: [
      { type: "user-message", id: "u-2", text: "Research customer timeline", globalSeq: 1 },
      { type: "tool-input-start", toolCallId: "tool-2", toolName: "spawnSubagent", globalSeq: 2 },
      {
        type: "tool-output-available",
        toolCallId: "tool-2",
        globalSeq: 3,
        output: { childSessionKey: "sub:abc", task: "timeline research" },
      },
      {
        type: "tool-input-start",
        toolCallId: "tool-3",
        toolName: "collectSubagentResult",
        globalSeq: 4,
      },
      {
        type: "tool-output-available",
        toolCallId: "tool-3",
        globalSeq: 5,
        output: { summary: "Key milestones collected." },
      },
      { type: "text-start", globalSeq: 6 },
      {
        type: "text-delta",
        delta: "Subagent finished and reported back with key milestones.",
        globalSeq: 7,
      },
      { type: "text-end", globalSeq: 8 },
    ],
    expectations: {
      output: {
        mustContain: ["Subagent finished and reported back"],
      },
      trajectory: {
        tools: ["spawnSubagent", "collectSubagentResult"],
        mode: "strict",
      },
      trace: {
        requiredTypes: ["tool-input-start", "tool-output-available", "text-delta"],
        requireMonotonicGlobalSeq: true,
      },
    },
  },
  {
    id: "crm-view-mutation",
    description:
      "CRM mutation path applies object view metadata and confirms result in assistant output",
    critical: false,
    events: [
      { type: "user-message", id: "u-3", text: "Set Important as active leads view", globalSeq: 1 },
      { type: "tool-input-start", toolCallId: "tool-4", toolName: "saveObjectViews", globalSeq: 2 },
      {
        type: "tool-output-available",
        toolCallId: "tool-4",
        globalSeq: 3,
        output: { object: "leads", activeView: "Important" },
      },
      {
        type: "tool-input-start",
        toolCallId: "tool-5",
        toolName: "fetchObjectEntries",
        globalSeq: 4,
      },
      {
        type: "tool-output-available",
        toolCallId: "tool-5",
        globalSeq: 5,
        output: { filteredRows: 12 },
      },
      {
        type: "text-delta",
        delta: "Active view 'Important' is now applied to leads.",
        globalSeq: 6,
      },
    ],
    expectations: {
      output: {
        mustContain: ["Active view 'Important' is now applied"],
      },
      trajectory: {
        tools: ["saveObjectViews", "fetchObjectEntries"],
        mode: "strict",
      },
      trace: {
        requiredTypes: ["tool-input-start", "tool-output-available", "text-delta"],
        requireMonotonicGlobalSeq: true,
      },
    },
  },
];
