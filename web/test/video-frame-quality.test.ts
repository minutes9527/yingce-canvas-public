import { describe, expect, test } from "bun:test";
import { getFrameQualitySampleDimensions, measureFrameQuality, refineRepresentativeFrames, type VideoFrameQualitySample } from "@/lib/plugins/video-frame-quality";
import type { VideoAnalysisKeyframe } from "@/lib/plugins/video-plugin";

function sample(timeMs: number, contrast = 0, level = 128): VideoFrameQualitySample {
    const pixels = new Uint8ClampedArray(8 * 8 * 4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const index = (y * 8 + x) * 4;
        const value = level + ((x + y) % 2 === 0 ? contrast : -contrast);
        pixels.set([value, value, value, 255], index);
    }
    return { timeMs, pixels, width: 8, height: 8 };
}

const candidate = (timeMs: number, extra: Partial<VideoAnalysisKeyframe> = {}): VideoAnalysisKeyframe => ({ timeMs, score: 0.5, reasons: ["visual-change"], hardTrigger: false, ...extra });

describe("local representative frame quality", () => {
    test("scores sharp frames above flat or clipped frames", () => {
        expect(measureFrameQuality(sample(0, 8))).toBeGreaterThan(measureFrameQuality(sample(0)));
        expect(measureFrameQuality(sample(0, 0, 0))).toBe(0);
        expect(measureFrameQuality(sample(0, 0, 255))).toBe(0);
    });

    test("keeps the Laplacian sample valid for extreme video aspect ratios", () => {
        expect(getFrameQualitySampleDimensions(3840, 40)).toEqual({ width: 192, height: 3 });
        expect(getFrameQualitySampleDimensions(40, 3840)).toEqual({ width: 3, height: 192 });
        expect(() => getFrameQualitySampleDimensions(0, 1080)).toThrow("清晰度采样尺寸无效");
    });

    test("moves only an ordinary candidate to a sharper nearby frame and preserves provenance", async () => {
        const original = candidate(1000);
        const result = await refineRepresentativeFrames([original], 2000, async (timeMs) => sample(timeMs, timeMs === 1060 ? 8 : 0));
        expect(result[0]).toMatchObject({ timeMs: 1060, eventTimeMs: 1000, qualityAdjusted: true, qualityMethod: "local-laplacian-exposure-v1" });
        expect(original.timeMs).toBe(1000);
    });

    test("does not move hard events or visually different candidates", async () => {
        const hard = candidate(1000, { hardTrigger: true });
        const hardCalls: number[] = [];
        const hardResult = await refineRepresentativeFrames([hard], 2000, async (timeMs) => { hardCalls.push(timeMs); return sample(timeMs, 8); });
        expect(hardCalls).toEqual([1000]);
        expect(hardResult[0].timeMs).toBe(1000);

        const different = await refineRepresentativeFrames([candidate(1000)], 2000, async (timeMs) => timeMs === 1000 ? sample(timeMs) : sample(timeMs, 50));
        expect(different[0].timeMs).toBe(1000);
    });
});
