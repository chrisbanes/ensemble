import { z } from "zod";
const nonempty = z.string().trim().min(1).max(512);
const envReference = z.string().regex(/^env:[A-Z][A-Z0-9_]*$/);
export const projectFieldsSchema = z.array(
  z
    .object({
      projectNodeId: nonempty,
      fieldNodeId: nonempty,
      optionNodeId: nonempty,
    })
    .strict(),
);

export const selectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: nonempty,
      kind: z.literal("repository"),
      repositoryId: nonempty,
      owner: nonempty,
      name: nonempty,
    })
    .strict(),
  z
    .object({ id: nonempty, kind: z.literal("search"), query: nonempty })
    .strict(),
  z
    .object({
      id: nonempty,
      kind: z.literal("project"),
      projectNodeId: nonempty,
      filter: z.string().max(4096),
    })
    .strict(),
]);

const conditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("label"), name: nonempty }).strict(),
  z
    .object({
      kind: z.literal("project-field"),
      projectNodeId: nonempty,
      fieldNodeId: nonempty,
      optionNodeId: nonempty,
    })
    .strict(),
]);

export const readinessSchema = z
  .object({
    mode: z.enum(["all", "any"]),
    conditions: z.array(conditionSchema).min(1).max(20),
  })
  .strict();

export const repositoryLinkSchema = z
  .object({
    repositoryId: nonempty,
    path: z.string().trim().min(1),
    ref: nonempty,
  })
  .strict();

export const githubConfigurationSchema = z
  .object({
    credentialRef: envReference.nullable(),
    selections: z
      .array(selectionSchema)
      .max(30)
      .refine(
        (values) =>
          new Set(values.map((value) => value.id)).size === values.length,
        "Selection IDs must be unique",
      ),
    readiness: readinessSchema,
    repositories: z
      .array(repositoryLinkSchema)
      .max(20)
      .refine(
        (values) =>
          new Set(values.map((value) => value.repositoryId)).size ===
          values.length,
        "Repository IDs must be unique",
      ),
  })
  .strict();

export type GitHubConfigurationInput = z.input<
  typeof githubConfigurationSchema
>;
export type GitHubSelection = z.output<typeof selectionSchema>;
