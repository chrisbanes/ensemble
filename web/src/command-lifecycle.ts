import type {
  CommandReceipt,
  OperatorCommand,
} from "../../src/operator/contracts.js";
import type { CommandState } from "./api.js";
export type CommandDisposition =
  | "recorded"
  | "unknown"
  | "conflict"
  | "rejected";
/** Owns the original validated operation; consumers own validation and effects. */
export class CommandLifecycle<C extends OperatorCommand> {
  private command: C | null = null;
  private originalBytes: string | null = null;
  private originalReceipt: CommandReceipt | null = null;
  private sending = false;
  private unknown = false;
  get frozen(): C | null {
    return this.command ? structuredClone(this.command) : null;
  }
  get bytes() {
    return this.originalBytes;
  }
  get receipt(): CommandReceipt | null {
    return this.originalReceipt ? structuredClone(this.originalReceipt) : null;
  }
  get uncertain() {
    return this.unknown;
  }
  freeze(command: C) {
    if (this.sending || this.unknown || this.originalReceipt) return false;
    this.command = structuredClone(command);
    this.originalBytes = JSON.stringify(this.command);
    return true;
  }
  restoreUnknown(command: C) {
    if (!this.freeze(command)) return false;
    this.unknown = true;
    return true;
  }
  begin(): C | null {
    if (!this.command || this.sending || this.originalReceipt) return null;
    this.sending = true;
    return structuredClone(this.command);
  }
  settle(
    result: CommandState,
    matches: (command: C, receipt: CommandReceipt) => boolean,
  ): CommandDisposition {
    const command = this.command;
    this.sending = false;
    if (
      command &&
      result.state === "recorded" &&
      result.receipt.key === command.key &&
      matches(structuredClone(command), result.receipt)
    ) {
      this.originalReceipt = structuredClone(result.receipt);
      this.unknown = false;
      return "recorded";
    }
    if (
      this.unknown ||
      result.state === "unknown" ||
      result.state === "recorded"
    ) {
      this.unknown = true;
      return "unknown";
    }
    this.reset();
    return result.state;
  }
  reset() {
    this.command = null;
    this.originalBytes = null;
    this.originalReceipt = null;
    this.sending = false;
    this.unknown = false;
  }
}
