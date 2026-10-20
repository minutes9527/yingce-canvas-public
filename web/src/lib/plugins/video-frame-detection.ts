import type { VideoAnalysisKeyframe, VideoFrameScoreBreakdown, VideoKeyframeReason, VideoSemanticSignal } from "./video-plugin";

/** Signals produced by the currently available browser-side frame scanner. */
export type VideoFrameSample = {
    timeMs: number;
    adjacentDifference: number;
    retainedDifference: number;
    /** Signals are optional so a plugin never claims a detector that did not run. */
    sceneCut?: number;
    transition?: number;
    exposureChange?: number;
    motion?: number;
    motionDirection?: "left" | "right" | "up" | "down" | "static";
    /** Optional semantic evidence from a real detector adapter. */
    semanticSignals?: readonly VideoSemanticSignal[];
    /** Difference from the frame two samples earlier; used only for temporal flash suppression. */
    twoStepDifference?: number;
    width?: number;
    height?: number;
    hardReasons?: readonly VideoKeyframeReason[];
};

export type VideoFrameScoreOptions = {
    threshold: number;
};

export type VideoFrameTemporalOptions = VideoFrameScoreOptions & {
    sceneCutThreshold?: number;
    gradualStepThreshold?: number;
    gradualTransitionThreshold?: number;
};

/**
 * Combines active detector signals without pretending that unavailable
 * detectors ran. The peak change carries most of the score while the mean
 * confirms that the event is not caused by a single noisy comparison.
 */
export function scoreVideoFrameSample(sample: VideoFrameSample, options: VideoFrameScoreOptions): VideoAnalysisKeyframe {
    const adjacentDifference = clamp01(sample.adjacentDifference);
    const retainedDifference = clamp01(sample.retainedDifference);
    const optionalSignals = Object.fromEntries([
        ["sceneCut", sample.sceneCut],
        ["transition", sample.transition],
        ["exposureChange", sample.exposureChange],
        ["motion", sample.motion],
    ].filter(([, value]) => value !== undefined).map(([key, value]) => [key, roundScore(value as number)])) as Partial<VideoFrameScoreBreakdown>;
    const semanticSignals = normalizeSemanticSignals(sample.semanticSignals);
    const semanticScores = semanticSignals.map((signal) => signal.score);
    const semantic = semanticScores.length
        ? Object.fromEntries(semanticSignals.map((signal) => [signal.kind, signal.score]))
        : undefined;
    const structuralSignals = [optionalSignals.sceneCut, optionalSignals.transition, optionalSignals.exposureChange].filter((value): value is number => value !== undefined);
    const signalValues = [adjacentDifference, retainedDifference, ...structuralSignals];
    const visualChange = Math.max(...signalValues);
    const corroboration = signalValues.length > 2
        ? signalValues.reduce((sum, value) => sum + value, 0) / signalValues.length
        : (adjacentDifference + retainedDifference) / 2;
    const motionBoost = optionalSignals.motion ?? 0;
    const semanticBoost = semanticScores.length ? Math.max(...semanticScores) : 0;
    const hasExtendedSignals = Object.keys(optionalSignals).length > 0 || semanticScores.length > 0;
    const composite = roundScore(!hasExtendedSignals
        ? visualChange * 0.75 + corroboration * 0.25
        : visualChange * 0.5 + corroboration * 0.2 + Math.max(...structuralSignals, 0) * 0.1 + motionBoost * 0.05 + semanticBoost * 0.15);
    const hardReasons = uniqueReasons(sample.hardReasons || []);
    const reasons = hardReasons.length ? hardReasons : detectorReasons(sample, composite, options.threshold, semanticSignals);

    return {
        timeMs: sample.timeMs,
        score: composite,
        scoreBreakdown: {
            adjacentDifference: roundScore(adjacentDifference),
            retainedDifference: roundScore(retainedDifference),
            visualChange: roundScore(visualChange),
            corroboration: roundScore(corroboration),
            composite,
            ...optionalSignals,
            ...(semantic ? { semantic } : {}),
        } satisfies VideoFrameScoreBreakdown,
        confidence: roundScore(0.5 + corroboration * 0.5),
        motionDirection: sample.motionDirection,
        reasons,
        hardTrigger: hardReasons.length > 0,
        ...(semanticSignals.length ? { semanticSignals } : {}),
        width: sample.width,
        height: sample.height,
    };
}

function detectorReasons(sample: VideoFrameSample, composite: number, threshold: number, semanticSignals: readonly VideoSemanticSignal[] = []): VideoKeyframeReason[] {
    const reasons: VideoKeyframeReason[] = [];
    if (sample.sceneCut !== undefined && sample.sceneCut >= 0.7) reasons.push("scene-cut");
    if (sample.transition !== undefined && sample.transition >= 0.62) reasons.push("scene-change");
    if (sample.motion !== undefined && sample.motion >= 0.58 && composite >= threshold) reasons.push("motion-change");
    if (sample.exposureChange !== undefined && sample.exposureChange >= 0.55) reasons.push("visual-change");
    for (const signal of semanticSignals) {
        if (signal.score >= 0.55 && (composite >= threshold || signal.score >= 0.8)) reasons.push(signal.reason);
    }
    if (composite >= threshold && !reasons.includes("visual-change")) reasons.push("visual-change");
    return uniqueReasons(reasons);
}

function normalizeSemanticSignals(signals: readonly VideoSemanticSignal[] | undefined): VideoSemanticSignal[] {
    if (!signals?.length) return [];
    return signals
        .filter((signal) => signal && typeof signal.detector === "string" && signal.detector.trim())
        .map((signal) => ({ ...signal, score: roundScore(signal.score) }))
        .filter((signal) => signal.score > 0);
}

export type VideoPixelFrame = { pixels: Uint8ClampedArray; width: number; height: number };

/**
 * Computes detector signals from two down-scaled RGBA frames. The shift search is
 * intentionally small and deterministic: it is a motion cue, not a full tracker.
 */
export function analyzeVideoFramePair(previous: VideoPixelFrame | undefined, current: VideoPixelFrame): Omit<VideoFrameSample, "timeMs" | "retainedDifference" | "hardReasons"> {
    if (!previous || previous.width !== current.width || previous.height !== current.height || previous.pixels.length !== current.pixels.length) {
        return { adjacentDifference: 0 };
    }
    const adjacentDifference = pixelDifference(previous.pixels, current.pixels);
    const previousLuma = meanLuminance(previous.pixels);
    const currentLuma = meanLuminance(current.pixels);
    const exposureChange = roundScore(Math.abs(currentLuma - previousLuma));
    const motion = estimateMotion(previous.pixels, current.pixels, current.width, current.height, adjacentDifference);
    return { adjacentDifference, exposureChange, motion: motion.score, motionDirection: motion.direction, width: current.width, height: current.height };
}

/**
 * Resolves signals which need neighboring samples. A one-frame bright flash
 * therefore cannot be reported as two cuts, while a gradual dissolve can
 * accumulate several small differences into one transition event.
 */
export function resolveTemporalVideoFrameSignals(samples: readonly VideoFrameSample[], options: VideoFrameTemporalOptions): VideoFrameSample[] {
    const sceneCutThreshold = options.sceneCutThreshold ?? 0.5;
    const gradualStepThreshold = options.gradualStepThreshold ?? 0.035;
    const gradualTransitionThreshold = options.gradualTransitionThreshold ?? Math.max(0.25, options.threshold * 0.9);
    const resolved = samples.map((sample) => ({ ...sample, hardReasons: sample.hardReasons ? [...sample.hardReasons] : [] }));

    for (let index = 1; index < resolved.length; index += 1) {
        const sample = resolved[index];
        if (sample.adjacentDifference < sceneCutThreshold || isFlashBoundary(resolved, index, sceneCutThreshold)) continue;
        sample.sceneCut = clamp01(sample.adjacentDifference / sceneCutThreshold);
    }

    let runStart = -1;
    let accumulated = 0;
    for (let index = 1; index < resolved.length; index += 1) {
        const sample = resolved[index];
        const gradualStep = sample.adjacentDifference >= gradualStepThreshold && sample.adjacentDifference < sceneCutThreshold && !isFlashBoundary(resolved, index, sceneCutThreshold);
        if (!gradualStep) {
            runStart = -1;
            accumulated = 0;
            continue;
        }
        if (runStart < 0) runStart = index;
        accumulated += sample.adjacentDifference;
        if (index - runStart + 1 < 3 || accumulated < gradualTransitionThreshold) continue;
        sample.transition = clamp01(accumulated / gradualTransitionThreshold);
        runStart = -1;
        accumulated = 0;
    }
    for (let index = 1; index < resolved.length; index += 1) {
        const previous = resolved[index - 1];
        const current = resolved[index];
        const previousDirection = previous.motionDirection ?? "static";
        const currentDirection = current.motionDirection ?? "static";
        const previousMotion = previous.motion ?? 0;
        const currentMotion = current.motion ?? 0;
        const started = previousDirection === "static" && currentDirection !== "static" && currentMotion >= 0.35;
        const directionChanged = previousDirection !== "static" && currentDirection !== "static" && previousDirection !== currentDirection && currentMotion >= 0.25;
        const speedChanged = currentDirection !== "static" && Math.abs(currentMotion - previousMotion) >= 0.3;
        if ((started || directionChanged || speedChanged) && !current.hardReasons?.includes("motion-change")) {
            current.hardReasons = [...(current.hardReasons ?? []), "motion-change"];
        }
    }
    return resolved;
}

function isFlashBoundary(samples: readonly VideoFrameSample[], index: number, sceneCutThreshold: number) {
    const current = samples[index];
    const previous = samples[index - 1];
    const next = samples[index + 1];
    const recoveryThreshold = 0.16;
    return Boolean(
        (next && next.adjacentDifference >= sceneCutThreshold && next.twoStepDifference !== undefined && next.twoStepDifference <= recoveryThreshold)
        || (previous && previous.adjacentDifference >= sceneCutThreshold && current.twoStepDifference !== undefined && current.twoStepDifference <= recoveryThreshold),
    );
}

function pixelDifference(left: Uint8ClampedArray, right: Uint8ClampedArray) {
    let total = 0;
    for (let index = 0; index < left.length; index += 4) total += Math.abs(left[index] - right[index]) + Math.abs(left[index + 1] - right[index + 1]) + Math.abs(left[index + 2] - right[index + 2]);
    return total / (left.length / 4 * 3 * 255);
}

function meanLuminance(pixels: Uint8ClampedArray) {
    let total = 0;
    for (let index = 0; index < pixels.length; index += 4) total += (pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722) / 255;
    return total / Math.max(1, pixels.length / 4);
}

function estimateMotion(previous: Uint8ClampedArray, current: Uint8ClampedArray, width: number, height: number, baseline: number) {
    if (baseline < 0.03 || width < 8 || height < 8) return { score: 0, direction: "static" as const };
    const shifts = [
        { dx: -2, dy: 0, direction: "right" as const }, { dx: 2, dy: 0, direction: "left" as const },
        { dx: 0, dy: -2, direction: "down" as const }, { dx: 0, dy: 2, direction: "up" as const },
    ];
    let best: { error: number; direction: NonNullable<VideoFrameSample["motionDirection"]> } = { error: Number.POSITIVE_INFINITY, direction: "static" };
    for (const shift of shifts) {
        let total = 0; let count = 0;
        const startX = Math.max(0, shift.dx < 0 ? -shift.dx : 0); const endX = Math.min(width, shift.dx < 0 ? width : width - shift.dx);
        const startY = Math.max(0, shift.dy < 0 ? -shift.dy : 0); const endY = Math.min(height, shift.dy < 0 ? height : height - shift.dy);
        for (let y = startY; y < endY; y += 3) for (let x = startX; x < endX; x += 3) {
            const currentIndex = (y * width + x) * 4; const previousIndex = ((y + shift.dy) * width + x + shift.dx) * 4;
            total += Math.abs(current[currentIndex] - previous[previousIndex]) + Math.abs(current[currentIndex + 1] - previous[previousIndex + 1]) + Math.abs(current[currentIndex + 2] - previous[previousIndex + 2]); count += 3 * 255;
        }
        const error = total / Math.max(1, count);
        if (error < best.error) best = { error, direction: shift.direction };
    }
    const score = clamp01((baseline - best.error) / Math.max(0.08, baseline));
    return { score, direction: score >= 0.18 ? best.direction : "static" as const };
}

/** Selects event-driven candidates. No maximum frame count is imposed. */
export function selectVideoFrameCandidates(samples: readonly VideoFrameSample[], options: VideoFrameScoreOptions): VideoAnalysisKeyframe[] {
    return samples
        .map((sample) => scoreVideoFrameSample(sample, options))
        .filter((frame) => frame.hardTrigger || frame.reasons.length > 0)
        .sort((left, right) => left.timeMs - right.timeMs);
}

function uniqueReasons(reasons: readonly VideoKeyframeReason[]) {
    return [...new Set(reasons)].filter(Boolean);
}

function clamp01(value: number) {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function roundScore(value: number) {
    return Math.round(clamp01(value) * 10_000) / 10_000;
}
