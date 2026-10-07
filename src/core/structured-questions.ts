import { createHash } from "node:crypto";
import { z } from "zod";
export const questionIdentity = z.string().min(1).max(512);
const text = z.string().min(1).max(16000);
export const structuredQuestionSetSchema = z
  .array(
    z
      .object({
        id: questionIdentity,
        header: questionIdentity,
        question: text,
        isOther: z.boolean(),
        isSecret: z.literal(false),
        options: z
          .array(
            z
              .object({
                label: questionIdentity,
                description: z.string().max(16000),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
  )
  .min(1)
  .max(32)
  .superRefine((questions, ctx) => {
    const ids = new Set<string>();
    for (const q of questions) {
      if (ids.has(q.id))
        ctx.addIssue({
          code: "custom",
          message: "Duplicate question identity",
        });
      ids.add(q.id);
      const labels = new Set<string>();
      for (const option of q.options) {
        if (labels.has(option.label))
          ctx.addIssue({ code: "custom", message: "Duplicate option label" });
        labels.add(option.label);
      }
    }
  });
export type StructuredQuestionSet = z.infer<typeof structuredQuestionSetSchema>;
export const structuredQuestionAnswersSchema = z.record(
  questionIdentity,
  z.object({ answers: z.array(text).length(1) }).strict(),
);
export type StructuredQuestionAnswers = z.infer<
  typeof structuredQuestionAnswersSchema
>;
export function boundedQuestionPayload(input: unknown): void {
  if (Buffer.byteLength(JSON.stringify(input) ?? "", "utf8") > 256 * 1024)
    throw new Error("Question payload exceeds limit");
}
export function validateStructuredAnswers(
  questions: StructuredQuestionSet,
  input: unknown,
): StructuredQuestionAnswers {
  boundedQuestionPayload(input);
  const answers = structuredQuestionAnswersSchema.parse(input);
  if (Object.keys(answers).length !== questions.length)
    throw new Error("Incomplete or unknown answer identities");
  for (const question of questions) {
    const answer = answers[question.id]?.answers[0];
    if (
      answer === undefined ||
      (!question.isOther &&
        !question.options.some((option) => option.label === answer))
    )
      throw new Error(`Invalid answer: ${question.id}`);
  }
  return answers;
}

function canonicalAnswers(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalAnswers).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, entry]) => `${JSON.stringify(key)}:${canonicalAnswers(entry)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function structuredAnswerDigest(
  answers: StructuredQuestionAnswers,
): string {
  return createHash("sha256").update(canonicalAnswers(answers)).digest("hex");
}

export const nativeInputRequestSchema = z
  .object({
    threadId: questionIdentity,
    turnId: questionIdentity,
    itemId: questionIdentity,
    questions: structuredQuestionSetSchema,
    isBlocking: z.literal(false),
    autoResolutionMs: z.null(),
  })
  .strict();
export type NativeInputRequest = z.infer<typeof nativeInputRequestSchema>;
export type NativeInputReply = { answers: StructuredQuestionAnswers };
export const nativeInputEndpointIdentitySchema = z
  .object({
    requestId: z.union([questionIdentity, z.number().safe().int()]),
    runtimeGeneration: questionIdentity,
    threadId: questionIdentity,
    turnId: questionIdentity,
    itemId: questionIdentity,
  })
  .strict();
export type NativeInputEndpointIdentity = z.infer<
  typeof nativeInputEndpointIdentitySchema
>;
export const nativeInputQualificationSchema = z
  .object({
    codexVersion: z.literal("codex-cli 0.159.0"),
    executableHash: z.string().regex(/^[a-f0-9]{64}$/),
    threadId: questionIdentity,
    runtimeGeneration: questionIdentity,
    mode: z.literal("default"),
    model: questionIdentity,
    modelProvider: questionIdentity,
    reasoningEffort: z.string().nullable(),
    serviceTier: z.string().nullable(),
    developerInstructionsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    continuation: z.literal("synchronous"),
  })
  .strict();
export type NativeInputProtocolQualification = z.infer<
  typeof nativeInputQualificationSchema
>;
export interface RuntimeUserInputRequest {
  identity: NativeInputEndpointIdentity;
  request: NativeInputRequest;
  qualification: NativeInputProtocolQualification;
}
export interface RuntimeReplyIntent {
  replyIntentId: string;
  answerDigest: string;
}
export const runtimeUserInputOutcomeSchema = nativeInputEndpointIdentitySchema
  .extend({
    replyIntentId: questionIdentity.optional(),
    answerDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    outcome: z.enum([
      "sent-unconfirmed",
      "confirmed",
      "unavailable",
      "uncertain",
    ]),
    reason: z.string().max(1024),
    orderedReceipt: z
      .object({
        writeInitiated: z.number().int().positive(),
        stdinSucceeded: z.number().int().positive().optional(),
        matchingResolution: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RuntimeUserInputOutcome = z.infer<
  typeof runtimeUserInputOutcomeSchema
>;
export function parseNativeInputRequest(
  input: unknown,
  qualification: NativeInputProtocolQualification,
): NativeInputRequest {
  boundedQuestionPayload(input);
  const trusted = nativeInputQualificationSchema.parse(qualification);
  const request = nativeInputRequestSchema.parse(input);
  if (request.threadId !== trusted.threadId)
    throw new Error("Unqualified thread");
  return request;
}
export function encodeNativeInputReply(
  request: NativeInputRequest,
  answers: unknown,
): NativeInputReply {
  return { answers: validateStructuredAnswers(request.questions, answers) };
}
export function nativeEndpointKey(
  identity: NativeInputEndpointIdentity,
): string {
  return JSON.stringify([
    identity.runtimeGeneration,
    identity.threadId,
    identity.turnId,
    identity.itemId,
    typeof identity.requestId,
    identity.requestId,
  ]);
}
