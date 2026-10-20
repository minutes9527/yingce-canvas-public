import { describe, expect, spyOn, test } from "bun:test";
import axios from "axios";

import { createPluginHostContext, parseAudioTranscriptionResponse } from "@/services/plugin-host";
import type { PluginInstallation, RegisteredPlugin } from "@/lib/plugins/plugin-types";
import type { AiConfig, ModelChannel } from "@/stores/use-config-store";

describe("FrameScript system-channel transcription", () => {
    test("normalizes standard OpenAI transcription segments to milliseconds", () => {
        expect(parseAudioTranscriptionResponse({
            text: "你好，影策。",
            segments: [{ start: 1.25, end: 2.5, text: "你好，影策。" }],
        })).toEqual({ text: "你好，影策。", segments: [{ startMs: 1250, endMs: 2500, text: "你好，影策。" }] });
    });

    test("rejects a successful HTTP payload without transcript text", () => {
        expect(() => parseAudioTranscriptionResponse({ segments: [] })).toThrow("系统渠道未返回有效的转写文本");
    });

    test("routes an explicit transcription channel through that enabled system channel", async () => {
        const channels: ModelChannel[] = [
            { id: "vision", name: "视觉", baseUrl: "https://vision.example/v1", apiKey: "vision-key", apiFormat: "openai", models: ["vision-model"], scope: "system", enabled: true },
            { id: "asr", name: "转写", baseUrl: "https://asr.example/v1", apiKey: "asr-key", apiFormat: "openai", models: ["asr-model"], scope: "system", enabled: true },
        ];
        const plugin = { manifest: { id: "framescript-video-engine", permissions: ["ai.audio"] } } as unknown as RegisteredPlugin;
        const installation = { manifest: plugin.manifest, enabled: true, config: { channelId: "vision", transcriptionModel: "asr-model" }, installedAt: "", updatedAt: "" } as PluginInstallation;
        const config = { channels } as AiConfig;
        const request = spyOn(axios, "request").mockResolvedValue({ data: { text: "已转写" } } as never);
        try {
            const host = createPluginHostContext(plugin, installation, config);
            const result = await host.services!.ai!.audio!.transcribe({ model: "asr-model", channelId: "asr", file: new Blob(["audio"]), fileName: "clip.mp3" });
            expect(result.text).toBe("已转写");
            expect(request).toHaveBeenCalledTimes(1);
            const options = request.mock.calls[0]![0];
            const headers = options.headers as Record<string, string>;
            const upstreamBaseUrl = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-canvas-upstream-base-url")?.[1];
            expect(upstreamBaseUrl).toBe("https://asr.example/v1");
        } finally {
            request.mockRestore();
        }
    });

    test.each(["qwen3-asr-flash-2026-02-10", "qwen3.5-omni-plus"])("routes %s through chat completions with an audio input", async (model) => {
        const channels: ModelChannel[] = [
            { id: "dashscope", name: "阿里百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "asr-key", apiFormat: "openai", models: [model], scope: "system", enabled: true },
        ];
        const plugin = { manifest: { id: "framescript-video-engine", permissions: ["ai.audio"] } } as unknown as RegisteredPlugin;
        const installation = { manifest: plugin.manifest, enabled: true, config: { channelId: "dashscope", transcriptionModel: model }, installedAt: "", updatedAt: "" } as PluginInstallation;
        const request = spyOn(axios, "request").mockResolvedValue({ data: { choices: [{ message: { content: "你好，影策。" } }] } } as never);
        try {
            const host = createPluginHostContext(plugin, installation, { channels } as AiConfig);
            await expect(host.services!.ai!.audio!.transcribe({ model, file: new Blob(["audio"], { type: "audio/mpeg" }), fileName: "clip.mp3" })).resolves.toEqual({ text: "你好，影策。" });
            const options = request.mock.calls[0]![0];
            expect(options.url).toBe("/api/ai/custom");
            const body = options.data;
            expect(body).toMatchObject({ model, stream: false });
            const content = (body as { messages: Array<{ content: Array<{ type: string; input_audio?: { format?: string } }> }> }).messages[0]!.content;
            const audio = content.find((item) => item.type === "input_audio");
            expect(audio).toBeDefined();
            expect(audio!.input_audio!.format).toBe("mp3");
            if (model === "qwen3.5-omni-plus") expect(content[0]!.type).toBe("text");
            const headers = options.headers as Record<string, string>;
            expect(Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1]).toBe("application/json");
            expect(headers["x-canvas-upstream-url"] || headers["X-Canvas-Upstream-URL"]).toContain("/chat/completions");
        } finally {
            request.mockRestore();
        }
    });
});
