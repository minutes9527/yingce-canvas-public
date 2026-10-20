import { describe, expect, test } from "bun:test";

import { settleFrameScriptTranscription } from "@/lib/plugins/builtin/framescript-video-engine";
import { createVideoReviewDraft } from "@/lib/plugins/video-review";
import { snapshotVideoReview } from "@/lib/plugins/video-review-snapshot";
import type { AnalysisResult } from "@/lib/plugins/video-plugin";

const source = { kind: "asset" as const, id: "source-video" };
const prepared: AnalysisResult = {
    pluginId: "framescript-video-engine",
    status: "completed",
    sourceFingerprint: "a".repeat(64),
    durationMs: 10_000,
    segments: [],
    keyframes: [{ timeMs: 0, score: 0.8, reasons: ["opening"], hardTrigger: true }],
};

describe("FrameScript transcription fallback", () => {
    test("keeps candidate-frame preparation usable when the system channel rejects transcription", async () => {
        const settled = await settleFrameScriptTranscription(async () => {
            throw new Error("系统渠道语音转写失败：Request failed with status code 403");
        });
        expect(settled.transcript).toBeUndefined();
        expect(settled.warning).toEqual({ stage: "transcription", message: "语音转写未完成：系统渠道语音转写失败：Request failed with status code 403" });

        const draft = createVideoReviewDraft(source, { ...prepared, warnings: [settled.warning!] });
        expect(draft.frames).toHaveLength(1);
        expect(draft.warnings).toEqual([settled.warning]);
        expect(snapshotVideoReview(draft).warnings).toEqual([settled.warning]);
    });

    test("does not convert a user cancellation into a recoverable transcription warning", async () => {
        const controller = new AbortController();
        controller.abort(new DOMException("已取消", "AbortError"));
        await expect(settleFrameScriptTranscription(async () => {
            throw controller.signal.reason;
        }, controller.signal)).rejects.toThrow("已取消");
    });

    test("keeps persisted drafts from before optional warnings readable", () => {
        const { warnings: _warnings, ...legacyDraft } = createVideoReviewDraft(source, prepared);
        const restored = snapshotVideoReview(JSON.parse(JSON.stringify(legacyDraft)));
        expect(restored.warnings).toBeUndefined();
    });
});
