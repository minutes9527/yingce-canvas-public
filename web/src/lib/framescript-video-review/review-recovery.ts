import type { FrameScriptVideoReviewNodeState } from "./contracts";

/** Canvas results are authoritative; checkpoints only recover missing or interrupted work. */
export function canRestoreFrameScriptReviewCheckpoint(
    state: FrameScriptVideoReviewNodeState,
    session: { open: boolean; autoPrepare: boolean; staleSource: boolean; activeRequest: boolean },
) {
    if (!session.open || session.autoPrepare || session.staleSource || session.activeRequest) return false;
    const interrupted = state.status === "preparing" || state.status === "transcribing" || state.status === "analyzing";
    return interrupted || !(state.draft || state.breakdown);
}
