export function isSyntheticHaltedInteractionId(id: string | null | undefined): boolean {
  return id?.startsWith("halted:") ?? false;
}
