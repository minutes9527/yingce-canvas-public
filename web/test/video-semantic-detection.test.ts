import { describe, expect, test } from "bun:test";

import { attachVideoSemanticSignals, parseFrameScriptSemanticSignals, runVideoSemanticDetectors, type VideoSemanticDetector } from "@/lib/plugins/video-semantic-detection";
import { scoreVideoFrameSample, type VideoFrameSample } from "@/lib/plugins/video-frame-detection";

const media = { kind: "resource" as const, id: "video-1" };

describe("video semantic detector extension", () => {
    test("runs only supplied detectors and normalizes their output", async () => {
        const detector: VideoSemanticDetector = {
            id: "pose-v1",
            capabilities: ["pose-change"],
            async detect() {
                return [{ timeMs: 401.4, signals: [{ kind: "pose-change", score: 1.2, reason: "pose-change", detector: "pose-v1", evidence: "手臂抬起" }] }];
            },
        };
        const result = await runVideoSemanticDetectors([detector], { media, durationMs: 1000, keyframes: [] });
        expect(result.detectors).toEqual(["pose-v1"]);
        expect(result.events[0]).toEqual({ timeMs: 401, signals: [{ kind: "pose-change", score: 1, reason: "pose-change", detector: "pose-v1", evidence: "手臂抬起" }] });
    });

    test("does not attach an event to a distant sampled frame", () => {
        const samples: VideoFrameSample[] = [
            { timeMs: 0, adjacentDifference: 0, retainedDifference: 0 },
            { timeMs: 1000, adjacentDifference: 0, retainedDifference: 0 },
        ];
        const attached = attachVideoSemanticSignals(samples, [{ timeMs: 600, signals: [{ kind: "text-change", score: 0.9, reason: "text-change", detector: "ocr-v1" }] }], { maxDistanceMs: 200 });
        expect(attached.every((sample) => !sample.semanticSignals)).toBe(true);
    });

    test("adds semantic evidence to score and trigger reasons only when present", () => {
        const sample: VideoFrameSample = {
            timeMs: 400,
            adjacentDifference: 0.08,
            retainedDifference: 0.05,
            semanticSignals: [{ kind: "subject-entry", score: 0.9, reason: "subject-entered", detector: "person-v1" }],
        };
        const frame = scoreVideoFrameSample(sample, { threshold: 0.32 });
        expect(frame.scoreBreakdown?.semantic).toEqual({ "subject-entry": 0.9 });
        expect(frame.reasons).toContain("subject-entered");
        expect(frame.semanticSignals?.[0].detector).toBe("person-v1");
    });

    test("accepts only explicit structured FrameScript semantic signals", () => {
        const result = parseFrameScriptSemanticSignals([
            { frame_index: 1, signals: [{ kind: "text-change", score: 0.8, reason: "text-change", detector: "ocr-v1", evidence: "字幕更新" }] },
            { frame_index: 0, signals: [{ kind: "unknown", score: 1, reason: "text-change", detector: "bad" }] },
            { frame_index: 5, signals: [{ kind: "pose-change", score: 1, reason: "pose-change", detector: "pose-v1" }] },
        ], 2);
        expect(result.detectors).toEqual(["ocr-v1"]);
        expect(result.signalsByFrame[0]).toEqual([]);
        expect(result.signalsByFrame[1][0]).toMatchObject({ kind: "text-change", score: 0.8, detector: "ocr-v1" });
    });
});
