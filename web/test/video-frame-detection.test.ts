import { describe, expect, test } from "bun:test";

import { analyzeVideoFramePair, resolveTemporalVideoFrameSignals, scoreVideoFrameSample, selectVideoFrameCandidates } from "@/lib/plugins/video-frame-detection";

describe("video frame detection scoring", () => {
    test("combines adjacent and retained changes into an explainable score", () => {
        const frame = scoreVideoFrameSample({ timeMs: 1200, adjacentDifference: 0.8, retainedDifference: 0.4 }, { threshold: 0.7 });

        expect(frame.score).toBe(0.75);
        expect(frame.scoreBreakdown).toEqual({ adjacentDifference: 0.8, retainedDifference: 0.4, visualChange: 0.8, corroboration: 0.6, composite: 0.75 });
        expect(frame.confidence).toBe(0.8);
        expect(frame.reasons).toEqual(["visual-change"]);
        expect(frame.hardTrigger).toBe(false);
    });

    test("keeps hard boundary events even when visual change is zero", () => {
        const frame = scoreVideoFrameSample({ timeMs: 0, adjacentDifference: 0, retainedDifference: 0, hardReasons: ["opening"] }, { threshold: 0.99 });

        expect(frame.reasons).toEqual(["opening"]);
        expect(frame.hardTrigger).toBe(true);
        expect(selectVideoFrameCandidates([
            { timeMs: 0, adjacentDifference: 0, retainedDifference: 0, hardReasons: ["opening"] },
            { timeMs: 500, adjacentDifference: 0.2, retainedDifference: 0.1 },
            { timeMs: 1000, adjacentDifference: 0.9, retainedDifference: 0.7 },
        ], { threshold: 0.7 }).map((item) => item.timeMs)).toEqual([0, 1000]);
    });

    test("retains every qualifying event instead of imposing a fixed frame count", () => {
        const candidates = selectVideoFrameCandidates([
            { timeMs: 0, adjacentDifference: 0, retainedDifference: 0, hardReasons: ["opening"] },
            { timeMs: 400, adjacentDifference: 0.9, retainedDifference: 0.8 },
            { timeMs: 800, adjacentDifference: 0.85, retainedDifference: 0.75 },
            { timeMs: 1200, adjacentDifference: 0.92, retainedDifference: 0.88 },
            { timeMs: 1600, adjacentDifference: 0, retainedDifference: 0, hardReasons: ["closing"] },
        ], { threshold: 0.7 });

        expect(candidates).toHaveLength(5);
        expect(candidates.map((item) => item.reasons)).toEqual([
            ["opening"],
            ["visual-change"],
            ["visual-change"],
            ["visual-change"],
            ["closing"],
        ]);
    });

    test("resolves a hard cut from adjacent temporal samples and suppresses a one-frame flash", () => {
        const cut = resolveTemporalVideoFrameSignals([
            { timeMs: 0, adjacentDifference: 0, retainedDifference: 0 },
            { timeMs: 400, adjacentDifference: 0.8, retainedDifference: 0.8, twoStepDifference: 0.8 },
            { timeMs: 800, adjacentDifference: 0.02, retainedDifference: 0.8, twoStepDifference: 0.8 },
        ], { threshold: 0.32 });
        expect(cut[1].sceneCut).toBe(1);
        expect(scoreVideoFrameSample(cut[1], { threshold: 0.32 }).reasons).toContain("scene-cut");

        const flash = resolveTemporalVideoFrameSignals([
            { timeMs: 0, adjacentDifference: 0, retainedDifference: 0 },
            { timeMs: 400, adjacentDifference: 1, retainedDifference: 1 },
            { timeMs: 800, adjacentDifference: 1, retainedDifference: 0, twoStepDifference: 0 },
            { timeMs: 1200, adjacentDifference: 0.01, retainedDifference: 0 },
        ], { threshold: 0.32 });
        expect(flash[1].sceneCut).toBeUndefined();
        expect(flash[2].sceneCut).toBeUndefined();
    });

    test("accumulates gradual changes into one transition and reports corrected motion direction", () => {
        const transition = resolveTemporalVideoFrameSignals([
            { timeMs: 0, adjacentDifference: 0, retainedDifference: 0 },
            { timeMs: 400, adjacentDifference: 0.1, retainedDifference: 0.1 },
            { timeMs: 800, adjacentDifference: 0.1, retainedDifference: 0.2 },
            { timeMs: 1200, adjacentDifference: 0.1, retainedDifference: 0.3 },
        ], { threshold: 0.32 });
        expect(transition[3].transition).toBeGreaterThan(0.9);
        expect(scoreVideoFrameSample(transition[3], { threshold: 0.32 }).reasons).toContain("scene-change");

        const width = 64; const height = 48;
        const frame = (shift: number) => {
            const pixels = new Uint8ClampedArray(width * height * 4);
            for (let y = 4; y < 44; y += 1) for (let x = 12 + shift; x < 32 + shift; x += 1) {
                const index = (y * width + x) * 4;
                pixels[index] = pixels[index + 1] = pixels[index + 2] = 255; pixels[index + 3] = 255;
            }
            return { pixels, width, height };
        };
        const motion = analyzeVideoFramePair(frame(0), frame(2));
        expect(motion.motionDirection).toBe("right");
        const motionEvent = resolveTemporalVideoFrameSignals([
            { timeMs: 0, adjacentDifference: 0, retainedDifference: 0 },
            { timeMs: 400, retainedDifference: motion.adjacentDifference, ...motion },
        ], { threshold: 0.32 });
        const scored = scoreVideoFrameSample(motionEvent[1], { threshold: 0.32 });
        expect(scored.reasons).toContain("motion-change");
        expect(scored.reasons).not.toContain("camera-movement");
    });
});
