import { describe, expect, test } from "bun:test";

import type { VideoIR } from "@/lib/video-engine/video-ir";
import type { AnalysisResult, VideoAnalyzerPlugin, VideoInput, VideoRendererPlugin } from "@/lib/plugins/video-plugin";
import { assertVideoReview, confirmVideoReview, createVideoReviewDraft } from "@/lib/plugins/video-review";

const source = { kind: "asset" as const, id: "source-video" };

const videoIR: VideoIR = {
    schema: "yingce.video-ir",
    version: 1,
    composition: { width: 1080, height: 1920, frameRate: { numerator: 30, denominator: 1 }, background: "#000000" },
    durationFrames: 300,
    assets: [{ id: "source-video", kind: "video", reference: source }],
    tracks: [{ id: "video-track", kind: "video", order: 0, visible: true, muted: false }],
    clips: [
        {
            id: "source-clip",
            trackId: "video-track",
            kind: "video",
            assetId: "source-video",
            startFrame: 0,
            durationFrames: 300,
            sourceStartFrame: 0,
            volume: 1,
            fadeInFrames: 0,
            fadeOutFrames: 0,
            fit: "contain",
            transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
            keyframes: [],
        },
    ],
};

const prepared: AnalysisResult = {
    pluginId: "framescript-video-engine",
    status: "completed",
    sourceFingerprint: "a".repeat(64),
    durationMs: 10_000,
    segments: [{ startMs: 0, endMs: 1_000, description: "开场", assets: [source] }],
    keyframes: [
        { timeMs: 0, score: 0.8, reasons: ["opening"], hardTrigger: true },
        { timeMs: 4_000, score: 0.7, reasons: ["person-movement"], hardTrigger: false },
    ],
};

describe("video plugin contracts", () => {
    test("keeps the full engine-neutral Video IR and sends only confirmed frames", () => {
        const draft = createVideoReviewDraft(source, prepared);
        const review = confirmVideoReview(draft, ["frame-0"]);
        const input: VideoInput = {
            media: source,
            videoIR,
            operations: ["prompt-extraction"],
            review,
        };

        expect(input.videoIR?.clips[0]?.assetId).toBe("source-video");
        expect(input.review?.frames).toHaveLength(1);
        expect(() => assertVideoReview(draft, review)).not.toThrow();
        expect(() => assertVideoReview(draft, { ...review, revision: 2 })).toThrow();
    });

    test("supports analyzer and renderer facets without assigning separate plugin types", async () => {
        const analyzer: VideoAnalyzerPlugin = {
            id: "analyzer",
            name: "Analyzer",
            type: "video",
            capabilities: ["video-analysis"],
            getAvailability: () => ({ available: true }),
            analyze: async () => prepared,
        };
        const renderer: VideoRendererPlugin = {
            id: "renderer",
            name: "Renderer",
            type: "video",
            capabilities: ["compile", "render"],
            getAvailability: () => ({ available: true }),
            compile: async () => ({ engineId: "renderer", format: "test", version: 1, content: {} }),
            render: async () => ({ status: "queued", jobId: "job-1", simulated: true }),
        };

        expect((await analyzer.analyze({ media: source, operations: ["video-analysis"] })).pluginId).toBe("framescript-video-engine");
        expect((await renderer.render(await renderer.compile(videoIR))).status).toBe("queued");
    });
});
