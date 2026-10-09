import { z } from "zod";
export const uuid = z.string().uuid(),
  revision = z.number().int().positive();
const text = z.string().max(16000),
  identity = z.string().min(1).max(512);
export const feedbackReferenceSchema = z
  .object({
    sourceId: uuid.optional(),
    resultId: uuid.optional(),
    criterionId: identity.optional(),
    artifactId: uuid.optional(),
    workId: identity.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export const reviewMetadataSchema = z
  .object({
    sourceId: uuid.optional(),
    criteria: z
      .array(
        z
          .object({
            criterionId: identity,
            outcome: z.enum(["supported", "failed", "unverified"]),
            scope: text,
            provenance: text,
          })
          .strict(),
      )
      .max(128)
      .default([]),
    validations: z
      .array(
        z
          .object({
            label: text,
            outcome: z.enum(["passed", "failed", "unverified"]),
            scope: text,
            provenance: text,
            checkedHead: z
              .string()
              .regex(/^[a-f0-9]{40}$/)
              .optional(),
          })
          .strict(),
      )
      .max(128)
      .default([]),
    artifacts: z
      .array(
        z
          .object({
            artifactId: uuid,
            label: text,
            role: z.enum(["before", "after", "evidence"]),
            pairId: identity.optional(),
            revision,
            availability: z.enum(["available", "unavailable", "redacted"]),
            url: z
              .string()
              .url()
              .max(2000)
              .refine((v) => ["http:", "https:"].includes(new URL(v).protocol))
              .optional(),
            file: z
              .object({
                relativePath: z.string().min(1).max(2000),
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
                mime: z.enum(["image/png", "image/jpeg"]),
                size: z.number().int().min(1).max(5000000),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(64)
      .default([]),
    changes: z
      .object({
        files: z.array(z.string().max(2000)).max(128).default([]),
        commits: z
          .array(z.string().regex(/^[a-f0-9]{40}$/))
          .max(128)
          .default([]),
        diff: text.optional(),
        reference: z.string().url().max(2000).optional(),
        findings: z
          .array(
            z
              .object({ finding: text, repairAssignmentId: uuid.optional() })
              .strict(),
          )
          .max(128)
          .default([]),
      })
      .strict()
      .optional(),
    decisions: z
      .array(z.object({ text, attribution: text }).strict())
      .max(128)
      .default([]),
  })
  .strict();
export type ReviewMetadata = z.output<typeof reviewMetadataSchema>;
export const sourceSnapshotSchema = z
  .object({
    sourceId: uuid,
    taskId: uuid,
    projectId: uuid,
    revision,
    kind: z.enum(["local", "github"]),
    title: text.nullable(),
    body: text.nullable(),
    digest: z.string().length(64),
    createdAt: z.number(),
    criteria: z
      .array(
        z
          .object({
            criterionId: identity,
            position: z.number().int().nonnegative(),
            text,
          })
          .strict(),
      )
      .max(128),
    criteriaOmittedCount: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null),
    coverage: z.literal("literal-checklists-only"),
  })
  .strict();
export const contextCaptureSchema = z
  .object({
    captureId: uuid,
    taskId: uuid,
    assignmentId: uuid,
    assignmentVersion: revision,
    workId: identity.nullable(),
    supplier: z.string().max(512),
    brief: text.nullable(),
    profileRevision: revision,
    instructionsRevision: revision,
    sourceId: uuid.nullable(),
    createdAt: z.number(),
  })
  .strict();
export const resultReviewSchema = z
  .object({
    resultId: uuid,
    taskId: uuid,
    assignmentId: uuid,
    workId: identity,
    workRevision: revision,
    metadata: reviewMetadataSchema,
  })
  .strict();
export const viewedReferenceSchema = z
  .object({
    sourceId: uuid.nullable(),
    resultIds: z.array(uuid).max(128),
    viewedAt: z.number(),
  })
  .strict();
export const taskReviewReadSchema = z
  .object({
    sources: z.array(sourceSnapshotSchema).max(128),
    contexts: z.array(contextCaptureSchema).max(256),
    contextsOmittedCount: z.number().int().nonnegative(),
    results: z.array(resultReviewSchema).max(128),
    viewed: viewedReferenceSchema.nullable(),
    coverage: z.literal("retained-records-only"),
  })
  .strict();
