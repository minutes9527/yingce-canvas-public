import { transcriptForRange, type VideoBreakdown } from "@/lib/plugins/video-review";
import { separateVideoScreenText } from "@/lib/plugins/video-text-separation";
import { VIDEO_DURATION_OPTIONS } from "@/lib/video-generation-options";
import { frameScriptChinesePrompt, type FrameScriptCreativeContent, type FrameScriptOriginalAnalysis, type FrameScriptReplacementSetting, type FrameScriptStoryboardNodeState, type FrameScriptVideoReviewNodeState } from "./contracts";

export type FrameScriptStoryboardFrame = FrameScriptStoryboardNodeState["frames"][number];
export type FrameScriptCreativeEdit = Partial<FrameScriptCreativeContent & { durationSeconds: number }>;
export type FrameScriptReplacementScope = "current" | "selected" | "all";
export type FrameScriptReplacementDraft = Omit<FrameScriptReplacementSetting, "id">;
export type FrameScriptGenerationKind = "image" | "video";
export const FRAMESCRIPT_DEFAULT_GENERATION_SECONDS = VIDEO_DURATION_OPTIONS[0];

function withoutScreenText<T extends object>(value: T): T {
    const result = { ...value };
    delete (result as T & { screenText?: string }).screenText;
    return result;
}

export function frameScriptShotDurationSeconds(startMs: number, endMs: number) {
    const deltaMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : 0;
    return Math.max(1, Math.round(Math.max(0, deltaMs) / 1000));
}

/** A selected frame covers its analyzed segment, stopping earlier at the next selected frame. */
export function frameScriptShotEndMs(startMs: number, nextFrameMs: number | undefined, segmentEndMs: number | undefined, videoEndMs: number | undefined) {
    const candidates = [nextFrameMs, segmentEndMs, videoEndMs].filter((value): value is number => Number.isFinite(value) && value! > startMs);
    return candidates.length ? Math.min(...candidates) : startMs + 1000;
}

/** Older single-shot exports copied the remaining source-video length into generation duration. */
export function isLegacyFrameScriptSourceDuration(frame: Pick<FrameScriptStoryboardFrame, "timeMs" | "durationSeconds" | "durationSource">, videoDurationMs: number | undefined) {
    return !frame.durationSource && Number.isFinite(videoDurationMs) && videoDurationMs! > frame.timeMs
        && frame.durationSeconds > Math.max(...VIDEO_DURATION_OPTIONS)
        && frame.durationSeconds === frameScriptShotDurationSeconds(frame.timeMs, videoDurationMs!);
}

/** Repair persisted FrameScript rows when reopening older canvas snapshots. */
export function normalizeFrameScriptStoryboardState(state: FrameScriptStoryboardNodeState | undefined): FrameScriptStoryboardNodeState | undefined {
    if (!state || !Array.isArray(state.frames)) return state;
    const ordered = [...state.frames].sort((left, right) => (Number.isFinite(left.index) ? left.index : Number.MAX_SAFE_INTEGER) - (Number.isFinite(right.index) ? right.index : Number.MAX_SAFE_INTEGER) || left.timeMs - right.timeMs);
    const referenceNodeIds = Array.from(new Set([...(state.referenceNodeIds ?? [])].filter(Boolean)));
    const frames = ordered.map((frame, index) => {
        const timeMs = Math.max(0, Math.round(Number.isFinite(frame.timeMs) ? frame.timeMs : 0));
        const nextTimeMs = ordered[index + 1]?.timeMs;
        const inferredDuration = nextTimeMs !== undefined ? frameScriptShotDurationSeconds(timeMs, nextTimeMs) : undefined;
        const durationSeconds = Number.isFinite(frame.durationSeconds) && frame.durationSeconds > 0 ? Math.max(1, Math.round(frame.durationSeconds)) : inferredDuration || 1;
        const final = frameScriptFinalContent(frame);
        const frameReferences = Array.from(new Set([...(frame.referenceNodeIds ?? []), ...(frame.referenceNodeId ? [frame.referenceNodeId] : [])].filter(Boolean)));
        return {
            ...withoutScreenText(frame),
            index: state.presentation === "single-shot" ? frame.index : index + 1,
            timeMs,
            durationSeconds,
            imageGenerationPrompt: frame.imageGenerationPrompt ?? final.imageGenerationPrompt,
            videoMotionPrompt: frame.videoMotionPrompt ?? final.videoMotionPrompt,
            dialogue: frame.dialogue ?? final.dialogue,
            originalAnalysis: frame.originalAnalysis ? withoutScreenText(frame.originalAnalysis) : undefined,
            originalAnalysisHistory: frame.originalAnalysisHistory?.map(withoutScreenText),
            creativeHistory: frame.creativeHistory?.map(withoutScreenText),
            referenceNodeId: frameReferences[0],
            referenceNodeIds: frameReferences,
            replacementSettings: frame.replacementSettings?.map((setting: FrameScriptReplacementSetting) => ({ ...setting, referenceNodeIds: [...(setting.referenceNodeIds ?? [])].filter(Boolean) })),
        };
    });
    return { ...state, referenceNodeIds, frames };
}

/** Shared binding for every generation window created from a FrameScript row. */
export function frameScriptGenerationMetadata(frame: FrameScriptStoryboardFrame, kind: FrameScriptGenerationKind, storyboardNodeId: string, referenceNodeIds: readonly string[] = []) {
    const content = frameScriptFinalContent(frame);
    const prompt = (kind === "image" ? content.imageGenerationPrompt : content.videoMotionPrompt).trim();
    const references = Array.from(new Set(referenceNodeIds.filter(Boolean)));
    const replacementReferences = references.filter((id) => id !== frame.imageNodeId);
    return {
        prompt,
        composerContent: prompt,
        workflowKind: "shot" as const,
        workflowTitle: `镜头 ${frame.index} ${kind === "image" ? "分镜图" : "视频"}`,
        shotIndex: frame.index,
        frameScriptStoryboardNodeId: storyboardNodeId,
        frameScriptStoryboardFrameId: frame.id,
        frameScriptStoryboardReferenceNodeId: replacementReferences[0],
        frameScriptStoryboardReferenceNodeIds: references,
        frameScriptStoryboardImagePrompt: content.imageGenerationPrompt,
        frameScriptStoryboardVideoPrompt: content.videoMotionPrompt,
        ...(kind === "image" && frame.imageModel ? { model: frame.imageModel } : {}),
        ...(kind === "video" ? {
            generationMode: "video" as const,
            videoEditOperation: "image_to_video" as const,
            seconds: String(frame.durationSeconds),
        } : {}),
    };
}

/** One mapping for both initial export and subsequent source-analysis previews. */
export function frameScriptOriginalAnalysisForFrame(breakdown: VideoBreakdown | undefined, frameId: string): FrameScriptOriginalAnalysis | undefined {
    if (!breakdown) return undefined;
    const frames = [...breakdown.review.frames].sort((a, b) => a.timeMs - b.timeMs);
    const index = frames.findIndex((frame) => frame.id === frameId);
    if (index < 0) return undefined;
    const frame = frames[index];
    const segment = breakdown.analysis.segments.find((item) => item.keyframe?.timeMs === frame.timeMs)
        ?? breakdown.analysis.segments.find((item) => item.startMs <= frame.timeMs && item.endMs > frame.timeMs);
    const endMs = frameScriptShotEndMs(frame.timeMs, frames[index + 1]?.timeMs, segment?.endMs, breakdown.analysis.durationMs);
    if (!segment) return undefined;
    const description = separateVideoScreenText(segment.description);
    const prompt = separateVideoScreenText(segment.prompt);
    return {
        sourceVideoId: breakdown.review.source.id,
        sourceFingerprint: breakdown.review.sourceFingerprint,
        reviewRevision: breakdown.review.revision,
        startMs: frame.timeMs,
        endMs,
        description: description.visual,
        imageGenerationPrompt: prompt.visual || description.visual,
        // Motion analysis remains a separate planned step; keep today's source description.
        videoMotionPrompt: description.visual || prompt.visual,
        dialogue: segment.transcript || transcriptForRange(breakdown.transcript, frame.timeMs, endMs)
            .map((item) => item.cleanedText || item.originalText).filter(Boolean).join(" "),
    };
}

export function frameScriptInitialCreativeContent(analysis: FrameScriptOriginalAnalysis): FrameScriptCreativeContent {
    return {
        imageGenerationPrompt: frameScriptChinesePrompt(analysis.imageGenerationPrompt),
        videoMotionPrompt: frameScriptChinesePrompt(analysis.videoMotionPrompt),
        dialogue: analysis.dialogue,
    };
}

/** Generation must consume final fields, including an intentionally cleared field. */
export function frameScriptFinalContent(frame: FrameScriptStoryboardFrame): FrameScriptCreativeContent {
    return {
        imageGenerationPrompt: frame.imageGenerationPrompt ?? (frame.originalAnalysis ? frameScriptChinesePrompt(frame.originalAnalysis.imageGenerationPrompt) : frameScriptChinesePrompt(frame.description)),
        videoMotionPrompt: frame.videoMotionPrompt ?? (frame.originalAnalysis ? frameScriptChinesePrompt(frame.originalAnalysis.videoMotionPrompt) : frameScriptChinesePrompt(frame.description)),
        dialogue: frame.dialogue ?? frame.originalAnalysis?.dialogue ?? "",
    };
}

export function editFrameScriptCreativeContent(frame: FrameScriptStoryboardFrame, edit: FrameScriptCreativeEdit): FrameScriptStoryboardFrame {
    const next = { ...frame, ...frameScriptFinalContent(frame) };
    for (const key of ["imageGenerationPrompt", "videoMotionPrompt", "dialogue"] as const) {
        if (edit[key] !== undefined) next[key] = edit[key];
    }
    if (edit.durationSeconds !== undefined) {
        if (!Number.isFinite(edit.durationSeconds) || edit.durationSeconds < 1) throw new Error("镜头时长至少为 1 秒");
        next.durationSeconds = edit.durationSeconds;
        next.durationSource = "manual";
    }
    return next;
}

export function frameScriptLatestOriginalAnalysis(state: FrameScriptStoryboardNodeState, frame: FrameScriptStoryboardFrame, review: FrameScriptVideoReviewNodeState | undefined) {
    if (review?.status !== "completed" || !state.sourceVideoId || review.breakdown?.review.source.id !== state.sourceVideoId) return undefined;
    const candidate = frameScriptOriginalAnalysisForFrame(review.breakdown, frame.id);
    if (!candidate || candidate.startMs !== frame.timeMs) return undefined;
    if (frame.originalAnalysis && candidate.sourceFingerprint !== frame.originalAnalysis.sourceFingerprint) return undefined;
    return candidate;
}

export function sameFrameScriptOriginalAnalysis(left: FrameScriptOriginalAnalysis | undefined, right: FrameScriptOriginalAnalysis | undefined) {
    return JSON.stringify(left) === JSON.stringify(right);
}

/** Called only by the explicit apply action. Creative fields and references are untouched. */
export function applyFrameScriptOriginalAnalysis(frame: FrameScriptStoryboardFrame, candidate: FrameScriptOriginalAnalysis): FrameScriptStoryboardFrame {
    if (candidate.startMs !== frame.timeMs || (frame.originalAnalysis && (candidate.sourceVideoId !== frame.originalAnalysis.sourceVideoId || candidate.sourceFingerprint !== frame.originalAnalysis.sourceFingerprint))) {
        throw new Error("分析结果不属于当前镜头");
    }
    if (sameFrameScriptOriginalAnalysis(frame.originalAnalysis, candidate)) return frame;
    return {
        ...frame,
        originalAnalysis: { ...candidate },
        originalAnalysisHistory: frame.originalAnalysis ? [...(frame.originalAnalysisHistory ?? []), { ...frame.originalAnalysis }] : frame.originalAnalysisHistory,
    };
}

/** Apply an explicit person/product replacement to final generation prompts only. */
export function applyFrameScriptReplacement(frame: FrameScriptStoryboardFrame, setting: FrameScriptReplacementSetting): FrameScriptStoryboardFrame {
    const replacement = setting.replacementDescription.trim();
    if (!replacement) throw new Error("替换内容不能为空");
    const original = setting.originalDescription.trim();
    const replacePrompt = (value: string) => {
        if (original && value.includes(original)) return value.split(original).join(replacement);
        const marker = `${setting.kind === "person" ? "人物" : "产品"}替换：${replacement}`;
        return value.includes(marker) ? value : [value.trim(), marker].filter(Boolean).join("；");
    };
    const current = frameScriptFinalContent(frame);
    const replacementSettings = [...(frame.replacementSettings ?? []).filter((item) => item.id !== setting.id), { ...setting, referenceNodeIds: [...setting.referenceNodeIds] }];
    const referenceNodeIds = Array.from(new Set([...(frame.referenceNodeIds ?? []), ...(frame.referenceNodeId ? [frame.referenceNodeId] : []), ...setting.referenceNodeIds]));
    return {
        ...frame,
        imageGenerationPrompt: replacePrompt(current.imageGenerationPrompt),
        videoMotionPrompt: replacePrompt(current.videoMotionPrompt),
        replacementSettings,
        referenceNodeId: referenceNodeIds[0],
        referenceNodeIds,
    };
}
