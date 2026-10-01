export interface RoutedTaskSettlementState {
  taskState: string;
  requestStates: readonly string[];
  intentStates: readonly string[];
  assignmentStates: readonly string[];
  messagesDelivered: boolean;
  activeIntents: number;
  activeCallbacks: number;
}

/** Candidate terminal is not settled while its lead still owes a decision. */
export function isRoutedTaskSettled(state: RoutedTaskSettlementState): boolean {
  return (
    state.taskState === "done" &&
    state.requestStates.length > 0 &&
    state.requestStates.every((request) => request === "completed") &&
    state.intentStates.length === state.requestStates.length &&
    state.intentStates.every((intent) => intent === "completed") &&
    state.assignmentStates.length > 0 &&
    state.assignmentStates.every((assignment) => assignment === "completed") &&
    state.messagesDelivered &&
    state.activeIntents === 0 &&
    state.activeCallbacks === 0
  );
}
