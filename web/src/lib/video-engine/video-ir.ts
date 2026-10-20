/** Portable data only. References are resolved and authorized by the execution host. */
export type VideoMediaKind = "image" | "video" | "audio";
export type VideoLayerKind = VideoMediaKind | "text" | "subtitle";
export type VideoResourceRef = { kind: "asset" | "resource"; id: string };
export type VideoComposition = {
    width: number;
    height: number;
    frameRate: { numerator: number; denominator: number };
    background: string;
};
export type VideoTransform = {
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
    rotation: number;
    opacity: number;
};
export type VideoAnimationProperty = keyof VideoTransform;
export type VideoTrack = { id: string; kind: VideoLayerKind; order: number; visible: boolean; muted: boolean };
export type VideoIRClip = {
    id: string;
    trackId: string;
    kind: VideoLayerKind;
    startFrame: number;
    durationFrames: number;
    assetId?: string;
    text?: string;
    sourceStartFrame: number;
    volume: number;
    fadeInFrames: number;
    fadeOutFrames: number;
    fit: "contain";
    transform: VideoTransform;
    keyframes: Array<{ property: VideoAnimationProperty; frame: number; value: number; easing: "linear" | "step" }>;
};

export type VideoIR = {
    schema: "yingce.video-ir";
    version: 1;
    composition: VideoComposition;
    durationFrames: number;
    tracks: VideoTrack[];
    assets: Array<{ id: string; kind: VideoMediaKind; reference: VideoResourceRef }>;
    clips: VideoIRClip[];
};

export class VideoSceneError extends Error {
    constructor(
        public readonly code: "invalid-scene" | "missing-media" | "unsupported-kind" | "subframe-duration" | "keyframe-collision",
        public readonly path: string,
        message: string,
    ) {
        super(`${path}: ${message}`);
        this.name = "VideoSceneError";
    }
}
