import { z } from "zod";

export const processIdentitySchema = z
  .object({
    processId: z.string().min(1).max(128),
    processStartedAt: z.string().min(1).max(128),
    bootId: z.string().min(1).max(128),
  })
  .strict();

export function archivedResumeMessage(threadId: string): string {
  return `session ${threadId} is archived. Run \`codex unarchive ${threadId}\` to unarchive it first.`;
}
export const archivedResumeRejectionSchema = z
  .object({
    method: z.literal("thread/resume"),
    requestId: z.number().int().positive().safe(),
    threadId: z.string().min(1).max(512),
    processIdentity: processIdentitySchema,
    error: z
      .object({ code: z.literal(-32600), message: z.string().max(2000) })
      .strict(),
  })
  .strict()
  .refine(
    (value) => value.error.message === archivedResumeMessage(value.threadId),
    "Not an exact archived resume rejection",
  );
export type ArchivedResumeRejection = z.infer<
  typeof archivedResumeRejectionSchema
>;

/** Produced only from a correlated response to the owned runtime request. */
export class ArchivedResumeRejectedError extends Error {
  readonly rejection: ArchivedResumeRejection;
  constructor(rejection: ArchivedResumeRejection) {
    super(JSON.stringify(rejection.error));
    this.rejection = archivedResumeRejectionSchema.parse(rejection);
  }
}

const generationSchema = z.object({
  workId: z.string().min(1).max(512),
  workRevision: z.number().int().positive(),
  requestSequence: z.number().int().positive().safe(),
  processIdentity: processIdentitySchema,
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const historicalPreTurnAdoptionSchema = generationSchema
  .extend({
    key: z.string().uuid(),
    predecessorWorkId: z.string().min(1).max(512),
    predecessorThreadId: z.string().min(1).max(512),
    retainedReason: z.string().min(1).max(4000),
    rpcError: z
      .object({ code: z.literal(-32600), message: z.string().max(2000) })
      .strict(),
    evidence: z
      .object({
        frozenSourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
        frozenHarnessSha256: digest,
        evidenceSha256: digest,
        approvedDecisionSha256: digest,
        reviewReference: z.url().max(2048).startsWith("https://"),
        approvalReference: z.url().max(2048).startsWith("https://"),
      })
      .strict(),
    attestation: z
      .object({
        beforeTurnRejected: z.literal(true),
        noTurnSubmitted: z.literal(true),
        independentlyReviewed: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .refine(
    (v) => v.rpcError.message === archivedResumeMessage(v.predecessorThreadId),
    "Not an archived predecessor rejection",
  );
export type HistoricalPreTurnAdoption = z.infer<
  typeof historicalPreTurnAdoptionSchema
>;
const receiptBase = z.object({
  workId: z.string().min(1),
  workRevision: z.number().int().positive().nullable(),
  requestSequence: z.number().int().positive(),
  processIdentity: processIdentitySchema,
  termination: z.object({ kind: z.literal("process-exit") }).strict(),
  effects: z.literal("settled"),
  workspace: z.enum(["preserved", "reconciled"]),
});
export const preTurnRecoveryReceiptSchema = receiptBase
  .extend({
    kind: z.literal("pre-turn-rejection"),
    witnessId: z.string().uuid(),
    workRevision: z.number().int().positive(),
    threadId: z.null(),
    turnId: z.null(),
  })
  .strict();
export const recoveryReceiptSchema = z.union([
  receiptBase
    .extend({
      kind: z.literal("bound-turn").optional(),
      threadId: z.string().min(1),
      turnId: z.string().min(1),
    })
    .strict(),
  preTurnRecoveryReceiptSchema,
]);
export type RecoveryReceipt = z.infer<typeof recoveryReceiptSchema>;
export const preTurnRecoveryCommandSchema = z
  .object({ key: z.string().uuid(), receipt: preTurnRecoveryReceiptSchema })
  .strict();
export type PreTurnRecoveryCommand = z.infer<
  typeof preTurnRecoveryCommandSchema
>;
export const replaceConversationCommandSchema = z
  .object({
    key: z.string().uuid(),
    assignmentId: z.string().uuid(),
    expectedAssignmentVersion: z.number().int().positive(),
    expectedConversationRevision: z.number().int().positive(),
  })
  .strict();
export type ReplaceConversationCommand = z.infer<
  typeof replaceConversationCommandSchema
>;
