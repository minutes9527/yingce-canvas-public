import { expect, test } from "bun:test";

import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { buildVideoGenerationMetadata } from "../src/lib/canvas/canvas-project-generation";
import { dreaminaVideoModeError, dreaminaVideoModeMaxReferences, dreaminaVideoModeOptions, dreaminaVideoOperation, dreaminaVideoProfileForMode, isLocalDreaminaVideoModel } from "../src/lib/dreamina-video-modes";
import { runLocalDreaminaGenerationTask } from "../src/services/local-dreamina-generation";
import { defaultConfig, type AiConfig, type ModelChannel } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const seedanceModel = "local:dreamina-cli:seedance2.5";

function canvasDreaminaConfig(): AiConfig {
    const channel: ModelChannel = {
        id: "local:dreamina-cli", name: "即梦 CLI", baseUrl: "", apiKey: "", apiFormat: "openai", models: ["seedance2.5"],
        localModels: [{
            provider: "dreamina-cli", id: "seedance2.5", displayName: "seedance2.5", modality: "video", adapterSupported: true,
            accountEntitlement: "yes", currentlyObservedAvailable: "yes", source: "runtime-execution-contract",
            operations: ["text-to-video", "image-to-video", "reference-to-video", "multi-frame-to-video"],
            settings: { aliases: [], aspects: ["16:9"], maxReferenceImages: 30, minDuration: 1, maxDuration: 15, tiers: ["720p"] },
        }],
    };
    return { ...defaultConfig, model: seedanceModel, videoModel: seedanceModel, size: "16:9", channels: [channel] };
}

function canvasVideoNode(dreaminaVideoMode?: "all_reference" | "first_last_frames" | "smart_multi_frame"): CanvasNodeData {
    return { id: "video-1", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { dreaminaVideoMode } };
}

function canvasVideoReferences(imageCount: number, videoCount = 0, audioCount = 0) {
    return {
        referenceImages: Array.from({ length: imageCount }, (_, index) => ({ id: `image-${index}`, name: "参考图", type: "image/png", dataUrl: "data:image/png;base64,AA==" })),
        referenceVideos: Array.from({ length: videoCount }, (_, index) => ({ id: `video-${index}`, name: "参考视频", type: "video/mp4", url: "https://example.com/video.mp4" })),
        referenceAudios: Array.from({ length: audioCount }, (_, index) => ({ id: `audio-${index}`, name: "参考音频", type: "audio/mpeg", url: "https://example.com/audio.mp3" })),
    };
}

test("Create exposes the complete Dreamina video mode menu without faking unsupported CLI operations", async () => {
    expect(dreaminaVideoModeOptions.map((option) => option.label)).toEqual(["全能参考", "首尾帧", "智能多帧", "智能编辑", "超长视频"]);
    expect(dreaminaVideoModeOptions.filter((option) => option.available).map((option) => option.label)).toEqual(["全能参考", "首尾帧", "智能多帧"]);
    expect(dreaminaVideoModeOptions.filter((option) => option.beta).map((option) => option.label)).toEqual(["智能编辑", "超长视频"]);
    expect(isLocalDreaminaVideoModel("local:dreamina-cli:seedance2.5")).toBe(true);
    expect(isLocalDreaminaVideoModel("system::seedance2.5")).toBe(false);

    const page = await Bun.file(new URL("../src/pages/create/index.tsx", import.meta.url)).text();
    const composer = await Bun.file(new URL("../src/pages/create/creation-workspace.tsx", import.meta.url)).text();
    expect(page).toContain("dreaminaVideoModeError(requestedDreaminaMode");
    expect(page).toContain("dreaminaVideoOperation(requestedDreaminaMode");
    expect(page).toContain("rememberVideoSettings({ dreaminaMode: value })");
    expect(composer.indexOf("<DreaminaVideoModePicker")).toBeGreaterThan(composer.indexOf("<ModelPicker"));
    expect(composer).toContain("<FirstLastFrameReferenceSlots");
    expect(composer).toContain('aria-label="首尾帧参考图"');
    expect(composer).toContain('aria-label="交换首帧和尾帧"');
    expect(composer).toContain("disabled={!option.available || !supported}");
    expect(composer).toContain('option.beta ? " · Beta" : ""');
});

test("explicit smart multi-frame selection reaches the existing local CLI request", async () => {
    let operation: unknown;
    const client = {
        connect: async () => ({ state: "connected" }),
        request: async (_path: string, init: RequestInit) => {
            operation = JSON.parse(String(init.body)).operation;
            return new Response(JSON.stringify({ error: "test stop" }), { status: 500, headers: { "content-type": "application/json" } });
        },
    };
    const references = Array.from({ length: 3 }, () => ({ kind: "image" as const, mimeType: "image/png" as const, bytes: new Uint8Array([1]) }));
    await expect(runLocalDreaminaGenerationTask({
        model: "local:dreamina-cli:seedance2.5", mode: "video", operation: "multi-frame-to-video", prompt: "镜头连续变化",
        settings: { duration: 3 }, references, idempotencyKey: "test-dreamina-multiframe-1",
    }, { client: client as never })).rejects.toThrow();
    expect(operation).toBe("multi-frame-to-video");
});

test("Dreamina menu choices map to distinct official CLI operations", () => {
    expect(dreaminaVideoOperation("all_reference", { image: 0, video: 0, audio: 0 })).toBe("text_to_video");
    expect(dreaminaVideoOperation("all_reference", { image: 1, video: 1, audio: 1 })).toBe("reference_to_video");
    expect(dreaminaVideoOperation("first_last_frames", { image: 2, video: 0, audio: 0 })).toBe("image_to_video");
    expect(dreaminaVideoOperation("smart_multi_frame", { image: 3, video: 0, audio: 0 })).toBe("multi_frame_to_video");
});

test("canvas Seedance mode is submitted explicitly instead of inferred from the reference count", () => {
    const config = canvasDreaminaConfig();
    expect(buildVideoGenerationMetadata(canvasVideoNode(), canvasVideoReferences(1), config).videoEditOperation).toBe("reference_to_video");
    expect(buildVideoGenerationMetadata(canvasVideoNode("all_reference"), canvasVideoReferences(0), config).videoEditOperation).toBe("text_to_video");
    expect(buildVideoGenerationMetadata(canvasVideoNode("first_last_frames"), canvasVideoReferences(2), config).videoEditOperation).toBe("image_to_video");
    expect(buildVideoGenerationMetadata(canvasVideoNode("smart_multi_frame"), canvasVideoReferences(3), config).videoEditOperation).toBe("multi_frame_to_video");
    expect(buildVideoGenerationMetadata(canvasVideoNode("smart_multi_frame"), canvasVideoReferences(3), config).dreaminaVideoMode).toBe("smart_multi_frame");
    expect(() => buildVideoGenerationMetadata(canvasVideoNode("first_last_frames"), canvasVideoReferences(1), config)).toThrow("共 2 张");
    expect(() => buildVideoGenerationMetadata(canvasVideoNode("smart_multi_frame"), canvasVideoReferences(2, 1), config)).toThrow("只接受图片");
    expect(() => buildVideoGenerationMetadata(canvasVideoNode("smart_multi_frame"), canvasVideoReferences(3), { ...config, videoSeconds: "15" })).toThrow("智能多帧的时长");
    expect(() => buildVideoGenerationMetadata(canvasVideoNode("smart_multi_frame"), canvasVideoReferences(3), { ...config, size: "1:1" })).toThrow("智能多帧的时长");
    expect(buildVideoGenerationMetadata({ ...canvasVideoNode("smart_multi_frame"), metadata: { videoEditOperation: "multi_frame_to_video", dreaminaVideoMode: "smart_multi_frame" } }, canvasVideoReferences(3), { ...defaultConfig, model: "remote-video" }).videoEditOperation).toBe("reference_to_video");
});

test("Dreamina mode limits match the installed CLI contract", () => {
    const model = "local:dreamina-cli:seedance2.0mini";
    expect(dreaminaVideoModeMaxReferences("first_last_frames", model)).toBe(2);
    expect(dreaminaVideoModeMaxReferences("smart_multi_frame", model)).toBe(20);
    expect(dreaminaVideoModeError("first_last_frames", model, { image: 1, video: 0, audio: 0 })).toContain("共 2 张");
    expect(dreaminaVideoModeError("first_last_frames", model, { image: 2, video: 0, audio: 0 })).toBe("");
    expect(dreaminaVideoModeError("smart_multi_frame", model, { image: 2, video: 0, audio: 0 })).toBe("");
    expect(dreaminaVideoModeError("smart_multi_frame", model, { image: 2, video: 1, audio: 0 })).toContain("只接受图片");

    const twoFrame = dreaminaVideoProfileForMode(defaultModelCapabilityConfig().video!, "smart_multi_frame", { image: 2, video: 0, audio: 0 });
    const threeFrame = dreaminaVideoProfileForMode(defaultModelCapabilityConfig().video!, "smart_multi_frame", { image: 3, video: 0, audio: 0 });
    expect(twoFrame.duration.min).toBe(2);
    expect(threeFrame.duration.min).toBe(1);
    expect(threeFrame.resolutions).toEqual(["720p", "1080p"]);
    expect(threeFrame.ratios).toEqual([]);
});
