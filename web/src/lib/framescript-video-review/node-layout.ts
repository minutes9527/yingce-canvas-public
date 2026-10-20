import { FRAMESCRIPT_VIDEO_REVIEW_NODE_TYPE } from "@/lib/framescript-video-review/contracts";
import type { CanvasNodeData } from "@/types/canvas";

export const FRAMESCRIPT_VIDEO_REVIEW_NODE_RATIO = 1.85;

export function frameScriptVideoReviewNodeHeight(width: number) {
    return Math.round(width / FRAMESCRIPT_VIDEO_REVIEW_NODE_RATIO);
}

/** Upgrade persisted legacy review cards while preserving their width and position. */
export function normalizeFrameScriptVideoReviewNodeSizes(nodes: CanvasNodeData[]) {
    let changed = false;
    const normalized = nodes.map((node) => {
        if (node.type !== FRAMESCRIPT_VIDEO_REVIEW_NODE_TYPE) return node;
        const height = frameScriptVideoReviewNodeHeight(node.width);
        if (Math.abs(node.height - height) <= 1) return node;
        changed = true;
        return { ...node, height };
    });
    return changed ? normalized : nodes;
}
