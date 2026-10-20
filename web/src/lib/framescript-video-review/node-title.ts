import type { CanvasNodeData } from "@/types/canvas";

export function frameScriptNodeDisplayTitle(node: CanvasNodeData): string {
    if (node.metadata?.frameScriptStoryboard?.presentation !== "single-shot") return node.title;
    return node.title.replace(/^FrameScript · 镜头 (\d+)$/, "视频拆解 · 镜头 $1");
}
