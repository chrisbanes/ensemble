const UPDATED_AT_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

const COUNT_FORMATTER = new Intl.NumberFormat("en-US");

export function formatUpdatedAt(value: string | null): string | null {
  if (!value) return null;

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;

  return `Updated ${UPDATED_AT_FORMATTER.format(date)} UTC`;
}

export function formatTokenCount(value: number): string {
  return `${COUNT_FORMATTER.format(value)} tokens`;
}
