import type { VideoAnalysisKeyframe, VideoSemanticSignal, VideoSemanticSignalKind } from "./video-plugin";
import type { VideoResourceRef } from "@/lib/video-engine/video-ir";

/** Input passed to an optional semantic detector. Binary media stays host-owned. */
export type VideoSemanticDetectorInput = {
    media: VideoResourceRef;
    durationMs: number;
    keyframes: readonly VideoAnalysisKeyframe[];
};

export type VideoSemanticDetectionEvent = {
    timeMs: number;
    signals: readonly VideoSemanticSignal[];
};

/**
 * A detector is deliberately narrower than a video plugin. It only contributes
 * explainable semantic evidence and cannot bypass the review workflow.
 */
export type VideoSemanticDetector = {
    id: string;
    capabilities: readonly VideoSemanticSignalKind[];
    detect(input: VideoSemanticDetectorInput, options?: { signal?: AbortSignal }): Promise<readonly VideoSemanticDetectionEvent[]>;
};

export type VideoSemanticDetectionResult = {
    events: readonly VideoSemanticDetectionEvent[];
    detectors: readonly string[];
};

/**
 * Parses the optional structured field returned by a newer FrameScript
 * Assistant. The adapter is intentionally strict: free-form model prose is
 * never promoted to a semantic detector result.
 */
export function parseFrameScriptSemanticSignals(value: unknown, frameCount: number) {
    const signalsByFrame: VideoSemanticSignal[][] = Array.from({ length: Math.max(0, frameCount) }, () => []);
    const detectors = new Set<string>();
    if (!Array.isArray(value)) return { signalsByFrame, detectors: [] as string[] };
    for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const frameIndex = typeof record.frame_index === "number" && Number.isInteger(record.frame_index) ? record.frame_index : -1;
        if (frameIndex < 0 || frameIndex >= signalsByFrame.length || !Array.isArray(record.signals)) continue;
        for (const raw of record.signals) {
            if (!raw || typeof raw !== "object") continue;
            const signal = raw as Record<string, unknown>;
            const kind = signal.kind;
            const detector = signal.detector;
            const reason = signal.reason;
            const score = signal.score;
            if (!isSemanticKind(kind) || !isSemanticReason(reason) || typeof detector !== "string" || !detector.trim() || typeof score !== "number" || !Number.isFinite(score)) continue;
            const normalized: VideoSemanticSignal = {
                kind,
                reason,
                detector: detector.trim(),
                score: Math.max(0, Math.min(1, score)),
                ...(typeof signal.evidence === "string" && signal.evidence.trim() ? { evidence: signal.evidence.trim() } : {}),
            };
            signalsByFrame[frameIndex].push(normalized);
            detectors.add(normalized.detector);
        }
    }
    return { signalsByFrame, detectors: [...detectors] };
}

/** Runs only explicitly supplied detectors; an empty list is a supported no-op. */
export async function runVideoSemanticDetectors(
    detectors: readonly VideoSemanticDetector[],
    input: VideoSemanticDetectorInput,
    options?: { signal?: AbortSignal },
): Promise<VideoSemanticDetectionResult> {
    const results = await Promise.all(detectors.map(async (detector) => {
        options?.signal?.throwIfAborted();
        const events = await detector.detect(input, options);
        options?.signal?.throwIfAborted();
        return { detector, events: normalizeEvents(events, detector) };
    }));
    return {
        events: results.flatMap((result) => result.events).sort((left, right) => left.timeMs - right.timeMs),
        detectors: results.map((result) => result.detector.id),
    };
}

/**
 * Associates detector events with the nearest sampled frame. Events outside
 * the tolerance are ignored instead of being silently attached to a wrong
 * shot. The caller can then feed the returned samples into the existing
 * composite scorer.
 */
export function attachVideoSemanticSignals(
    samples: readonly import("./video-frame-detection").VideoFrameSample[],
    events: readonly VideoSemanticDetectionEvent[],
    options?: { maxDistanceMs?: number },
) {
    const maxDistanceMs = Math.max(0, options?.maxDistanceMs ?? 450);
    const attached = samples.map((sample) => ({ ...sample, semanticSignals: sample.semanticSignals ? [...sample.semanticSignals] : undefined }));
    for (const event of events) {
        if (!Number.isFinite(event.timeMs) || !Array.isArray(event.signals) || !event.signals.length) continue;
        let nearest = -1;
        let distance = Number.POSITIVE_INFINITY;
        attached.forEach((sample, index) => {
            const candidateDistance = Math.abs(sample.timeMs - event.timeMs);
            if (candidateDistance < distance) {
                nearest = index;
                distance = candidateDistance;
            }
        });
        if (nearest < 0 || distance > maxDistanceMs) continue;
        const current = attached[nearest].semanticSignals ?? [];
        attached[nearest].semanticSignals = [...current, ...event.signals];
    }
    return attached;
}

function normalizeEvents(events: readonly VideoSemanticDetectionEvent[] | undefined, detector: VideoSemanticDetector) {
    if (!Array.isArray(events)) return [];
    return events
        .filter((event) => event && Number.isFinite(event.timeMs) && Array.isArray(event.signals))
        .map((event) => ({
            timeMs: Math.max(0, Math.round(event.timeMs)),
            signals: event.signals
                .filter((signal: VideoSemanticSignal): signal is VideoSemanticSignal => Boolean(signal) && detector.capabilities.includes(signal.kind) && signal.detector === detector.id)
                .map((signal: VideoSemanticSignal) => ({ ...signal, score: Math.max(0, Math.min(1, signal.score)) })),
        }))
        .filter((event) => event.signals.length > 0);
}

function isSemanticKind(value: unknown): value is VideoSemanticSignalKind {
    return ["subject-entry", "subject-exit", "subject-movement", "product-interaction", "occlusion-change", "pose-change", "scale-change", "camera-movement", "text-change", "expression-change"].includes(value as VideoSemanticSignalKind);
}

function isSemanticReason(value: unknown): value is VideoSemanticSignal["reason"] {
    return ["subject-entered", "subject-reentered", "product-interaction", "occlusion-changed", "person-movement", "pose-change", "camera-movement", "text-change", "expression-change", "person-scale-change", "semantic-change"].includes(value as VideoSemanticSignal["reason"]);
}
