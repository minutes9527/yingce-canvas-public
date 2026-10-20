import type { PluginHostContext } from "@/lib/plugins/plugin-types";
import { VideoPluginError } from "@/lib/plugins/video-plugin";
import { fingerprintVideoSource } from "@/lib/plugins/video-source";
import { containContactSheetImage, layoutVideoContactSheet, type ContactSheetLayout } from "@/lib/plugins/video-contact-sheet";
import type { VideoReviewDraft } from "@/lib/plugins/video-review";

export type VideoContactSheetPage = { purpose: "review-preview-only"; source: VideoReviewDraft["source"]; sourceFingerprint: string; revision: number; layout: ContactSheetLayout; image: Blob };

/** Authorized, local preview only: no model call, upload or confirmation side effect. */
export async function createVideoContactSheetPage(context: PluginHostContext, draft: VideoReviewDraft, pageIndex: number, options: { pageSize?: number; columns?: number; signal?: AbortSignal } = {}): Promise<VideoContactSheetPage> {
    const layout = layoutVideoContactSheet(draft, pageIndex, options.pageSize, options.columns);
    if (!context.permissions.has("media.read") || !context.services?.media?.resolve) throw new VideoPluginError("permission-denied", "多宫格预览需要当前已授权的媒体读取服务");
    const media = await context.services.media.resolve(draft.source, options.signal);
    if (media.kind !== "video") throw new VideoPluginError("invalid-input", "多宫格预览需要视频素材");
    if (await fingerprintVideoSource(media.blob, options.signal) !== draft.sourceFingerprint) throw new VideoPluginError("invalid-input", "原视频已变化，请重新准备候选帧");
    return { purpose: "review-preview-only", source: draft.source, sourceFingerprint: draft.sourceFingerprint, revision: draft.revision, layout, image: await renderContactSheet(media.blob, layout, options.signal) };
}

async function renderContactSheet(blob: Blob, layout: ContactSheetLayout, signal?: AbortSignal) {
    if (!layout.cells.length || layout.cells.length > 24 || layout.width * layout.height > 4_000_000) throw new VideoPluginError("invalid-input", "多宫格画布尺寸无效");
    const url = URL.createObjectURL(blob), video = document.createElement("video"); video.muted = true; video.playsInline = true; video.preload = "auto";
    try {
        await waitFor(video, "loadeddata", () => { video.src = url; video.load(); }, signal);
        const canvas = document.createElement("canvas"); canvas.width = layout.width; canvas.height = layout.height;
        const ctx = canvas.getContext("2d"); if (!ctx) throw new VideoPluginError("runtime-unavailable", "无法创建多宫格画布");
        ctx.fillStyle = "#111"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        for (const cell of layout.cells) {
            signal?.throwIfAborted();
            if (Math.abs(video.currentTime * 1000 - cell.timeMs) > 0.5) await waitFor(video, "seeked", () => { video.currentTime = cell.timeMs / 1000; }, signal);
            const fit = containContactSheetImage(video.videoWidth, video.videoHeight, cell);
            ctx.fillStyle = "#000"; ctx.fillRect(cell.x, cell.y, cell.width, cell.imageHeight); ctx.drawImage(video, fit.x, fit.y, fit.width, fit.height);
            ctx.fillStyle = "#fff"; ctx.font = "14px monospace"; ctx.textBaseline = "middle"; ctx.fillText(cell.label, cell.x + 6, cell.y + cell.imageHeight + 16);
        }
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new VideoPluginError("runtime-unavailable", "多宫格编码失败")), "image/png"));
    } finally { video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}

function waitFor(video: HTMLVideoElement, event: "loadeddata" | "seeked", start: () => void, signal?: AbortSignal) { return new Promise<void>((resolve, reject) => { const cleanup = () => { clearTimeout(timer); video.removeEventListener(event, ok); video.removeEventListener("error", fail); signal?.removeEventListener("abort", abort); }; const ok = () => { cleanup(); resolve(); }; const fail = () => { cleanup(); reject(new VideoPluginError("runtime-unavailable", "多宫格视频读取或定位失败")); }; const abort = () => { cleanup(); reject(signal?.reason ?? new DOMException("已取消", "AbortError")); }; const timer = setTimeout(fail, 20_000); video.addEventListener(event, ok, { once: true }); video.addEventListener("error", fail, { once: true }); signal?.addEventListener("abort", abort, { once: true }); try { start(); } catch (error) { cleanup(); reject(error); } }); }
