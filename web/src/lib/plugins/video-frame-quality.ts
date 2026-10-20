import type { VideoAnalysisKeyframe } from "./video-plugin";

export type VideoFrameQualitySample = {
    timeMs: number;
    pixels: Uint8ClampedArray;
    width: number;
    height: number;
};

/** Keep each dimension large enough for the three-by-three Laplacian window. */
export function getFrameQualitySampleDimensions(sourceWidth: number, sourceHeight: number, maxEdge = 192) {
    if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0 || !Number.isFinite(maxEdge) || maxEdge < 3) {
        throw new Error("清晰度采样尺寸无效");
    }
    const scale = maxEdge / Math.max(sourceWidth, sourceHeight);
    return {
        width: Math.max(3, Math.round(sourceWidth * scale)),
        height: Math.max(3, Math.round(sourceHeight * scale)),
    };
}

/** Same-size, same-video heuristic; it is not calibrated perceptual quality or detection confidence. */
export function measureFrameQuality(sample: VideoFrameQualitySample) {
    const { pixels, width, height } = sample;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3 || pixels.length !== width * height * 4) throw new Error("清晰度采样尺寸无效");
    const gray = new Float64Array(width * height);
    let clipped = 0;
    for (let index = 0; index < gray.length; index++) {
        gray[index] = (pixels[index * 4] * 0.299 + pixels[index * 4 + 1] * 0.587 + pixels[index * 4 + 2] * 0.114) / 255;
        if (gray[index] <= 0.02 || gray[index] >= 0.98) clipped++;
    }
    let sum = 0;
    let squares = 0;
    const count = (width - 2) * (height - 2);
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
        const index = y * width + x;
        const edge = gray[index - 1] + gray[index + 1] + gray[index - width] + gray[index + width] - 4 * gray[index];
        sum += edge;
        squares += edge * edge;
    }
    const variance = Math.max(0, squares / count - (sum / count) ** 2);
    return (variance / (variance + 0.02)) * (1 - clipped / gray.length);
}

function sampleDifference(left: Uint8ClampedArray, right: Uint8ClampedArray) {
    if (!left.length || left.length !== right.length || left.length % 4) throw new Error("采样画面尺寸不一致");
    let sum = 0;
    for (let index = 0; index < left.length; index += 4) {
        sum += Math.abs(left[index] - right[index]) + Math.abs(left[index + 1] - right[index + 1]) + Math.abs(left[index + 2] - right[index + 2]);
    }
    return sum / (left.length / 4 * 3 * 255);
}

/** Preserve event timing, never cross neighboring candidates, and never relocate hard events. */
export async function refineRepresentativeFrames(
    keyframes: readonly VideoAnalysisKeyframe[],
    durationMs: number,
    sample: (timeMs: number) => Promise<VideoFrameQualitySample>,
    signal?: AbortSignal,
): Promise<VideoAnalysisKeyframe[]> {
    signal?.throwIfAborted();
    if (!Number.isFinite(durationMs) || durationMs < 1 || keyframes.some((frame, index) => !Number.isInteger(frame.timeMs) || frame.timeMs < 0 || frame.timeMs >= durationMs || (index > 0 && frame.timeMs <= keyframes[index - 1].timeMs))) throw new Error("候选帧时间顺序无效");
    const results: VideoAnalysisKeyframe[] = [];
    for (let index = 0; index < keyframes.length; index++) {
        const frame = keyframes[index];
        const read = async (timeMs: number) => {
            signal?.throwIfAborted();
            const value = await sample(timeMs);
            signal?.throwIfAborted();
            if (value.timeMs !== timeMs) throw new Error("清晰度采样时间不一致");
            return value;
        };
        const anchor = await read(frame.timeMs);
        const originalQuality = measureFrameQuality(anchor);
        let bestTime = frame.timeMs;
        let bestQuality = originalQuality;
        if (!frame.hardTrigger && !frame.reasons.some((reason) => ["manual", "opening", "closing", "scene-cut"].includes(reason))) {
            const left = index > 0 ? Math.floor((keyframes[index - 1].timeMs + frame.timeMs) / 2) + 1 : 0;
            const right = index + 1 < keyframes.length ? Math.ceil((keyframes[index + 1].timeMs + frame.timeMs) / 2) - 1 : Math.floor(durationMs) - 1;
            const times = Array.from(new Set([-120, -60, 60, 120].map((delta) => Math.max(left, Math.min(right, frame.timeMs + delta)))));
            for (const timeMs of times) {
                if (timeMs === frame.timeMs) continue;
                const candidate = await read(timeMs);
                if (candidate.width !== anchor.width || candidate.height !== anchor.height) throw new Error("清晰度采样尺寸不一致");
                if (sampleDifference(anchor.pixels, candidate.pixels) > 0.08) continue;
                const quality = measureFrameQuality(candidate);
                if (quality > originalQuality + 0.03 && quality > bestQuality) {
                    bestTime = timeMs;
                    bestQuality = quality;
                }
            }
        }
        results.push({ ...frame, timeMs: bestTime, eventTimeMs: frame.eventTimeMs ?? frame.timeMs,
            quality: bestQuality, qualityMethod: "local-laplacian-exposure-v1", qualityAdjusted: bestTime !== frame.timeMs });
    }
    return results;
}
