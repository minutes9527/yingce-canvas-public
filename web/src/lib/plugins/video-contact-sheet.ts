import { formatVideoFrameTime } from "@/lib/canvas/canvas-video-frame";
import { VideoPluginError } from "./video-plugin";
import { validateVideoReviewDraft, type VideoReviewDraft } from "./video-review";

export type ContactSheetCell = { frameId: string; ordinal: number; timeMs: number; eventTimeMs?: number; shotId?: string; label: string; x: number; y: number; width: number; imageHeight: number; height: number };
export type ContactSheetLayout = { pageIndex: number; pageCount: number; totalFrames: number; width: number; height: number; cells: readonly ContactSheetCell[] };

/** Page limits control preview memory only; they never truncate retained candidates. */
export function layoutVideoContactSheet(draft: VideoReviewDraft, pageIndex: number, pageSize?: number, columns?: number): ContactSheetLayout {
    validateVideoReviewDraft(draft);
    const measured = draft.frames.find((frame) => frame.width && frame.height);
    const ratio = measured ? measured.width! / measured.height! : 16 / 9;
    const portrait = ratio < 1;
    pageSize ??= portrait ? 15 : 12; columns ??= portrait ? 5 : 3;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 24 || !Number.isInteger(columns) || columns < 1 || columns > 6) throw new VideoPluginError("invalid-input", "多宫格分页参数无效");
    const pageCount = Math.ceil(draft.frames.length / pageSize);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) throw new VideoPluginError("invalid-input", "多宫格页码超出范围");
    const frames = [...draft.frames].sort((left, right) => left.timeMs - right.timeMs).slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
    const actualColumns = Math.min(columns, frames.length), gap = 12;
    const width = Math.max(1, Math.round(Math.min(portrait ? 180 : 320, 360 * ratio))), imageHeight = Math.max(1, Math.round(width / ratio)), height = imageHeight + 32;
    return {
        pageIndex, pageCount, totalFrames: draft.frames.length, width: gap + actualColumns * (width + gap), height: gap + Math.ceil(frames.length / actualColumns) * (height + gap),
        cells: frames.map((frame, index) => ({ frameId: frame.id, ordinal: pageIndex * pageSize + index + 1, timeMs: frame.timeMs, eventTimeMs: frame.eventTimeMs, shotId: frame.shotId, label: `#${pageIndex * pageSize + index + 1} ${formatVideoFrameTime(frame.timeMs)}`, x: gap + (index % actualColumns) * (width + gap), y: gap + Math.floor(index / actualColumns) * (height + gap), width, imageHeight, height })),
    };
}

export function containContactSheetImage(sourceWidth: number, sourceHeight: number, cell: ContactSheetCell) {
    if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) throw new VideoPluginError("invalid-input", "无法读取视频尺寸");
    const scale = Math.min(cell.width / sourceWidth, cell.imageHeight / sourceHeight);
    return { x: cell.x + (cell.width - sourceWidth * scale) / 2, y: cell.y + (cell.imageHeight - sourceHeight * scale) / 2, width: sourceWidth * scale, height: sourceHeight * scale };
}

export function contactSheetFrameAt(layout: ContactSheetLayout, x: number, y: number) {
    return layout.cells.find((cell) => x >= cell.x && x < cell.x + cell.width && y >= cell.y && y < cell.y + cell.imageHeight)?.frameId;
}
