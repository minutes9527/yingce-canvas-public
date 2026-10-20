import { describe, expect, test } from "bun:test";

import type { AnalysisResult } from "@/lib/plugins/video-plugin";
import { createVideoReviewDraft } from "@/lib/plugins/video-review";
import { VideoReviewWorkflow } from "@/services/video-review-workflow";

const source = { kind: "asset" as const, id: "source-video" };
const fingerprint = "a".repeat(64);
const prepared: AnalysisResult = {
    pluginId: "framescript-video-engine",
    status: "completed",
    sourceFingerprint: fingerprint,
    durationMs: 10_000,
    segments: [],
    keyframes: [{ timeMs: 0, score: 0.8, reasons: ["opening"], hardTrigger: true }],
    warnings: [{ stage: "transcription", message: "语音转写未完成：Request failed with status code 403" }],
};

describe("FrameScript review workflow", () => {
    test("can prepare candidate frames without blocking on transcription", async () => {
        const calls: unknown[] = [];
        const workflow = new VideoReviewWorkflow({ analyze: async (_provider, input) => {
            calls.push(input);
            return prepared;
        } });
        const draft = await workflow.prepare({ pluginId: "framescript-video-engine", contributionId: "framescript-video-engine" }, source, false);
        expect(calls).toEqual([expect.objectContaining({ media: source, operations: ["adaptive-keyframe-extraction"] })]);
        expect(draft.frames).toHaveLength(1);
        expect(draft.transcript).toBeUndefined();
    });

    test("retries only transcription and preserves prepared candidate frames", async () => {
        const calls: unknown[] = [];
        const workflow = new VideoReviewWorkflow({ analyze: async (_provider, input) => {
            calls.push(input);
            return { ...prepared, keyframes: undefined, sourceFingerprint: fingerprint, transcript: { text: "恢复后的转写", segments: [] }, warnings: undefined };
        } });
        const draft = createVideoReviewDraft(source, prepared);
        const next = await workflow.retryTranscription({ pluginId: "framescript-video-engine", contributionId: "framescript-video-engine" }, draft);
        expect(calls).toEqual([expect.objectContaining({ media: source, operations: ["transcription"] })]);
        expect(next.frames).toEqual(draft.frames);
        expect(next.transcript?.text).toBe("恢复后的转写");
        expect(next.warnings).toEqual([]);
    });

    test("rejects retry output when the source changed", async () => {
        const workflow = new VideoReviewWorkflow({ analyze: async () => ({ ...prepared, keyframes: undefined, sourceFingerprint: "b".repeat(64) }) });
        await expect(workflow.retryTranscription({ pluginId: "framescript-video-engine", contributionId: "framescript-video-engine" }, createVideoReviewDraft(source, prepared))).rejects.toThrow("原视频已变化");
    });
});
