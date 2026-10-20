import { VideoPluginError } from "./video-plugin";
import { portableReviewFrame, validateVideoReviewDraft, type VideoReviewDraft } from "./video-review";

/** Copies only portable review metadata. Blobs, URLs, configurations and arbitrary metadata never persist. */
export function snapshotVideoReview(draft: VideoReviewDraft): VideoReviewDraft {
    validateVideoReviewDraft(draft);
    const snapshot = structuredClone({
        schema: draft.schema, version: draft.version, state: draft.state,
        source: { kind: draft.source.kind, id: draft.source.id }, sourceFingerprint: draft.sourceFingerprint,
        revision: draft.revision, durationMs: draft.durationMs,
        frames: draft.frames.map(portableReviewFrame),
        transcript: draft.transcript ? { text: draft.transcript.text, segments: draft.transcript.segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs, originalText: segment.originalText, cleanedText: segment.cleanedText, speaker: segment.speaker, confidence: segment.confidence, shotIds: segment.shotIds ? [...segment.shotIds] : undefined })) } : undefined,
        warnings: draft.warnings?.map((warning) => ({ stage: warning.stage, message: warning.message })),
        screenText: draft.screenText.map((entry) => ({ frameId: entry.frameId, text: entry.text, confidence: entry.confidence })),
        detectors: [...draft.detectors],
    });
    validateVideoReviewDraft(snapshot);
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 8 * 1024 * 1024) throw new VideoPluginError("invalid-input", "复核草稿超过 8 MiB，请拆分视频；未截断保存");
    return snapshot;
}

export function snapshotReviewSelection(draft: VideoReviewDraft, selectedIds: readonly string[], options?: { allowEmpty?: boolean }) {
    const ids = new Set(draft.frames.map((frame) => frame.id));
    if (!Array.isArray(selectedIds) || (!options?.allowEmpty && !selectedIds.length) || new Set(selectedIds).size !== selectedIds.length || selectedIds.some((id) => typeof id !== "string" || !ids.has(id))) {
        throw new VideoPluginError("invalid-input", "复核草稿或选择数据无效，未保存");
    }
    return [...selectedIds];
}
