import type { PendingAction } from "./types";

export interface PendingActionEditorState {
  action: PendingAction;
  editing: boolean;
  saving: boolean;
}

export function canConfirmPendingAction(state: PendingActionEditorState): boolean {
  return state.action.status === "pending" && !state.editing && !state.saving;
}

export async function savePendingActionEdit(
  state: PendingActionEditorState,
  text: string,
  update: (action: PendingAction, text: string) => Promise<PendingAction>,
): Promise<PendingActionEditorState> {
  const latest = await update(state.action, text);
  return { action: latest, editing: false, saving: false };
}
