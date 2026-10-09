/** How operator feedback reaches the task lead; one source of copy for every entry point. */
export type LeadFeedbackMode = "receives" | "resumes" | "unavailable";

/**
 * The server's decision when the read carries it. Older reads fall back to the
 * lead's state and never offer a resume the server did not announce.
 */
export function leadFeedbackMode(
  data: { leadFeedback?: { mode: LeadFeedbackMode } | undefined },
  leadState: string | undefined,
): LeadFeedbackMode {
  if (data.leadFeedback) return data.leadFeedback.mode;
  return leadState === "pending" || leadState === "running"
    ? "receives"
    : "unavailable";
}

export const leadResumeNotice = (name: string) =>
  `${name} has completed its assignment and will resume to address this feedback.`;

export const leadAwaitingRecoveryNotice = (name: string) =>
  `${name} is waiting for an operator message to continue after recovery. Sending this review won't resume it. Send an ordinary message to continue.`;
