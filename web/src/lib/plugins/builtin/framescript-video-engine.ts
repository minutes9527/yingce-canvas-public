import type { PluginAiAudioService, PluginAiTextService, PluginHostContext, PluginManifestV2, RegisteredPlugin, PluginTextContentPart } from "../plugin-types";
import { registerPlugin } from "../plugin-registry";
import { VideoPluginError, type AnalysisResult, type VideoAnalysisKeyframe, type VideoAnalysisWarning, type VideoPlugin, type VideoTranscript } from "../video-plugin";
import { assertVideoReview, validateConfirmedVideoReview } from "../video-review";
import { analyzeVideoFramePair, resolveTemporalVideoFrameSignals, selectVideoFrameCandidates, type VideoFrameSample } from "../video-frame-detection";
import { getFrameQualitySampleDimensions, refineRepresentativeFrames, type VideoFrameQualitySample } from "../video-frame-quality";
import { parseFrameScriptSemanticSignals } from "../video-semantic-detection";
import { fingerprintVideoSource } from "../video-source";
import { separateVideoScreenText } from "../video-text-separation";
import { FRAMESCRIPT_STORYBOARD_NODE_TYPE, FRAMESCRIPT_VIDEO_REVIEW_NODE_TYPE } from "@/lib/framescript-video-review/contracts";
import { extractFrameScriptKeyframes, extractFrameScriptTranscriptionAudio } from "@/services/api/framescript";

export const FRAMESCRIPT_VIDEO_ENGINE_ID = "framescript-video-engine";
export const DEFAULT_FRAMESCRIPT_VISION_MODEL = "qwen-vl-plus";
export const DEFAULT_FRAMESCRIPT_PROMPT_MODEL = "qwen-vl-plus";
export const DEFAULT_FRAMESCRIPT_TRANSCRIPTION_MODEL = "qwen3.5-omni-plus";
/**
 * Keep the persisted source media untouched, but avoid sending full-resolution
 * frame data URLs to the multimodal model. This is intentionally scoped to
 * the model request path below.
 */
const MODEL_FRAME_MAX_EDGE = 1280;
const MODEL_FRAME_JPEG_QUALITY = 0.8;

const manifest: PluginManifestV2 = {
    apiVersion: "yingce.plugin/v2",
    id: FRAMESCRIPT_VIDEO_ENGINE_ID,
    name: "视频拆解",
    version: "0.6.2",
    description: "在画布中提供 视频拆解工作流，支持候选抽帧、转录与人工确认后的逐帧视频理解。",
    permissions: ["media.read", "ai.text", "ai.audio"],
    configuration: { fields: [
        { name: "changeThreshold", type: "number", label: "候选帧变化阈值", default: 0.32, description: "0.01–1；当前基线使用画面差异，不代表人物追踪。" },
        { name: "samplingIntervalMs", type: "number", label: "扫描间隔（毫秒）", default: 400, description: "100–2000；影响采样精度，不决定最终保留帧数量。" },
        { name: "channelId", type: "select", label: "关联系统渠道", required: true, default: "", description: "由 Canvas 从系统渠道读取模型列表并执行请求；API Key 只在系统渠道中维护。" },
        { name: "transcriptionChannelId", type: "select", label: "转写系统渠道", description: "可选；留空时沿用关联系统渠道。可单独选择支持音频输入的系统渠道。" },
        { name: "visionModel", type: "select", label: "画面分析模型", description: "从关联系统渠道的模型列表中选择支持视觉输入的模型。" },
        { name: "promptModel", type: "select", label: "图片提示词模型", description: "从关联系统渠道的模型列表中选择提示词模型。" },
        { name: "transcriptionModel", type: "select", label: "语音转写模型", description: "从关联系统渠道的模型列表中选择语音转写模型。" },
    ] },
    contributes: {
        videoPlugins: [{
            id: FRAMESCRIPT_VIDEO_ENGINE_ID, label: "视频拆解", type: "video", stage: "ready",
            capabilities: ["adaptive-keyframe-extraction", "video-analysis", "transcription", "prompt-extraction", "scene-understanding", "asset-analysis"],
            plannedCapabilities: ["timeline", "compile", "render", "export"],
        }],
        canvasNodes: [{
            id: FRAMESCRIPT_VIDEO_REVIEW_NODE_TYPE,
            label: "视频拆解",
            defaultTitle: "视频拆解",
            defaultSize: { width: 640, height: 346 },
            renderer: "declarative",
            acceptsInputKind: "video",
            maxInputCount: 1,
            resourceKind: "text",
            inputKind: "text",
            schema: {
                type: "object",
                properties: {
                    status: { type: "string", title: "复核状态" },
                    candidateFrames: { type: "number", title: "候选帧" },
                    selectedFrames: { type: "number", title: "已确认帧" },
                },
            },
        }, {
            id: FRAMESCRIPT_STORYBOARD_NODE_TYPE,
            label: "FrameScript 分镜复刻",
            defaultTitle: "FrameScript 分镜复刻",
            defaultSize: { width: 980, height: 420 },
            renderer: "declarative",
            showInCreateMenu: false,
            acceptsInputKind: ["text", "image"],
            maxInputCount: 24,
            inputKind: "text",
            schema: {
                type: "object",
                properties: {
                    frames: { type: "number", title: "确认镜头" },
                    source: { type: "string", title: "来源" },
                    imageGenerationPrompt: { type: "string", title: "图片提示词" },
                    referenceNodeIds: { type: "array", title: "参考资产" },
                },
            },
        }],
    },
};
const frameScriptCapabilities = manifest.contributes.videoPlugins![0].capabilities;
export const frameScriptVideoEnginePlugin: RegisteredPlugin = {
    manifest,
    source: "bundled",
    createVideoPlugin: (context, contributionId) => {
        if (contributionId !== FRAMESCRIPT_VIDEO_ENGINE_ID) throw new VideoPluginError("not-registered", "FrameScript 未声明该视频能力");
        return createFrameScriptVideoEngine(context);
    },
};

registerPlugin(frameScriptVideoEnginePlugin);

function createFrameScriptVideoEngine(context: PluginHostContext): VideoPlugin {
    const visionModel = stringConfig(context.config.visionModel, DEFAULT_FRAMESCRIPT_VISION_MODEL);
    const promptModel = stringConfig(context.config.promptModel, DEFAULT_FRAMESCRIPT_PROMPT_MODEL);
    const transcriptionModel = stringConfig(context.config.transcriptionModel, DEFAULT_FRAMESCRIPT_TRANSCRIPTION_MODEL);
    const transcriptionChannelId = optionalStringConfig(context.config.transcriptionChannelId);
    const textService = context.services?.ai?.text;
    const audioService = context.services?.ai?.audio;
    return {
        id: FRAMESCRIPT_VIDEO_ENGINE_ID,
        name: manifest.name,
        type: "video",
        capabilities: frameScriptCapabilities,
        getAvailability: () => context.services?.media?.resolve ? { available: true } : { available: false, reason: "FrameScript 缺少受权的媒体读取服务" },
        analyze: async (input, options) => {
            const signal = options?.signal;
            signal?.throwIfAborted();
            // Detach caller-owned confirmation data before the first await. A
            // direct caller must not be able to mutate the selected frames
            // while media resolution or fingerprinting is in flight.
            const review = input.review ? structuredClone(input.review) : undefined;
            const reviewDraft = input.reviewDraft ? structuredClone(input.reviewDraft) : undefined;
            const preparing = input.operations.includes("adaptive-keyframe-extraction");
            const visual = input.operations.some((operation) => operation !== "adaptive-keyframe-extraction" && operation !== "transcription");
            // This is the irreversible boundary: raw frames never reach analysis
            // endpoints unless the caller supplies a current explicit confirmation.
            if (preparing && (visual || review)) throw new VideoPluginError("invalid-input", "准备候选帧后须人工确认，不能同时启动画面分析");
            if (visual && !review) throw new VideoPluginError("invalid-input", "请先人工筛选并确认候选帧，再进行画面分析");
            if (review) {
                if (review.state !== "confirmed" || !Array.isArray(review.frames) || !review.frames.length || input.operations.includes("transcription")) {
                    throw new VideoPluginError("invalid-input", "人工确认无效；筛选后不重复转录");
                }
                validateConfirmedVideoReview(review);
                if (review.source.id !== input.media.id || review.source.kind !== input.media.kind) throw new VideoPluginError("invalid-input", "人工确认不属于当前视频");
                if (!reviewDraft) throw new VideoPluginError("invalid-input", "缺少候选帧草稿，请重新准备并确认");
                assertVideoReview(reviewDraft, review);
            }
            // Saved resources always use the server decoder for candidates.
            // A requested transcript resolves the source only for audio; it
            // never brings candidate seeking or preview JPEG work back to Canvas.
            if (preparing && input.media.kind === "resource") {
                const taskController = new AbortController();
                const abortTask = () => taskController.abort(signal?.reason);
                signal?.addEventListener("abort", abortTask, { once: true });
                const scanPromise = scanCandidateFramesOnServer(input.media.id, context.config, taskController.signal);
                if (!input.operations.includes("transcription")) {
                    try {
                        const scan = await scanPromise;
                        return { pluginId: FRAMESCRIPT_VIDEO_ENGINE_ID, status: "completed", segments: [], keyframes: scan.keyframes, sourceFingerprint: scan.sourceFingerprint, durationMs: scan.durationMs, detectors: scan.detectors } satisfies AnalysisResult;
                    } finally {
                        signal?.removeEventListener("abort", abortTask);
                    }
                }
                try {
                    const scan = await scanPromise;
                    // Candidate review is the first user-visible boundary.  Only
                    // after it is ready do we derive a genuine MP3 audio track
                    // and submit that track to the configured ASR model.
                    const transcription = await transcribeSavedFrameScriptResource(audioService, transcriptionModel, transcriptionChannelId, input.media.id, taskController.signal);
                    return {
                        pluginId: FRAMESCRIPT_VIDEO_ENGINE_ID,
                        status: "completed",
                        segments: [],
                        keyframes: scan.keyframes,
                        sourceFingerprint: scan.sourceFingerprint,
                        durationMs: scan.durationMs,
                        detectors: scan.detectors,
                        transcript: transcription.transcript,
                        warnings: transcription.warning ? [transcription.warning] : undefined,
                    } satisfies AnalysisResult;
                } catch (error) {
					taskController.abort(error);
					await Promise.allSettled([scanPromise]);
                    throw error;
                } finally {
                    signal?.removeEventListener("abort", abortTask);
                }
            }
            // Retrying a failed transcript happens after candidates have been
            // saved, so it does not enter the preparation branch above. Keep
            // this path on the same server-derived MP3 contract.
            if (input.media.kind === "resource" && input.operations.length === 1 && input.operations[0] === "transcription") {
                const transcription = await transcribeSavedFrameScriptResource(audioService, transcriptionModel, transcriptionChannelId, input.media.id, signal);
                return {
                    pluginId: FRAMESCRIPT_VIDEO_ENGINE_ID,
                    status: "completed",
                    segments: [],
                    sourceFingerprint: transcription.sourceFingerprint,
                    warnings: transcription.warning ? [transcription.warning] : undefined,
                    transcript: transcription.transcript,
                } satisfies AnalysisResult;
            }
            const resolve = context.services?.media?.resolve;
            if (!resolve) throw new VideoPluginError("runtime-unavailable", "FrameScript 缺少受权的媒体读取服务");
            const media = await resolve(input.media, signal);
            if (media.kind !== "video") throw new VideoPluginError("invalid-input", "FrameScript 当前需要已保存的视频素材");
            if (review) {
                validateConfirmedVideoReview(review, media.durationMs);
                if (review.source.kind !== input.media.kind || review.source.id !== input.media.id) throw new VideoPluginError("invalid-input", "人工确认不属于当前视频");
            }
            const sourceFingerprint = preparing || review || input.operations.includes("transcription") ? await fingerprintVideoSource(media.blob, signal) : undefined;
            if (review && review.sourceFingerprint !== sourceFingerprint) throw new VideoPluginError("invalid-input", "原视频已变化，请重新准备并确认候选帧");

            const [scan, transcription] = await Promise.all([
                preparing ? scanCandidateFrames(media.blob, context.config, signal) : Promise.resolve<FrameScan | undefined>(undefined),
                input.operations.includes("transcription") ? settleFrameScriptTranscription(() => transcribeWithCanvasChannel(audioService, transcriptionModel, transcriptionChannelId, media.blob, media.fileName, signal), signal) : Promise.resolve<Awaited<ReturnType<typeof settleFrameScriptTranscription>>>({}),
            ]);
            const transcript = transcription.transcript;
            const frames = review?.frames ?? scan?.keyframes ?? [];
            const durationMs = scan?.durationMs ?? media.durationMs;
            if (visual && (!frames.length || !durationMs)) throw new VideoPluginError("invalid-input", "没有可分析的已确认画面");
            const segments: Array<{ startMs: number; endMs: number; keyframe: VideoAnalysisKeyframe; description?: string; prompt?: string }> = frames.map((frame, index) => ({ startMs: frame.timeMs, endMs: frames[index + 1]?.timeMs ?? Math.max(frame.timeMs + 1, durationMs ?? frame.timeMs + 1), keyframe: frame }));
            const summaries: string[] = [];
            const detectors = new Set(scan?.detectors ?? []);
            if (visual) {
                for (let offset = 0; offset < frames.length; offset += 6) {
                    const batch = frames.slice(offset, offset + 6);
                    const images = await captureFrames(media.blob, batch, signal);
                    if (input.operations.some((operation) => ["video-analysis", "scene-understanding", "asset-analysis"].includes(operation))) {
                        const response = await requestFrameAnalysis(textService, visionModel, images, signal);
                        if (!Array.isArray(response.frame_notes) || response.frame_notes.length !== batch.length || response.frame_notes.some((item) => typeof item !== "string" || !item.trim())) {
                            throw new VideoPluginError("runtime-unavailable", "FrameScript 画面分析结果不完整，未自动错位配对");
                        }
                        response.frame_notes.forEach((description, index) => {
                            const separated = separateVideoScreenText(description as string);
                            segments[offset + index].description = separated.visual;
                        });
                        if (response.script_text) summaries.push(response.script_text);
                        const semantic = parseFrameScriptSemanticSignals(response.semantic_signals, batch.length);
                        semantic.detectors.forEach((detector) => detectors.add(detector));
                        semantic.signalsByFrame.forEach((signals, index) => {
                            if (!signals.length) return;
                            const keyframe = segments[offset + index].keyframe;
                            segments[offset + index].keyframe = { ...keyframe, semanticSignals: [...(keyframe.semanticSignals ?? []), ...signals] };
                        });
                    }
                    if (input.operations.includes("prompt-extraction")) {
                        const response = await requestImagePrompts(textService, promptModel, images, batch, signal);
                        const returned = new Map(response.frames?.map((item) => [String(item.id ?? ""), [item.prompt_cn, item.prompt_en].filter((text): text is string => typeof text === "string" && Boolean(text)).join("\n")] as const) ?? []);
                        if (returned.size !== batch.length || [...returned.keys()].some((id) => !/^\d+$/.test(id) || Number(id) < 1 || Number(id) > batch.length)) throw new VideoPluginError("runtime-unavailable", "FrameScript 未返回全部选中帧的提示词");
                        batch.forEach((_frame, index) => {
                            const separated = separateVideoScreenText(returned.get(String(index + 1)) || "");
                            segments[offset + index].prompt = separated.visual || undefined;
                        });
                        if (response.prompt_text) summaries.push(response.prompt_text);
                    }
                }
            }
            return { pluginId: FRAMESCRIPT_VIDEO_ENGINE_ID, status: "completed", segments, summary: summaries.join("\n\n") || undefined, keyframes: scan?.keyframes, transcript, warnings: transcription.warning ? [transcription.warning] : undefined, sourceFingerprint, durationMs, detectors: [...detectors] } satisfies AnalysisResult;
        },
    };
}

type FrameScan = { keyframes: VideoAnalysisKeyframe[]; durationMs: number; detectors: string[] };

type ServerFrameScan = FrameScan & { sourceFingerprint: string };

async function scanCandidateFramesOnServer(resourceId: string, config: Readonly<Record<string, string | number | boolean>>, signal?: AbortSignal): Promise<ServerFrameScan> {
    const result = await extractFrameScriptKeyframes(resourceId, {
        samplingIntervalMs: numberConfig(config.samplingIntervalMs, 400, 100, 2_000, "samplingIntervalMs"),
        changeThreshold: numberConfig(config.changeThreshold, 0.32, 0.01, 1, "changeThreshold"),
    }, { signal });
    if (!result.sourceFingerprint || !/^[a-f0-9]{64}$/.test(result.sourceFingerprint) || !Number.isFinite(result.durationMs) || result.durationMs <= 0 || !Array.isArray(result.keyframes) || !result.keyframes.length) {
        throw new VideoPluginError("runtime-unavailable", "FrameScript 服务端候选帧结果不完整");
    }
    return result;
}

async function scanCandidateFrames(blob: Blob, config: Readonly<Record<string, string | number | boolean>>, signal?: AbortSignal): Promise<FrameScan> {
    const interval = numberConfig(config.samplingIntervalMs, 400, 100, 2_000, "samplingIntervalMs");
    const threshold = numberConfig(config.changeThreshold, 0.32, 0.01, 1, "changeThreshold");
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true; video.preload = "auto";
    try {
        await videoEvent(video, "loadeddata", () => { video.src = url; video.load(); }, signal);
        const durationMs = Math.floor(video.duration * 1000);
        if (!Number.isFinite(durationMs) || durationMs < 1 || !video.videoWidth || !video.videoHeight) throw new VideoPluginError("runtime-unavailable", "无法读取视频时长或尺寸");
        const canvas = document.createElement("canvas");
        const sampleDimensions = getFrameQualitySampleDimensions(video.videoWidth, video.videoHeight);
        canvas.width = sampleDimensions.width; canvas.height = sampleDimensions.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new VideoPluginError("runtime-unavailable", "无法创建候选帧画布");
        const last = Math.max(0, durationMs - 1); const samples: VideoFrameSample[] = []; const signatures: Uint8Array[] = [];
        let previous: Uint8ClampedArray | undefined; let twoStepsBack: Uint8ClampedArray | undefined;
        for (let timeMs = 0; ; timeMs = Math.min(last, timeMs + interval)) {
            signal?.throwIfAborted();
            if (Math.abs(video.currentTime * 1000 - timeMs) > 1) await videoEvent(video, "seeked", () => { video.currentTime = timeMs / 1000; }, signal);
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            const boundary = timeMs === 0 ? "opening" : timeMs === last ? "closing" : undefined;
            const pair = analyzeVideoFramePair(previous ? { pixels: previous, width: canvas.width, height: canvas.height } : undefined, { pixels, width: canvas.width, height: canvas.height });
            const sample: VideoFrameSample = { timeMs, ...pair, retainedDifference: 0, twoStepDifference: twoStepsBack ? pixelDifference(twoStepsBack, pixels) : undefined, hardReasons: boundary ? [boundary] : [], width: video.videoWidth, height: video.videoHeight };
            samples.push(sample);
            signatures.push(lumaSignature(pixels, canvas.width, canvas.height));
            twoStepsBack = previous;
            previous = pixels;
            if (timeMs === last) break;
        }
        const temporalSamples = resolveTemporalVideoFrameSignals(samples, { threshold });
        let selectedSignature: Uint8Array | undefined;
        const scoredSamples = temporalSamples.map((sample, index) => {
            const retainedDifference = selectedSignature ? signatureDifference(selectedSignature, signatures[index]) : 0;
            const resolved = { ...sample, retainedDifference };
            if (selectVideoFrameCandidates([resolved], { threshold })[0]) selectedSignature = signatures[index];
            return resolved;
        });
        const keyframes = await refineRepresentativeFrames(
            selectVideoFrameCandidates(scoredSamples, { threshold }),
            durationMs,
            async (timeMs): Promise<VideoFrameQualitySample> => {
                signal?.throwIfAborted();
                if (Math.abs(video.currentTime * 1000 - timeMs) > 1) await videoEvent(video, "seeked", () => { video.currentTime = timeMs / 1000; }, signal);
                context.drawImage(video, 0, 0, canvas.width, canvas.height);
                return { timeMs, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
            },
            signal,
        );
        return { keyframes, durationMs, detectors: ["adjacent-pixel-difference", "retained-signature-difference", "scene-cut-temporal-v2", "transition-temporal-v2", "exposure-change-v1", "motion-shift-v2", "composite-change-v3", "local-laplacian-exposure-v1"] };
    } finally { video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}

async function captureFrames(blob: Blob, frames: readonly VideoAnalysisKeyframe[], signal?: AbortSignal) {
    const url = URL.createObjectURL(blob); const video = document.createElement("video"); video.muted = true; video.playsInline = true;
    try {
        await videoEvent(video, "loadeddata", () => { video.src = url; video.load(); }, signal);
        const sourceWidth = video.videoWidth;
        const sourceHeight = video.videoHeight;
        if (!sourceWidth || !sourceHeight) throw new VideoPluginError("runtime-unavailable", "无法读取原帧尺寸");
        const scale = Math.min(1, MODEL_FRAME_MAX_EDGE / Math.max(sourceWidth, sourceHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(2, Math.round(sourceWidth * scale));
        canvas.height = Math.max(2, Math.round(sourceHeight * scale));
        const context = canvas.getContext("2d"); if (!context) throw new VideoPluginError("runtime-unavailable", "无法创建原帧画布");
        const result: string[] = [];
        for (const frame of frames) {
            signal?.throwIfAborted();
            await videoEvent(video, "seeked", () => { video.currentTime = frame.timeMs / 1000; }, signal);
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            result.push(canvas.toDataURL("image/jpeg", MODEL_FRAME_JPEG_QUALITY));
        }
        return result;
    } finally { video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}

async function transcribeWithCanvasChannel(service: PluginAiAudioService | undefined, model: string, channelId: string | undefined, blob: Blob, fileName: string, signal?: AbortSignal): Promise<VideoTranscript> {
    if (!service) throw new VideoPluginError("runtime-unavailable", "Canvas 系统渠道未提供语音转写服务");
    const result = await service.transcribe({ model, channelId, file: blob, fileName, signal });
    return {
        text: result.text,
        segments: (result.segments || []).map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs, originalText: segment.text })),
    };
}

async function transcribeSavedFrameScriptResource(service: PluginAiAudioService | undefined, model: string, channelId: string | undefined, resourceId: string, signal?: AbortSignal) {
    const { audio, sourceFingerprint } = await extractFrameScriptTranscriptionAudio(resourceId, { signal });
    const file = new File([audio], `${resourceId}.mp3`, { type: "audio/mpeg" });
    const transcription = await settleFrameScriptTranscription(
        () => transcribeWithCanvasChannel(service, model, channelId, file, file.name, signal),
        signal,
    );
    return { ...transcription, sourceFingerprint };
}

function optionalStringConfig(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Transcription enriches review context but must never discard successfully prepared local candidate frames. */
export async function settleFrameScriptTranscription(operation: () => Promise<VideoTranscript>, signal?: AbortSignal): Promise<{ transcript?: VideoTranscript; warning?: VideoAnalysisWarning }> {
    try {
        return { transcript: await operation() };
    } catch (error) {
        signal?.throwIfAborted();
        const detail = error instanceof Error && error.message ? error.message.replace(/\s+/g, " ").trim() : "请求未完成";
        return { warning: { stage: "transcription", message: `语音转写未完成：${detail.slice(0, 420)}` } };
    }
}

/**
 * A host media resolver may be waiting on IndexedDB or a resource download
 * that cannot physically be cancelled.  Stop awaiting it when this workflow
 * ends so a failed server scan never keeps the canvas task pending.
 */

async function requestFrameAnalysis(service: PluginAiTextService | undefined, model: string, images: string[], signal?: AbortSignal) {
    const parsed = await requestStructuredModel(service, model, [
        "你是视频逐帧分析器。按图片输入顺序输出严格 JSON，不要 Markdown，不要英文说明。格式：{\"script_text\":\"整体画面摘要\",\"frame_notes\":[\"第1张画面文案\",\"第2张画面文案\"],\"semantic_signals\":[{\"frame_index\":0,\"signals\":[{\"kind\":\"subject-movement\",\"score\":0.8,\"reason\":\"person-movement\",\"detector\":\"vision-model\",\"evidence\":\"人物由左向右移动\"}]}]}。frame_notes 必须与图片数量完全一致，每项只写对应画面的视觉内容，不提取画面字幕或 OCR 文本。semantic_signals 是可选字段：只有能直接从该帧画面确认的人物或产品进出/位移、遮挡、姿态、景别、镜头运动或表情变化才填写；无法确认时返回空数组，禁止猜测人物身份或 OCR 文本。",
        ...images,
    ], signal);
    return parsed as { script_text?: string; frame_notes?: unknown; semantic_signals?: unknown };
}

async function requestImagePrompts(service: PluginAiTextService | undefined, model: string, images: string[], frames: readonly VideoAnalysisKeyframe[], signal?: AbortSignal) {
    const parsed = await requestStructuredModel(service, model, [
        "你是分镜图片提示词生成器。按图片输入顺序输出严格 JSON，不要 Markdown，不要英文。格式：{\"frames\":[{\"id\":\"1\",\"prompt_cn\":\"中文图片生成提示词\"}]}。每张图片必须返回一个对象，id 从 1 开始连续编号。只描述可用于生成分镜图的视觉内容，不提取或加入画面字幕、OCR 文本。",
        ...images,
    ], signal);
    const framesResult = Array.isArray(parsed.frames) ? parsed.frames : [];
    return {
        prompt_text: typeof parsed.prompt_text === "string" ? parsed.prompt_text : undefined,
        frames: framesResult.map((item, index) => {
            const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
            return { id: String(value.id ?? index + 1), prompt_cn: typeof value.prompt_cn === "string" ? value.prompt_cn : "", prompt_en: "" };
        }),
    };
}

async function requestStructuredModel(service: PluginAiTextService | undefined, model: string, parts: [string, ...string[]], signal?: AbortSignal) {
    if (!service) throw new VideoPluginError("runtime-unavailable", "Canvas 系统渠道未提供文本/视觉理解服务");
    const content: PluginTextContentPart[] = parts.map((part, index) => index === 0 ? { type: "text", text: part } : { type: "image_url", image_url: { url: part } });
    const response = await service.requestToolResponse({ model, messages: [{ role: "user", content }], signal });
    try {
        const text = response.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        throw new VideoPluginError("runtime-unavailable", "Canvas 系统渠道返回的分析结果不是有效 JSON");
    }
}

function stringConfig(value: unknown, fallback: string) { return typeof value === "string" && value.trim() ? value.trim() : fallback; }
function numberConfig(value: unknown, fallback: number, min: number, max: number, name: string) { if (value === undefined) return fallback; if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new VideoPluginError("invalid-input", `抽帧参数 ${name} 无效`); return value; }
function pixelDifference(left: Uint8ClampedArray, right: Uint8ClampedArray) { let total = 0; for (let index = 0; index < left.length; index += 4) total += Math.abs(left[index] - right[index]) + Math.abs(left[index + 1] - right[index + 1]) + Math.abs(left[index + 2] - right[index + 2]); return total / (left.length / 4 * 3 * 255); }
function lumaSignature(pixels: Uint8ClampedArray, width: number, height: number) {
    const columns = 32; const rows = Math.max(9, Math.round(columns * height / width)); const signature = new Uint8Array(columns * rows);
    for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
        const x = Math.min(width - 1, Math.floor((column + 0.5) * width / columns)); const y = Math.min(height - 1, Math.floor((row + 0.5) * height / rows)); const index = (y * width + x) * 4;
        signature[row * columns + column] = Math.round(pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722);
    }
    return signature;
}
function signatureDifference(left: Uint8Array, right: Uint8Array) { let total = 0; for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index] - right[index]); return total / Math.max(1, left.length * 255); }
function formatTime(value: number) { const seconds = Math.floor(value / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${String(value % 1000).padStart(3, "0")}`; }
function videoEvent(video: HTMLVideoElement, event: "loadeddata" | "seeked", start: () => void, signal?: AbortSignal) { return new Promise<void>((resolve, reject) => { const cleanup = () => { clearTimeout(timer); video.removeEventListener(event, done); video.removeEventListener("error", fail); signal?.removeEventListener("abort", abort); }; const done = () => { cleanup(); resolve(); }; const fail = () => { cleanup(); reject(new VideoPluginError("runtime-unavailable", "视频读取或定位失败")); }; const abort = () => { cleanup(); reject(signal?.reason ?? new DOMException("已取消", "AbortError")); }; const timer = setTimeout(fail, 20_000); video.addEventListener(event, done, { once: true }); video.addEventListener("error", fail, { once: true }); signal?.addEventListener("abort", abort, { once: true }); try { start(); } catch (error) { cleanup(); reject(error); } }); }
