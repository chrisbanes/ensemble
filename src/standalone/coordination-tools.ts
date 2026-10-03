import { reviewMetadataSchema } from "../core/task-review.js";
import { z } from "zod";
import { externalActionArgumentsSchema } from "../core/delivery.js";
import type {
  CoordinationStore,
  CoordinationCall,
  CoordinationToolResponse,
} from "../core/coordination.js";
import type { RuntimeToolDefinition } from "./codex.js";

const uuid = { type: "string", format: "uuid" };
const text = { type: "string", minLength: 1, maxLength: 16000 };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const coordinationTools: readonly RuntimeToolDefinition[] = [
  {
    type: "function",
    name: "ensemble_external_action",
    description:
      "Request an exact policy-authorized GitHub action. Intent precedes effect; uncertain actions hold this task.",
    inputSchema: z.toJSONSchema(externalActionArgumentsSchema),
  },
  {
    type: "function",
    name: "ensemble_register_pr",
    description:
      "Bind an existing identity-verified PR to this task and retain its lead for delivery feedback.",
    inputSchema: object(
      {
        repositoryId: text,
        prNumber: { type: "integer", minimum: 1 },
        expectedPrNodeId: text,
        expectedHeadSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
      },
      ["repositoryId", "prNumber", "expectedPrNodeId", "expectedHeadSha"],
    ),
  },
  {
    type: "function",
    name: "ensemble_delegate",
    description: "Assign a scoped task to a permitted project profile.",
    inputSchema: object({ profileId: uuid, brief: text }, [
      "profileId",
      "brief",
    ]),
  },
  {
    type: "function",
    name: "ensemble_report_result",
    description: "Persist the result of this assignment for its requester.",
    inputSchema: object(
      { summary: text, review: z.toJSONSchema(reviewMetadataSchema) },
      ["summary"],
    ),
  },
  {
    type: "function",
    name: "ensemble_ask_question",
    description: "Create a durable question for operator attention.",
    inputSchema: object({ question: text }, ["question"]),
  },
  {
    type: "function",
    name: "ensemble_request_approval",
    description:
      "Request operator approval for a specific action and material.",
    inputSchema: object(
      {
        action: { type: "string", minLength: 1, maxLength: 512 },
        target: { type: "string", minLength: 1, maxLength: 2000 },
        material: { type: "object" },
      },
      ["action", "material"],
    ),
  },
  {
    type: "function",
    name: "ensemble_request_follow_up",
    description:
      "Request a new revision of a completed result from its assignee.",
    inputSchema: object({ resultId: uuid, instructions: text }, [
      "resultId",
      "instructions",
    ]),
  },
  {
    type: "function",
    name: "ensemble_request_completion",
    description: "Ask Ensemble to validate completion of this task.",
    inputSchema: object(
      { reviewedResultIds: { type: "array", items: uuid, maxItems: 1000 } },
      ["reviewedResultIds"],
    ),
  },
];

export function isCoordinationTool(name: string): boolean {
  return coordinationTools.some((tool) => tool.name === name);
}

export function dispatchCoordinationTool(
  store: CoordinationStore,
  call: CoordinationCall,
  externalAdmission: () => boolean = () => true,
): CoordinationToolResponse {
  switch (call.tool) {
    case "ensemble_delegate":
      return store.delegate(call, externalAdmission);
    case "ensemble_report_result":
      return store.recordResult(call).response;
    case "ensemble_ask_question":
      return store.requestQuestion(call);
    case "ensemble_request_approval":
      return store.requestApproval(call);
    case "ensemble_request_follow_up":
      return store.requestFollowUp(call);
    case "ensemble_request_completion":
      return store.requestTaskCompletion(call);
    default:
      return { text: "Unknown coordination tool", success: false };
  }
}
