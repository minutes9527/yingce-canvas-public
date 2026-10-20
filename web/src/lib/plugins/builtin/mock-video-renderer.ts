import { registerPlugin } from "../plugin-registry";
import type { PluginManifestV2, RegisteredPlugin } from "../plugin-types";
import type { VideoPlugin } from "../video-plugin";

export const MOCK_VIDEO_RENDERER_ID = "mock-video-renderer";

const manifest: PluginManifestV2 = {
    apiVersion: "yingce.plugin/v2" as const,
    id: MOCK_VIDEO_RENDERER_ID,
    name: "Mock Video Renderer",
    version: "0.1.0",
    description: "用于验证 Video IR 到渲染任务合同的测试渲染器，不生成真实视频。",
    permissions: ["media.read", "generation.run"],
    contributes: { videoPlugins: [{ id: MOCK_VIDEO_RENDERER_ID, label: "Mock Video Renderer", type: "video" as const, stage: "ready" as const, capabilities: ["compile", "render"] as const }] },
};

export const mockVideoRendererPlugin: RegisteredPlugin = {
    manifest,
    source: "bundled",
    createVideoPlugin: (_context, contributionId): VideoPlugin => {
        if (contributionId !== MOCK_VIDEO_RENDERER_ID) throw new Error("未声明的 Mock Renderer");
        return {
            id: MOCK_VIDEO_RENDERER_ID,
            name: manifest.name,
            type: "video",
            capabilities: ["compile", "render"],
            getAvailability: () => ({ available: true }),
            compile: async (videoIR) => ({ engineId: MOCK_VIDEO_RENDERER_ID, format: "yingce.mock-render-project", version: 1, content: { schema: videoIR.schema, durationFrames: videoIR.durationFrames, clipCount: videoIR.clips.length } }),
            render: async (project) => ({ status: "queued", jobId: `mock-${crypto.randomUUID()}`, simulated: true }),
        };
    },
};

registerPlugin(mockVideoRendererPlugin);
