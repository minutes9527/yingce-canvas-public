import { createChannelTransport } from "@/services/api/channel-transport";
import { requestToolResponse, type ResponseFunctionTool, type ResponseInputMessage, type ToolChoice } from "@/services/api/image";
import { pluginStorageFor } from "@/lib/plugins/plugin-storage";
import { getMediaBlob } from "@/services/file-storage";
import { getResource, resourceStorageKey } from "@/services/api/resources";
import { loadAssetsForUse } from "@/services/user-data-sync";
import { buildApiUrl, encodeChannelModel, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import type { PluginHostContext, PluginInstallation, PluginMediaReference, PluginTextRequest, RegisteredPlugin, ResolvedPluginMedia } from "@/lib/plugins/plugin-types";

export function createPluginHostContext(plugin: RegisteredPlugin, installation: PluginInstallation, aiConfig: AiConfig): PluginHostContext {
    const permissions = new Set(plugin.manifest.permissions);
    const resolvePluginModelConfig = (model?: string, requestedChannelId?: string) => {
        const channelId = typeof requestedChannelId === "string" && requestedChannelId.trim()
            ? requestedChannelId.trim()
            : typeof installation.config.channelId === "string" ? installation.config.channelId.trim() : "";
        if (!channelId) throw new Error("FrameScript 尚未关联 Canvas 系统渠道，请先在插件设置中选择渠道");
        const channel = aiConfig.channels.find((candidate) => candidate.id === channelId && candidate.enabled !== false);
        if (!channel) throw new Error("所选文字模型渠道不存在、已停用或当前无权使用");
        const requested = typeof model === "string" && model.trim()
            ? modelOptionName(model).trim()
            : modelOptionName(String(installation.config.visionModel || "")).trim();
        if (!requested) {
            throw new Error(`FrameScript 模型不在关联系统渠道中：${requested || "未选择模型"}`);
        }
        // The plugin settings page loads the full admin channel catalog, while
        // the runtime config may still contain an older/publicly filtered
        // model list. Keep the selected system channel as the authority and
        // let the Canvas backend validate the model against its live catalog.
        // Augment only the in-memory runtime copy so we never persist stale
        // catalog data back to user settings.
        const runtimeChannels = channel.models.some((candidate) => modelOptionName(candidate).trim() === requested)
            ? aiConfig.channels
            : aiConfig.channels.map((candidate) => candidate.id === channel.id
                ? { ...candidate, models: [...candidate.models, requested] }
                : candidate);
        const runtimeConfig = runtimeChannels === aiConfig.channels ? aiConfig : { ...aiConfig, channels: runtimeChannels };
        // Keep the channel-qualified model on the config. requestToolResponse
        // resolves the config once more, so a bare model could accidentally
        // match another channel that exposes the same model name.
        return { ...resolveModelRequestConfig(runtimeConfig, encodeChannelModel(channel.id, requested)), channels: runtimeChannels, model: encodeChannelModel(channel.id, requested) };
    };
    return {
        manifest: plugin.manifest,
        permissions,
        storage: pluginStorageFor(plugin.manifest.id),
        config: installation.config,
        services: {
            ai: {
                text: {
                    requestToolResponse: async (request: PluginTextRequest) => {
                        if (!permissions.has("ai.text")) throw new Error("插件没有调用文本模型的权限");
                        const requestConfig = resolvePluginModelConfig(request.model, request.channelId);
                        const response = await requestToolResponse(
                            requestConfig,
                            request.messages as ResponseInputMessage[],
                            (request.tools || []) as ResponseFunctionTool[],
                            (request.toolChoice || "auto") as ToolChoice,
                            request.onDelta,
                            { signal: request.signal },
                        );
                        return {
                            content: response.content,
                            toolCalls: response.toolCalls.map((call) => ({ name: call.function.name, arguments: call.function.arguments })),
                        };
                    },
                },
                audio: {
                    transcribe: async (request) => {
                        if (!permissions.has("ai.audio")) throw new Error("插件没有调用语音转写模型的权限");
                        const requestConfig = resolvePluginModelConfig(request.model || String(installation.config.transcriptionModel || ""), request.channelId);
                        const model = modelOptionName(requestConfig.model);
                        const transport = createChannelTransport(requestConfig, "audio");
                        try {
                            if (isQwenAudioChatModel(model)) {
                                const upstreamUrl = buildApiUrl(requestConfig.baseUrl, "/chat/completions");
                                const audio = { type: "input_audio", input_audio: { data: await blobToDataUrl(request.file), format: audioInputFormat(request.file, request.fileName) } };
                                const response = await transport.postJson<unknown>(upstreamUrl, {
                                    model,
                                    messages: [{
                                        role: "user",
                                        content: isQwenOmniModel(model)
                                            ? [{ type: "text", text: "请逐字转写这段音频，只输出转写文案。" }, audio]
                                            : [audio],
                                    }],
                                    stream: false,
                                }, { signal: request.signal });
                                return parseQwenAsrChatResponse(response);
                            }
                            const form = new FormData();
                            form.append("file", request.file, request.fileName);
                            form.append("model", model);
                            const upstreamUrl = buildApiUrl(requestConfig.baseUrl, "/audio/transcriptions");
                            const response = await transport.postForm<unknown>(upstreamUrl, form, { signal: request.signal });
                            return parseAudioTranscriptionResponse(response);
                        } catch (error) {
                            throw new Error(`系统渠道语音转写失败：${audioTranscriptionError(error)}`);
                        }
                    },
                },
            },
            media: {
                resolve: (reference, signal) => resolvePluginMedia(reference, permissions.has("media.read"), signal),
            },
        },
    };
}

function timeToMs(value: unknown, fallback: number) {
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isFinite(number) ? Math.max(0, Math.round(number < 1000 ? number * 1000 : number)) : fallback;
}

/** Host-owned resolver: the plugin never sees storage keys, asset URLs or account IDs. */
async function resolvePluginMedia(reference: PluginMediaReference, permitted: boolean, signal?: AbortSignal): Promise<ResolvedPluginMedia> {
    if (!permitted) throw new Error("插件没有读取媒体的权限");
    signal?.throwIfAborted();
    if (!reference?.id || !/^[\w-]{1,200}$/.test(reference.id) || !["asset", "resource"].includes(reference.kind)) throw new Error("媒体引用无效");

    if (reference.kind === "resource") {
        const resource = await getResource(reference.id);
        signal?.throwIfAborted();
        const blob = await getMediaBlob(resourceStorageKey(reference.id));
        if (!blob) throw new Error("无法读取媒体文件");
        return {
            blob,
            kind: normalizeKind(resource.kind),
            fileName: mediaFileName(reference.id, resource.mimeType || blob.type),
            mimeType: resource.mimeType || blob.type || "application/octet-stream",
            durationMs: resource.durationMs,
        };
    }

    // This path first refreshes user-scoped assets. It never resolves a raw URL
    // from a caller-supplied reference.
    await loadAssetsForUse([reference.id]);
    signal?.throwIfAborted();
    const asset = useAssetStore.getState().assets.find((candidate) => candidate.id === reference.id);
    if (!asset) throw new Error("媒体素材不存在或无权访问");
    const stored = storedMediaForAsset(asset);
    if (!stored.storageKey) throw new Error("当前素材没有可供插件读取的已保存媒体");
    const blob = await getMediaBlob(stored.storageKey);
    if (!blob) throw new Error("无法读取媒体文件，请重新上传后再试");
    return {
        blob,
        kind: normalizeKind(asset.kind),
        fileName: mediaFileName(asset.title || reference.id, stored.mimeType || blob.type),
        mimeType: stored.mimeType || blob.type || "application/octet-stream",
        durationMs: stored.durationMs,
    };
}

function storedMediaForAsset(asset: Asset) {
    if (asset.kind === "video" || asset.kind === "audio") return { storageKey: asset.data.storageKey, mimeType: asset.data.mimeType, durationMs: asset.data.durationMs };
    if (asset.kind === "model") return { storageKey: asset.data.storageKey, mimeType: asset.data.mimeType, durationMs: undefined };
    if (asset.kind === "image") return { storageKey: asset.data.storageKey, mimeType: asset.data.mimeType, durationMs: undefined };
    return { storageKey: undefined, mimeType: undefined, durationMs: undefined };
}

function normalizeKind(kind: string): ResolvedPluginMedia["kind"] {
    return kind === "image" || kind === "video" || kind === "audio" ? kind : "file";
}

function mediaFileName(value: string, mimeType: string) {
    const safe = value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 120) || "media";
    if (/\.[a-z0-9]{2,5}$/i.test(safe)) return safe;
    const extension = ({ "video/mp4": ".mp4", "video/quicktime": ".mov", "audio/mpeg": ".mp3", "audio/wav": ".wav", "image/png": ".png", "image/jpeg": ".jpg" } as Record<string, string>)[mimeType];
    return `${safe}${extension || ""}`;
}


function isQwenAudioChatModel(model: string) {
    const normalized = model.trim();
    // Qwen ASR and Qwen3.5 Omni both accept input_audio through the
    // OpenAI-compatible chat-completions endpoint. The latter was previously
    // sent to /audio/transcriptions, which DashScope rejects with HTTP 403.
    return /^qwen3-asr-flash(?:-|$)/i.test(normalized) || /^qwen3\.5-omni-(?:plus|flash)(?:-|$)/i.test(normalized);
}

function isQwenOmniModel(model: string) {
    return /^qwen3\.5-omni-(?:plus|flash)(?:-|$)/i.test(model.trim());
}

function audioInputFormat(blob: Blob, fileName: string) {
    const mime = blob.type.toLowerCase().split(";")[0].trim();
    const byMime: Record<string, string> = {
        "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
        "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/ogg": "ogg", "audio/webm": "webm",
    };
    if (byMime[mime]) return byMime[mime];
    const extension = fileName.trim().match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    return extension && ["mp3", "wav", "m4a", "aac", "ogg", "webm"].includes(extension) ? extension : "mp3";
}

async function blobToDataUrl(blob: Blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    return `data:${blob.type || "audio/mpeg"};base64,${btoa(binary)}`;
}

function parseQwenAsrChatResponse(payload: unknown) {
    const data = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const first = choices[0] && typeof choices[0] === "object" && !Array.isArray(choices[0]) ? choices[0] as Record<string, unknown> : {};
    const message = first.message && typeof first.message === "object" && !Array.isArray(first.message) ? first.message as Record<string, unknown> : {};
    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (!content) throw new Error("百炼 Qwen ASR 未返回有效的转写文本");
    return { text: content };
}

export function parseAudioTranscriptionResponse(payload: unknown) {
    const data = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    const text = [data.text, data.transcript, data.content].find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() || "";
    if (!text) throw new Error("系统渠道未返回有效的转写文本");
    const segments = Array.isArray(data.segments)
        ? data.segments.flatMap((value) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return [];
            const item = value as Record<string, unknown>;
            const segmentText = [item.text, item.original_text, item.content].find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)?.trim();
            if (!segmentText) return [];
            const startMs = timeToMs(item.start_ms ?? item.start, 0);
            const endMs = Math.max(startMs, timeToMs(item.end_ms ?? item.end, startMs));
            return [{ startMs, endMs, text: segmentText }];
        })
        : undefined;
    return { text, ...(segments?.length ? { segments } : {}) };
}

function audioTranscriptionError(error: unknown) {
    if (error && typeof error === "object" && "response" in error) {
        const body = (error as { response?: { data?: unknown } }).response?.data;
        if (body && typeof body === "object" && !Array.isArray(body)) {
            const record = body as Record<string, unknown>;
            const nested = record.error && typeof record.error === "object" && !Array.isArray(record.error) ? record.error as Record<string, unknown> : undefined;
            const message = nested?.message ?? record.message ?? record.error;
            if (typeof message === "string" && message.trim()) return message.trim();
        }
    }
    return error instanceof Error && error.message ? error.message : "请求未完成";
}
