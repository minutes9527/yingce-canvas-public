import { describe, expect, spyOn, test } from "bun:test";
import { frameScriptVideoEnginePlugin } from "@/lib/plugins/builtin/framescript-video-engine";
import "@/lib/plugins/builtin/mock-video-renderer";
import { getRegisteredPlugin } from "@/lib/plugins/plugin-registry";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { FRAMESCRIPT_VIDEO_REVIEW_NODE_TYPE } from "@/lib/framescript-video-review/contracts";
import type { PluginHostContext } from "@/lib/plugins/plugin-types";
import { http } from "@/services/api/request";
import { VideoPipeline } from "@/services/video-pipeline";

const storage = { get: async () => null, set: async () => {}, remove: async () => {} };

describe("video plugin execution boundaries", () => {
    test("registers both the real FrameScript plugin and the Mock Renderer", () => {
        const framescript = getRegisteredPlugin("framescript-video-engine");
        expect(framescript?.manifest.contributes.videoPlugins?.[0].type).toBe("video");
        expect(framescript?.manifest.contributes.canvasNodes?.[0]).toMatchObject({
            id: FRAMESCRIPT_VIDEO_REVIEW_NODE_TYPE,
            acceptsInputKind: "video",
            resourceKind: "text",
        });
        expect(framescript?.manifest.configuration?.fields).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: "channelId", type: "select", required: true }),
            expect.objectContaining({ name: "visionModel", type: "select" }),
            expect.objectContaining({ name: "promptModel", type: "select" }),
            expect.objectContaining({ name: "transcriptionModel", type: "select" }),
        ]));
        expect(getNodeDefinition(FRAMESCRIPT_VIDEO_REVIEW_NODE_TYPE)?.plugin?.pluginId).toBe("framescript-video-engine");
        expect(getRegisteredPlugin("mock-video-renderer")?.manifest.contributes.videoPlugins?.[0].capabilities).toEqual(["compile", "render"]);
    });

    test("does not resolve or submit media for unconfirmed visual analysis", async () => {
        const context: PluginHostContext = {
            manifest: frameScriptVideoEnginePlugin.manifest,
            permissions: new Set(["media.read"]), storage, config: {},
            services: { media: { resolve: async () => { throw new Error("must not resolve before confirmation"); } } },
        };
        const plugin = frameScriptVideoEnginePlugin.createVideoPlugin!(context, "framescript-video-engine");
        await expect(plugin.analyze!({ media: { kind: "resource", id: "video-1" }, operations: ["video-analysis"] })).rejects.toThrow("请先人工筛选并确认候选帧");
    });

    test("rejects a forged confirmation before resolving media", async () => {
        const context: PluginHostContext = {
            manifest: frameScriptVideoEnginePlugin.manifest,
            permissions: new Set(["media.read"]), storage, config: {},
            services: { media: { resolve: async () => { throw new Error("must not resolve an invalid confirmation"); } } },
        };
        const plugin = frameScriptVideoEnginePlugin.createVideoPlugin!(context, "framescript-video-engine");
        await expect(plugin.analyze!({
            media: { kind: "resource", id: "video-1" },
            operations: ["video-analysis"],
            review: {
                state: "confirmed",
                source: { kind: "resource", id: "video-1" },
                sourceFingerprint: "not-a-fingerprint",
                revision: 1,
                frames: [{ id: "forged", timeMs: 0, score: 0, reasons: [], hardTrigger: false }],
            },
        })).rejects.toThrow("人工确认快照无效");
    });

    test("rejects a structurally valid confirmation without its current candidate draft", async () => {
        const context: PluginHostContext = {
            manifest: frameScriptVideoEnginePlugin.manifest,
            permissions: new Set(["media.read"]), storage, config: {},
            services: { media: { resolve: async () => { throw new Error("must not resolve without candidate draft"); } } },
        };
        const plugin = frameScriptVideoEnginePlugin.createVideoPlugin!(context, "framescript-video-engine");
        await expect(plugin.analyze!({
            media: { kind: "resource", id: "video-1" },
            operations: ["video-analysis"],
            review: {
                state: "confirmed",
                source: { kind: "resource", id: "video-1" },
                sourceFingerprint: "a".repeat(64),
                revision: 1,
                frames: [{ id: "frame-0", timeMs: 0, score: 0, reasons: ["opening"], hardTrigger: true }],
            },
        })).rejects.toThrow("缺少候选帧草稿");
    });

    test("starts transcription only after server candidate extraction completes", async () => {
        let resolveScan!: (value: { sourceFingerprint: string; durationMs: number; keyframes: Array<{ timeMs: number; score: number; reasons: ["opening"]; hardTrigger: boolean }>; detectors: string[] }) => void;
        const scan = new Promise<Parameters<typeof resolveScan>[0]>((resolve) => { resolveScan = resolve; });
        const post = spyOn(http, "post").mockImplementation(() => scan as never);
        const audio = spyOn(http, "raw").mockResolvedValue({ data: new Blob(["mp3"], { type: "audio/mpeg" }), headers: { "x-framescript-source-fingerprint": "a".repeat(64) } } as never);
        let transcribeStarted = false;
        try {
            const context: PluginHostContext = {
                manifest: frameScriptVideoEnginePlugin.manifest,
                permissions: new Set(["media.read", "ai.audio"]), storage, config: {},
                services: {
                    media: { resolve: async () => ({ kind: "video", blob: new Blob(["video"]), fileName: "source.mp4", mimeType: "video/mp4", durationMs: 1_000 }) },
                    ai: { audio: { transcribe: async () => { transcribeStarted = true; return { text: "已转写" }; } } },
                },
            };
            const plugin = frameScriptVideoEnginePlugin.createVideoPlugin!(context, "framescript-video-engine");
            const result = plugin.analyze!({ media: { kind: "resource", id: "video-1" }, operations: ["adaptive-keyframe-extraction", "transcription"] });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(transcribeStarted).toBe(false);
            expect(audio).not.toHaveBeenCalled();
            resolveScan({ sourceFingerprint: "a".repeat(64), durationMs: 1_000, keyframes: [{ timeMs: 0, score: 1, reasons: ["opening"], hardTrigger: true }], detectors: ["ffmpeg-sequential-decode-v1"] });
            await expect(result).resolves.toMatchObject({ transcript: { text: "已转写" }, keyframes: [{ timeMs: 0 }] });
            expect(audio).toHaveBeenCalledTimes(1);
            expect(transcribeStarted).toBe(true);
        } finally {
            post.mockRestore();
            audio.mockRestore();
        }
    });

    test("does not start audio extraction after server candidate extraction fails", async () => {
        const post = spyOn(http, "post").mockRejectedValue(new Error("服务端抽帧失败"));
        const audio = spyOn(http, "raw").mockRejectedValue(new Error("不应提取音轨"));
        let mediaResolved = false;
        try {
            const context: PluginHostContext = {
                manifest: frameScriptVideoEnginePlugin.manifest,
                permissions: new Set(["media.read", "ai.audio"]), storage, config: {},
                services: {
                    media: { resolve: async () => { mediaResolved = true; throw new Error("不应读取原视频"); } },
                    ai: { audio: { transcribe: async () => ({ text: "不应开始" }) } },
                },
            };
            const plugin = frameScriptVideoEnginePlugin.createVideoPlugin!(context, "framescript-video-engine");
            await expect(plugin.analyze!({ media: { kind: "resource", id: "video-1" }, operations: ["adaptive-keyframe-extraction", "transcription"] })).rejects.toThrow("服务端抽帧失败");
            expect(audio).not.toHaveBeenCalled();
            expect(mediaResolved).toBe(false);
        } finally {
            post.mockRestore();
            audio.mockRestore();
        }
    });

    test("queues a simulated renderer job through the existing registry", async () => {
        const pipeline = new VideoPipeline((plugin) => ({
            enabled: true,
            context: { manifest: plugin.manifest, permissions: new Set(plugin.manifest.permissions), storage, config: {}, services: {} },
        }));
        const project = await pipeline.compile({ pluginId: "mock-video-renderer", contributionId: "mock-video-renderer" }, {
            schema: "yingce.video-ir", version: 1,
            composition: { width: 720, height: 1280, frameRate: { numerator: 30, denominator: 1 }, background: "#000" }, durationFrames: 1, tracks: [], assets: [], clips: [],
        });
        const result = await pipeline.render({ pluginId: "mock-video-renderer", contributionId: "mock-video-renderer" }, project);
        expect(result).toMatchObject({ status: "queued", simulated: true });
    });
});
