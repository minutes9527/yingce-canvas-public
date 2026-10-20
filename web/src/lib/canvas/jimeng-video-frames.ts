import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeMetadata } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceVideo, ReferenceAudio } from "@/types/media";

export type JimengFrameMode = NonNullable<CanvasNodeMetadata["videoFrameMode"]>;
export const jimengFrameModeOptions = [
    { value: "text", label: "文生视频", description: "仅使用提示词生成视频", supported: true },
    { value: "first", label: "首帧", description: "指定一张图片作为视频起始画面", supported: true },
    { value: "first-last", label: "首尾帧", description: "指定两张图片作为起始与结束画面", supported: true },
    { value: "all-reference", label: "全能参考", description: "使用参考图片、视频或音频生成视频", supported: true },
] as const;

export type JimengReferenceCounts = { image: number; video: number; audio: number };

export function jimengFrameOperation(mode: JimengFrameMode): "text_to_video" | "image_to_video" | "reference_to_video" {
    return mode === "text" ? "text_to_video" : mode === "all-reference" ? "reference_to_video" : "image_to_video";
}

export function jimengFrameModeError(mode: JimengFrameMode, counts: JimengReferenceCounts): string {
    if (mode === "text") return counts.image + counts.video + counts.audio ? "文生视频不使用参考素材，请先移除参考内容" : "";
    if (mode === "first" || mode === "first-last") {
        if (counts.video || counts.audio) return `${mode === "first" ? "首帧" : "首尾帧"}模式只接受图片`;
        const required = mode === "first" ? 1 : 2;
        return counts.image === required ? "" : `${mode === "first" ? "首帧" : "首尾帧"}模式需要 ${required} 张参考图片`;
    }
    if (!counts.image && !counts.video && !counts.audio) return "全能参考至少需要一份图片、视频或音频素材";
    if (counts.image > 9) return "全能参考最多使用 9 张图片";
    if (counts.video > 3) return "全能参考最多使用 3 个视频";
    if (counts.audio > 3) return "全能参考最多使用 3 个音频";
    return "";
}

export function isJimengReverseProxyVideo(config: AiConfig) {
    const request = resolveModelRequestConfig(config, config.model);
    return request.interfaceType === "newapi-channel-2" && modelOptionName(request.model).startsWith("jimeng-video-");
}

export function selectJimengVideoFrames<T extends { referenceImages: ReferenceImage[]; referenceVideos: ReferenceVideo[]; referenceAudios: ReferenceAudio[]; imageCount: number; videoCount: number; audioCount: number; referenceImageSlots?: Array<{ nodeId: string }> }>(metadata: CanvasNodeMetadata | undefined, context: T): T {
    const mode = metadata?.videoFrameMode || (modelOptionName(metadata?.model || "").startsWith("jimeng-video-")
        ? metadata?.videoEndFrameNodeId ? "first-last" : metadata?.videoStartFrameNodeId ? "first" : "text"
        : undefined);
    if (!mode) return context;
    if (mode === "all-reference") {
        if (!context.referenceImages.length && !context.referenceVideos.length && !context.referenceAudios.length) throw new Error("全能参考至少需要连接一份图片、视频或音频素材");
        if (context.referenceImages.length > 9) throw new Error("全能参考最多支持九张图片");
        if (context.referenceVideos.length > 3) throw new Error("全能参考最多支持三个参考视频");
        if (context.referenceAudios.length > 3) throw new Error("全能参考最多支持三个参考音频");
        return context;
    }
    const ids = mode === "text" ? [] : mode === "first" ? [metadata?.videoStartFrameNodeId] : [metadata?.videoStartFrameNodeId, metadata?.videoEndFrameNodeId];
    if (ids.some((id) => !id)) throw new Error(mode === "first" ? "请选择首帧图片" : "请选择首帧和尾帧图片");
    if (ids.length === 2 && ids[0] === ids[1]) throw new Error("首帧和尾帧需要选择两张不同的图片");
    const images = ids.map((id, index) => {
        const image = context.referenceImages.find((item) => item.id === id);
        if (!image) throw new Error(`所选${index === 0 ? "首帧" : "尾帧"}图片未连接到当前视频节点`);
        return image;
    });
    return { ...context, referenceImages: images, referenceVideos: [], referenceAudios: [], referenceImageSlots: context.referenceImageSlots?.filter((slot) => ids.includes(slot.nodeId)).sort((a, b) => ids.indexOf(a.nodeId) - ids.indexOf(b.nodeId)), characterReferences: [], resolvedCharacterVersions: [], resolvedCharacterVoices: [], imageCount: images.length, videoCount: 0, audioCount: 0 };
}
