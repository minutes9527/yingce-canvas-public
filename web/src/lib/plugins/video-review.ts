import type { AnalysisResult, VideoAnalysisKeyframe, VideoAnalysisWarning, VideoTranscript } from "./video-plugin";
import { VideoPluginError } from "./video-plugin";
import type { VideoResourceRef } from "@/lib/video-engine/video-ir";
import { isResourceUrl } from "@/services/api/resources";

export type ReviewFrame = VideoAnalysisKeyframe & { id: string; shotId?: string };

/** Portable descriptors only. Original media stays in the authorized resource store. */
export type VideoReviewDraft = {
    schema: "yingce.video-review";
    version: 1;
    state: "awaiting-review";
    source: VideoResourceRef;
    sourceFingerprint: string;
    revision: number;
    durationMs: number;
    frames: readonly ReviewFrame[];
    transcript?: VideoTranscript;
    /** Optional for backward compatibility with persisted pre-warning review drafts. */
    warnings?: readonly VideoAnalysisWarning[];
    screenText: readonly { frameId: string; text: string; confidence?: number }[];
    detectors: readonly string[];
};

export type ConfirmedVideoReview = {
    state: "confirmed";
    source: VideoResourceRef;
    sourceFingerprint: string;
    revision: number;
    frames: readonly ReviewFrame[];
};

/** Analysis output remains separate from Video IR and is explicitly unverified. */
export type VideoBreakdown = {
    schema: "yingce.video-breakdown";
    version: 1;
    review: ConfirmedVideoReview;
    transcript?: VideoTranscript;
    screenText: VideoReviewDraft["screenText"];
    analysis: AnalysisResult;
    evidenceStatus: "model-output-unverified";
};

export function createVideoReviewDraft(source: VideoResourceRef, result: AnalysisResult): VideoReviewDraft {
    if (!result?.sourceFingerprint || !Number.isFinite(result.durationMs) || result.durationMs! <= 0 || !Array.isArray(result.keyframes) || !result.keyframes.length) fail("视频准备结果缺少原视频指纹、时长或候选帧");
    const frames = Array.from(result.keyframes, (frame) => portableReviewFrame({ ...frame, id: `frame-${frame?.timeMs}` }));
    const draft: VideoReviewDraft = {
        schema: "yingce.video-review",
        version: 1,
        state: "awaiting-review",
        source,
        sourceFingerprint: result.sourceFingerprint,
        revision: 1,
        durationMs: result.durationMs!,
        frames,
        transcript: result.transcript,
        warnings: result.warnings ? result.warnings.map(portableAnalysisWarning) : [],
        screenText: [],
        detectors: result.detectors ?? [],
    };
    validateVideoReviewDraft(draft);
    return structuredClone({ ...draft, frames: frames.sort((a, b) => a.timeMs - b.timeMs) });
}

/** Confirmation is explicit and produces a detached snapshot, not a mutable UI selection. */
export function confirmVideoReview(draft: VideoReviewDraft, selectedIds: readonly string[]): ConfirmedVideoReview {
    validateVideoReviewDraft(draft);
    if (!Array.isArray(selectedIds) || !selectedIds.length || Array.from(selectedIds).some((id) => typeof id !== "string" || !id.trim()) || new Set(selectedIds).size !== selectedIds.length) fail("请确认至少一张不重复的候选帧");
    const byId = new Map(draft.frames.map((frame) => [frame.id, frame]));
    const frames = selectedIds
        .map((id) => {
            const frame = byId.get(id);
            if (!frame) fail("确认中包含不属于当前视频的候选帧");
            return portableReviewFrame(frame);
        })
        .sort((a, b) => a.timeMs - b.timeMs);
    return structuredClone({ state: "confirmed", source: draft.source, sourceFingerprint: draft.sourceFingerprint, revision: draft.revision, frames });
}

export function assertVideoReview(draft: VideoReviewDraft, review: ConfirmedVideoReview) {
    validateVideoReviewDraft(draft);
    if (review?.state !== "confirmed" || review.revision !== draft.revision || review.sourceFingerprint !== draft.sourceFingerprint || review.source?.id !== draft.source.id || review.source?.kind !== draft.source.kind)
        fail("人工确认已过期或不属于当前视频，请重新确认");
    validateFrames(review.frames, draft.durationMs);
    const expected = confirmVideoReview(
        draft,
        review.frames.map((frame) => frame.id),
    );
    if (expected.frames.some((frame, index) => !sameReviewFrame(frame, review.frames[index]))) fail("候选帧已变更，请重新确认");
}

/**
 * Validates a detached confirmation at the plugin boundary. The workflow also
 * checks that the selected frames came from its draft; direct plugin callers do
 * not have that draft, so they still need the structural/source checks here.
 */
export function validateConfirmedVideoReview(review: ConfirmedVideoReview, durationMs?: number) {
    if (
        review?.state !== "confirmed" ||
        !review.source ||
        !["asset", "resource"].includes(review.source.kind) ||
        typeof review.source.id !== "string" ||
        !/^[\w-]{1,200}$/.test(review.source.id) ||
        typeof review.sourceFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(review.sourceFingerprint) ||
        !Number.isSafeInteger(review.revision) ||
        review.revision < 1
    ) fail("人工确认快照无效，请重新确认候选帧");
    const resolvedDuration = durationMs ?? Math.max(...(review.frames || []).map((frame) => (Number.isFinite(frame?.timeMs) ? frame.timeMs + 1 : 0)), 1);
    validateFrames(review.frames, resolvedDuration);
}

export function validateVideoReviewDraft(draft: VideoReviewDraft) {
    if (
        draft?.schema !== "yingce.video-review" ||
        draft.version !== 1 ||
        draft.state !== "awaiting-review" ||
        !Number.isSafeInteger(draft.revision) ||
        draft.revision < 1 ||
        typeof draft.sourceFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(draft.sourceFingerprint) ||
        !draft.source ||
        !["asset", "resource"].includes(draft.source.kind) ||
        typeof draft.source.id !== "string" ||
        !/^[\w-]{1,200}$/.test(draft.source.id) ||
        !Array.isArray(draft.frames) ||
        !draft.frames.length ||
        (draft.warnings !== undefined && !validAnalysisWarnings(draft.warnings))
    )
        fail("视频复核草稿无效");
    validateFrames(draft.frames, draft.durationMs);
}

function portableAnalysisWarning(warning: VideoAnalysisWarning): VideoAnalysisWarning {
    return { stage: "transcription", message: warning.message.trim().slice(0, 500) };
}

function validAnalysisWarnings(value: unknown): value is readonly VideoAnalysisWarning[] {
    return Array.isArray(value) && value.every((warning) => warning
        && warning.stage === "transcription"
        && typeof warning.message === "string"
        && warning.message.trim().length > 0
        && warning.message.length <= 500);
}

/** Manual changes are a new candidate revision and deliberately invalidate confirmation. */
export function editVideoReviewFrame(draft: VideoReviewDraft, timeMs: number, replaceId?: string): VideoReviewDraft {
    validateVideoReviewDraft(draft);
    if (replaceId && !draft.frames.some((frame) => frame.id === replaceId)) fail("被替换的候选帧不存在");
    const frame: ReviewFrame = { id: `frame-${timeMs}`, timeMs, score: 0, reasons: ["manual"], hardTrigger: false };
    const frames = [...draft.frames.filter((entry) => entry.id !== replaceId), frame].sort((left, right) => left.timeMs - right.timeMs);
    validateFrames(frames, draft.durationMs);
    return structuredClone({ ...draft, frames, revision: draft.revision + 1, screenText: draft.screenText.filter((entry) => entry.frameId !== replaceId) });
}

export function transcriptForRange(transcript: VideoTranscript | undefined, startMs: number, endMs: number) {
    return transcript?.segments.filter((segment) => segment.startMs < endMs && segment.endMs > startMs) ?? [];
}

/** Whitelists immutable detector output before it reaches a confirmation or persisted draft. */
export function portableReviewFrame(frame: ReviewFrame): ReviewFrame {
    return {
        id: frame.id,
        timeMs: frame.timeMs,
        eventTimeMs: frame.eventTimeMs,
        quality: frame.quality,
        qualityMethod: frame.qualityMethod,
        qualityAdjusted: frame.qualityAdjusted,
        score: frame.score,
        scoreBreakdown: frame.scoreBreakdown ? portableScoreBreakdown(frame.scoreBreakdown) : undefined,
        confidence: frame.confidence,
        motionDirection: frame.motionDirection,
        semanticSignals: frame.semanticSignals?.map((signal) => ({
            kind: signal.kind,
            score: signal.score,
            reason: signal.reason,
            detector: signal.detector,
            evidence: signal.evidence,
        })),
        reasons: [...frame.reasons],
        hardTrigger: frame.hardTrigger,
        width: frame.width,
        height: frame.height,
        previewDataUrl: frame.previewDataUrl,
        shotId: frame.shotId,
    };
}

function portableScoreBreakdown(score: NonNullable<VideoAnalysisKeyframe["scoreBreakdown"]>) {
    return {
        adjacentDifference: score.adjacentDifference,
        retainedDifference: score.retainedDifference,
        visualChange: score.visualChange,
        corroboration: score.corroboration,
        composite: score.composite,
        sceneCut: score.sceneCut,
        transition: score.transition,
        exposureChange: score.exposureChange,
        motion: score.motion,
        ...(score.semantic ? { semantic: { ...score.semantic } } : {}),
    };
}

function sameReviewFrame(left: ReviewFrame, right: ReviewFrame | undefined) {
    if (!right) return false;
    return JSON.stringify(portableReviewFrame(left)) === JSON.stringify(portableReviewFrame(right));
}

function validateFrames(frames: readonly ReviewFrame[], durationMs: number) {
    if (!Array.isArray(frames) || !frames.length || !Number.isFinite(durationMs) || durationMs <= 0) fail("候选帧数据无效");
    const ids = new Set<string>();
    const times = new Set<number>();
    for (const frame of frames) {
        if (
            !frame ||
            typeof frame !== "object" ||
            typeof frame.id !== "string" ||
            !frame.id.trim() ||
            ids.has(frame.id) ||
            times.has(frame.timeMs) ||
            !Number.isInteger(frame.timeMs) ||
            frame.timeMs < 0 ||
            frame.timeMs >= durationMs ||
            !Number.isFinite(frame.score) ||
            frame.score < 0 ||
            frame.score > 1 ||
            (frame.confidence !== undefined && (!Number.isFinite(frame.confidence) || frame.confidence < 0 || frame.confidence > 1)) ||
            (frame.motionDirection !== undefined && !["left", "right", "up", "down", "static"].includes(frame.motionDirection)) ||
            (frame.semanticSignals !== undefined && !validSemanticSignals(frame.semanticSignals)) ||
            (frame.scoreBreakdown !== undefined && !validScoreBreakdown(frame.scoreBreakdown)) ||
            (frame.quality !== undefined && (!Number.isFinite(frame.quality) || frame.quality < 0 || frame.quality > 1)) ||
            (frame.eventTimeMs !== undefined && (!Number.isInteger(frame.eventTimeMs) || frame.eventTimeMs < 0 || frame.eventTimeMs >= durationMs)) ||
            (frame.previewDataUrl !== undefined && (typeof frame.previewDataUrl !== "string" || !(isResourceUrl(frame.previewDataUrl) || (/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(frame.previewDataUrl) && frame.previewDataUrl.length <= 250_000))))
        )
            fail("候选帧数据无效");
        ids.add(frame.id);
        times.add(frame.timeMs);
    }
}

function validScoreBreakdown(value: NonNullable<VideoAnalysisKeyframe["scoreBreakdown"]>) {
    const required = [value.adjacentDifference, value.retainedDifference, value.visualChange, value.corroboration, value.composite];
    const optional = [value.sceneCut, value.transition, value.exposureChange, value.motion].filter((part) => part !== undefined);
    const semantic = value.semantic ? Object.values(value.semantic) : [];
    return [...required, ...optional, ...semantic].every((part) => Number.isFinite(part) && part >= 0 && part <= 1);
}

function validSemanticSignals(signals: NonNullable<VideoAnalysisKeyframe["semanticSignals"]>) {
    return signals.length > 0 && signals.every((signal) => Boolean(signal)
        && typeof signal.detector === "string" && signal.detector.trim().length > 0
        && Number.isFinite(signal.score) && signal.score >= 0 && signal.score <= 1
        && typeof signal.kind === "string" && typeof signal.reason === "string"
        && (signal.evidence === undefined || typeof signal.evidence === "string"));
}

function fail(message: string): never {
    throw new VideoPluginError("invalid-input", message);
}
