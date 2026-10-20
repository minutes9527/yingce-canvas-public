import { expect, test } from "bun:test";
import { jimengFrameModeError, jimengFrameOperation, selectJimengVideoFrames } from "../src/lib/canvas/jimeng-video-frames";
import { buildVideoGenerationMetadata } from "../src/lib/canvas/canvas-project-generation";
import { defaultConfig } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const context = {
    referenceImages: ["extra", "last", "first"].map((id) => ({ id, name: id, type: "image/png", dataUrl: `https://example.com/${id}.png` })),
    referenceImageSlots: ["extra", "last", "first"].map((nodeId) => ({ nodeId, kind: "image" })),
    referenceVideos: [], referenceAudios: [], imageCount: 3, videoCount: 0, audioCount: 0,
};

test("首尾帧按角色排序，并排除其他连线图片", () => {
    const selected = selectJimengVideoFrames({ videoFrameMode: "first-last", videoStartFrameNodeId: "first", videoEndFrameNodeId: "last" }, context);
    expect(selected.referenceImages.map((image) => image.id)).toEqual(["first", "last"]);
    expect(selected.imageCount).toBe(2);
    expect(selected.referenceImageSlots.map((slot) => slot.nodeId)).toEqual(["first", "last"]);
    expect(context.referenceImages).toHaveLength(3);
});

test("漏选、断开连线或重复首尾帧都在提交任务前失败", () => {
    expect(() => selectJimengVideoFrames({ videoFrameMode: "first" }, context)).toThrow("请选择首帧");
    expect(() => selectJimengVideoFrames({ videoFrameMode: "first", videoStartFrameNodeId: "missing" }, context)).toThrow("未连接");
    expect(() => selectJimengVideoFrames({ videoFrameMode: "first-last", videoStartFrameNodeId: "first", videoEndFrameNodeId: "first" }, context)).toThrow("不同的图片");
});

test("文生视频不夹带已连接的参考素材", () => {
    const selected = selectJimengVideoFrames({ videoFrameMode: "text" }, context);
    expect(selected.referenceImages).toEqual([]);
    expect(selected.referenceImageSlots).toEqual([]);
    expect(selected.imageCount).toBe(0);
});

test("新反代节点默认文生视频，历史显式首尾帧继续保持图序", () => {
    expect(selectJimengVideoFrames({ model: "jimeng-video-seedance-2.0-fast-vip" }, context).referenceImages).toEqual([]);
    expect(selectJimengVideoFrames({ model: "jimeng-video-seedance-2.0-fast-vip", videoStartFrameNodeId: "first", videoEndFrameNodeId: "last" }, context).referenceImages.map((image) => image.id)).toEqual(["first", "last"]);
    expect(selectJimengVideoFrames({ model: "local:dreamina-cli:seedance2.0" }, context)).toBe(context);
});

test("全能参考保留图片、视频和音频参考", () => {
    expect(selectJimengVideoFrames({ videoFrameMode: "all-reference" }, context).referenceImages.map((image) => image.id)).toEqual(["extra", "last", "first"]);
    expect(() => selectJimengVideoFrames({ videoFrameMode: "all-reference" }, { ...context, referenceImages: [], imageCount: 0 })).toThrow("至少需要");
    const videoContext = { ...context, referenceImages: [], imageCount: 0, referenceVideos: [{ id: "video", url: "https://example.com/ref.mp4" }], videoCount: 1 };
    expect(selectJimengVideoFrames({ videoFrameMode: "all-reference" }, videoContext).referenceVideos).toHaveLength(1);
});

test("创作主页的视频模式映射到明确操作并在提交前校验素材", () => {
    expect(jimengFrameOperation("text")).toBe("text_to_video");
    expect(jimengFrameOperation("first")).toBe("image_to_video");
    expect(jimengFrameOperation("first-last")).toBe("image_to_video");
    expect(jimengFrameOperation("all-reference")).toBe("reference_to_video");
    expect(jimengFrameModeError("first-last", { image: 1, video: 0, audio: 0 })).toContain("2 张");
    expect(jimengFrameModeError("all-reference", { image: 0, video: 1, audio: 1 })).toBe("");
    expect(jimengFrameModeError("text", { image: 0, video: 1, audio: 0 })).toContain("不使用参考素材");
});

test("系统渠道的一张参考图保留用户选择的全能参考操作", () => {
    const model = "jimeng-video-seedance-2.0-fast-vip";
    const config = {
        ...defaultConfig,
        model: `jimeng::${model}`,
        channels: [{ id: "jimeng", name: "jimeng", baseUrl: "http://jimeng:8000", apiKey: "test", apiFormat: "openai" as const, interfaceType: "newapi-channel-2", models: [model] }],
    };
    const node: CanvasNodeData = {
        id: "video", type: CanvasNodeType.Video, title: "video", position: { x: 0, y: 0 }, width: 320, height: 180,
        metadata: { videoFrameMode: "all-reference", videoEditOperation: "reference_to_video" },
    };
    const oneImage = { referenceImages: [context.referenceImages[0]], referenceVideos: [], referenceAudios: [] };
    expect(buildVideoGenerationMetadata(node, oneImage, config).videoEditOperation).toBe("reference_to_video");
    expect(buildVideoGenerationMetadata({ ...node, metadata: { videoFrameMode: "first" } }, oneImage, config).videoEditOperation).toBe("image_to_video");
});
