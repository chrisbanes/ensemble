import { z } from "zod";
import {
  operatorCommandSchema,
  uuid,
  type OperatorCommand,
  type CommandReceipt,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { CommandLifecycle } from "./command-lifecycle.js";
export const storageKey = "ensemble.ui03.composer.v1";
export const recoveryLimit = 262144,
  commandLimit = 65536;
export const byteLength = (text: string) =>
  new TextEncoder().encode(text).length;
export const composerInputSchema = z
  .object({
    projectId: z.union([uuid, z.literal("")]),
    title: z.string(),
    outcome: z.string(),
    context: z.string(),
    links: z.array(z.string()),
    profileId: z.union([uuid, z.literal("")]),
    blockerTaskIds: z.array(uuid),
  })
  .strict();
export type ComposerInput = z.infer<typeof composerInputSchema>;
export const emptyInput = (): ComposerInput => ({
  projectId: "",
  title: "",
  outcome: "",
  context: "",
  links: [],
  profileId: "",
  blockerTaskIds: [],
});
const validInputSchema = composerInputSchema.extend({
  projectId: uuid,
  title: z.string().trim().min(1).max(512),
  outcome: z
    .string()
    .refine((s) => s.trim().length > 0, "Enter a desired outcome")
    .max(16000),
  context: z.string().max(16000),
  links: z
    .array(
      z
        .string()
        .max(2048)
        .refine((s) => {
          try {
            return ["http:", "https:"].includes(new URL(s).protocol);
          } catch {
            return false;
          }
        }, "Use an HTTP or HTTPS link"),
    )
    .max(32),
  blockerTaskIds: z
    .array(uuid)
    .max(128)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate dependency"),
});
export function encodeOutcome(input: ComposerInput) {
  let outcome = input.outcome;
  if (input.context) outcome += `\n\nContext:\n${input.context}`;
  if (input.links.length)
    outcome += `\n\nReference links (passive context; no repository access):\n${input.links.join("\n")}`;
  if (outcome.length > 16000)
    throw Error(
      "Combined outcome, context and links must be at most 16,000 characters.",
    );
  return outcome;
}
const creationSchema = operatorCommandSchema.options[0];
export const composerRecoverySchema = z.discriminatedUnion("status", [
  z
    .object({
      version: z.literal(1),
      status: z.literal("unfinished"),
      input: composerInputSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      status: z.literal("unknown"),
      input: composerInputSchema,
      command: creationSchema,
    })
    .strict(),
]);
export type ComposerRecovery = z.infer<typeof composerRecoverySchema>;
export interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export function encodeRecovery(record: ComposerRecovery) {
  const valid = composerRecoverySchema.parse(record);
  if (valid.status === "unknown") {
    const input = validInputSchema.parse(valid.input),
      command = valid.command;
    if (
      command.projectId !== input.projectId ||
      command.title !== input.title ||
      command.outcome !== encodeOutcome(input) ||
      (command.initialAssignment?.profileId ?? "") !== input.profileId ||
      JSON.stringify(command.blockerTaskIds ?? []) !==
        JSON.stringify(input.blockerTaskIds)
    )
      throw Error("frozen-input-mismatch");
  }
  const bytes = JSON.stringify(valid);
  if (byteLength(bytes) > recoveryLimit) throw Error("recovery-too-large");
  if (
    valid.status === "unknown" &&
    byteLength(JSON.stringify(valid.command)) > commandLimit
  )
    throw Error("command-too-large");
  return bytes;
}
export function readRecovery(
  storage: RecoveryStorage,
): ComposerRecovery | null {
  try {
    const bytes = storage.getItem(storageKey);
    if (!bytes || byteLength(bytes) > recoveryLimit) return null;
    const record = composerRecoverySchema.parse(JSON.parse(bytes));
    if (encodeRecovery(record) !== bytes) return null;
    return record;
  } catch {
    return null;
  }
}
export function writeRecovery(
  storage: RecoveryStorage,
  record: ComposerRecovery,
) {
  const bytes = encodeRecovery(record);
  storage.setItem(storageKey, bytes);
  if (storage.getItem(storageKey) !== bytes || !readRecovery(storage))
    throw Error("recovery-readback-failed");
}
type CreationCommand = Extract<OperatorCommand, { type: "task.create" }>;
function matchesCreationReceipt(
  command: CreationCommand,
  receipt: CommandReceipt,
) {
  return (
    receipt.kind === "domain" &&
    receipt.key === command.key &&
    "state" in receipt.result &&
    receipt.result.id === command.taskId &&
    receipt.result.projectId === command.projectId &&
    receipt.result.state === "open" &&
    receipt.result.ready === command.ready &&
    receipt.result.version === 1 + (command.blockerTaskIds?.length ?? 0)
  );
}
export class ComposerState {
  input: ComposerInput = emptyInput();
  phase: "editable" | "pending" | "unknown" | "recorded" = "editable";
  notice = "";
  errors: Record<string, string> = {};
  private readonly lifecycle = new CommandLifecycle<CreationCommand>();
  private generation = 0;
  private active = true;
  get receipt() {
    return this.lifecycle.receipt;
  }
  get frozen() {
    return this.lifecycle.frozen;
  }
  activate(changed: () => void) {
    this.generation++;
    this.active = true;
    this.changed = changed;
  }
  captureScope() {
    const generation = this.generation;
    return () => this.active && generation === this.generation;
  }
  dispose() {
    this.generation++;
    this.active = false;
    const command = this.frozen;
    if (this.phase === "pending" && command) {
      this.lifecycle.reset();
      this.lifecycle.restoreUnknown(command);
      this.phase = "unknown";
    }
  }
  recovered = false;
  constructor(
    private readonly storage: RecoveryStorage,
    private changed: () => void = () => {},
  ) {
    const saved = readRecovery(storage);
    if (saved) {
      this.input = saved.input;
      this.recovered = true;
      if (saved.status === "unknown") {
        this.phase = "unknown";
        this.lifecycle.restoreUnknown(saved.command);
        this.notice =
          "On-device submission outcome is unknown. Reconcile the exact original submission.";
      } else
        this.notice =
          "On-device unfinished input recovered. This is not a saved Ensemble task.";
    }
  }
  private publish() {
    if (this.active) this.changed();
  }
  edit(patch: Partial<ComposerInput>) {
    if (this.phase !== "editable") return;
    this.input = { ...this.input, ...patch };
    this.errors = {};
    this.notice = "";
    try {
      writeRecovery(this.storage, {
        version: 1,
        status: "unfinished",
        input: this.input,
      });
    } catch {
      this.notice =
        "Recovery unavailable for current edits. Reload may restore only the last successfully saved input.";
    }
    this.publish();
  }
  discard() {
    if (this.phase !== "editable") return;
    try {
      this.storage.removeItem(storageKey);
    } catch {}
    this.input = emptyInput();
    this.recovered = false;
    this.notice = "";
    this.publish();
  }
  async submit(client: OperatorClient, csrfToken: string, ready: boolean) {
    if (!this.active || this.phase === "pending" || this.phase === "recorded")
      return;
    const wasUnknown = this.phase === "unknown";
    if (!wasUnknown) {
      this.errors = {};
      const validated = validInputSchema.safeParse(this.input);
      if (!validated.success) {
        for (const issue of validated.error.issues)
          this.errors[String(issue.path[0] ?? "outcome")] = issue.message;
        this.publish();
        return;
      }
      let outcome: string;
      try {
        outcome = encodeOutcome(this.input);
      } catch (e) {
        this.errors.outcome =
          e instanceof Error ? e.message : "Invalid outcome";
        this.publish();
        return;
      }
      const command = creationSchema.parse({
        type: "task.create",
        key: crypto.randomUUID(),
        projectId: this.input.projectId,
        taskId: crypto.randomUUID(),
        title: validated.data.title,
        outcome,
        ready,
        ...(this.input.blockerTaskIds.length
          ? { blockerTaskIds: [...this.input.blockerTaskIds] }
          : {}),
        ...(this.input.profileId
          ? {
              initialAssignment: {
                assignmentId: crypto.randomUUID(),
                profileId: this.input.profileId,
              },
            }
          : {}),
      });
      if (byteLength(JSON.stringify(command)) > commandLimit) {
        this.errors.outcome =
          "The encoded command exceeds the 64 KiB service limit. Shorten the brief.";
        this.publish();
        return;
      }
      this.lifecycle.freeze(command);
    }
    const command = this.frozen;
    if (!command) return;
    try {
      writeRecovery(this.storage, {
        version: 1,
        status: "unknown",
        input: this.input,
        command,
      });
    } catch {
      if (!wasUnknown) {
        this.lifecycle.reset();
        this.phase = "editable";
      }
      this.notice =
        "Submission not sent. Recovery unavailable; current input remains in memory. Reload may restore only last successfully saved input.";
      this.publish();
      return;
    }
    const sending = this.lifecycle.begin();
    if (!sending) return;
    const isCurrent = this.captureScope();
    this.phase = "pending";
    this.notice = "Submitting the recorded creation request…";
    this.publish();
    const result = await client.command(sending, csrfToken);
    if (!isCurrent()) return;
    const disposition = this.lifecycle.settle(result, matchesCreationReceipt);
    if (disposition === "recorded") {
      this.phase = "recorded";
      this.notice = command.ready
        ? "Task recorded as Ready. Creation does not establish execution."
        : "Draft task saved in Ensemble.";
      try {
        this.storage.removeItem(storageKey);
      } catch {}
      this.recovered = false;
    } else if (disposition === "unknown") {
      this.phase = "unknown";
      this.notice =
        "Submission outcome is unknown. Reconcile the exact original submission; no automatic retry.";
    } else {
      this.phase = "editable";

      this.notice = `Submission rejected (${result.state === "recorded" ? "command-outcome-unknown" : result.code}). Input retained.`;
      try {
        writeRecovery(this.storage, {
          version: 1,
          status: "unfinished",
          input: this.input,
        });
      } catch {
        this.notice += " Recovery unavailable.";
      }
    }
    this.publish();
  }
}
