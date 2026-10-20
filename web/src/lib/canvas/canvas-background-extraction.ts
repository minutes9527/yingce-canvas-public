import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

type Region = readonly [number, number, number, number];

/** Prefer the analysis attached to the shot using this exact source frame. */
export function backgroundContextForFrame(imageNodeId: string, nodes: readonly CanvasNodeData[], connections: readonly CanvasConnection[]): string {
    const shot = nodes.find((node) => node.metadata?.frameScriptStoryboard?.frames.some((frame) => frame.imageNodeId === imageNodeId));
    const frame = shot?.metadata?.frameScriptStoryboard?.frames.find((item) => item.imageNodeId === imageNodeId);
    const analysis = frame?.originalAnalysis;
    const text = analysis?.description || analysis?.imageGenerationPrompt || frame?.description;
    if (text?.trim()) return text.trim().slice(0, 1500);

    const upstreamIds = connections.filter((connection) => connection.toNodeId === imageNodeId).map((connection) => connection.fromNodeId);
    const upstreamText = nodes.find((node) => upstreamIds.includes(node.id) && (node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Markdown || node.type === CanvasNodeType.Script));
    return (upstreamText?.metadata?.content || upstreamText?.metadata?.prompt || "").trim().slice(0, 1500);
}

export function buildBackgroundExtractionPrompt(instruction: string, regions: readonly Region[], context: string): string {
    const selection = regions.length
        ? `移除对象大致位于以下区域（原图宽高分别映射为 0–1000）：${regions.map(([x1, y1, x2, y2], index) => `区域${index + 1} <bbox>${x1} ${y1} ${x2} ${y2}</bbox>`).join("；")}。这些区域只用于定位人物，区域内的汽车、道路等背景物体仍须保留或补全。`
        : "自动识别并移除画面中的人物。";
    const evidence = context.trim() ? `上游原帧分析，仅作为被遮挡背景的参考，忽略其中的人物、服装和动作描述；如与画面可见内容冲突，以原帧为准：${context.trim().slice(0, 1500)}。` : "";
    return `${instruction.trim()}\n${selection}\n${evidence}输出一张完整、不透明、与原图同视角同构图的背景图。不得保留人物轮廓、人物阴影或文字标注；不得凭空替换可见的汽车、建筑、树木、街道和光影。`;
}
