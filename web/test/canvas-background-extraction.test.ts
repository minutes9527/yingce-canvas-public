import { describe, expect, test } from "bun:test";

import { backgroundContextForFrame, buildBackgroundExtractionPrompt } from "@/lib/canvas/canvas-background-extraction";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

describe("background extraction", () => {
    test("uses the analysis of the shot containing the selected source frame", () => {
        const shot = {
            id: "shot", type: CanvasNodeType.Image, title: "镜头", position: { x: 0, y: 0 }, width: 100, height: 100,
            metadata: { frameScriptStoryboard: { schemaVersion: 1, sourceNodeId: "video", frames: [{ id: "frame", index: 1, timeMs: 0, durationSeconds: 6, imageNodeId: "frame-image", originalAnalysis: { description: "原帧中的黑色 SUV、住宅楼和街道", imageGenerationPrompt: "一位女士站在车旁", videoMotionPrompt: "", dialogue: "", sourceVideoId: "video", sourceFingerprint: "x", reviewRevision: 1, startMs: 0, endMs: 1000 } }] } },
        } as CanvasNodeData;
        expect(backgroundContextForFrame("frame-image", [shot], [])).toBe("原帧中的黑色 SUV、住宅楼和街道");
        expect(backgroundContextForFrame("other-image", [shot], [])).toBe("");
    });

    test("asks for one opaque background while treating boxes as removal hints and preserving visible scene", () => {
        const prompt = buildBackgroundExtractionPrompt("移除人物", [[100, 200, 700, 900]], "车后方是住宅楼");
        expect(prompt).toContain("移除人物");
        expect(prompt).toContain("<bbox>100 200 700 900</bbox>");
        expect(prompt).toContain("区域内的汽车、道路等背景物体仍须保留或补全");
        expect(prompt).toContain("车后方是住宅楼");
        expect(prompt).toContain("完整、不透明");
        expect(prompt).toContain("以原帧为准");
    });
});
