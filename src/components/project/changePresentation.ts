import type { ProjectGitChange } from "../../project/types";

export function changeStatusLabel(change: ProjectGitChange): string {
  if (change.index === "conflict" || change.worktree === "conflict") return "CONFLITTO";
  if (change.untracked) return "NUOVO";
  if (change.index === "deleted" || change.worktree === "deleted") return "ELIMINATO";
  if (change.index === "renamed" || change.worktree === "renamed") return "RINOMINATO";

  const staged = change.index !== "clean";
  const modified = change.worktree !== "clean";
  if (staged && modified) return "STAGED + MODIFICATO";
  if (staged) return "STAGED";
  if (modified) return "MODIFICATO";
  return "CLEAN";
}

export function changeTone(change: ProjectGitChange): string {
  if (change.index === "conflict" || change.worktree === "conflict") {
    return "text-red-200 bg-red-400/[0.13] border-red-300/30";
  }
  if (change.untracked || change.index === "added" || change.worktree === "added") {
    return "text-emerald-200 bg-emerald-400/[0.12] border-emerald-300/25";
  }
  if (change.index === "deleted" || change.worktree === "deleted") {
    return "text-red-200 bg-red-400/[0.10] border-red-300/25";
  }
  if (change.index === "renamed" || change.worktree === "renamed") {
    return "text-sky-200 bg-sky-400/[0.11] border-sky-300/25";
  }
  return "text-primary bg-primary/[0.18] border-primary/40";
}

export function changeDetail(change: ProjectGitChange): string {
  return `Index: ${change.index}; working tree: ${change.worktree}`;
}

function stateCode(state: ProjectGitChange["index"]): string {
  switch (state) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "conflict":
      return "!";
    default:
      return "";
  }
}

export function changeStatusCode(change: ProjectGitChange, staged?: boolean): string {
  if (staged !== undefined) {
    if (change.untracked && !staged) return "U";
    return stateCode(staged ? change.index : change.worktree) || (change.untracked ? "U" : "M");
  }
  if (change.index === "conflict" || change.worktree === "conflict") return "!";
  if (change.untracked) return "U";
  return stateCode(change.index) || stateCode(change.worktree) || "M";
}
