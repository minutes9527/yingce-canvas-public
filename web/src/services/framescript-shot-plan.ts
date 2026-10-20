import type { CanvasNodeData } from "@/types/canvas";
import { frameScriptFinalContent } from "@/lib/framescript-video-review/storyboard-content";
import { alignFrameScriptUnits, parseFrameScriptModelJson, splitFrameScriptNarration } from "@/lib/framescript-video-review/shot-alignment";
import { createFrameScriptVideoReviewRuntime } from "./framescript-video-review-runtime";

export type ShotPlan = { nodeId: string; frameId: string; snapshot: string; dialogue: string; imageGenerationPrompt: string; videoMotionPrompt: string; warnings: string[]; reason: string };
export async function prepareFrameScriptShotPlan(shots: CanvasNodeData[], narration: string, model: string, nodes: CanvasNodeData[], signal: AbortSignal): Promise<ShotPlan[]> {
    if (!shots.length || shots.length > 30) throw new Error("一次支持 1–30 个镜头");
    const units = splitFrameScriptNarration(narration);
    const runtime = await createFrameScriptVideoReviewRuntime();
    const context = shots.map(n => {
        const frame = n.metadata!.frameScriptStoryboard!.frames[0];
        return { id: frame.id, original: frame.originalAnalysis, current: frameScriptFinalContent(frame), locked: frame.lockedFields || [], duration: frame.durationSeconds, assets: Object.fromEntries(Object.entries(frame.assets || {}).map(([kind, ids]) => [kind, ids.map(id => ({ id, name: nodes.find(n => n.id === id)?.title || "资产缺失" }))])) };
    });
    const scoring = parseFrameScriptModelJson(await runtime.requestShotPlan(model, `对每个文案单元与每个镜头按语义、动作和产品匹配度评分 0–1。返回 {"scores":[[分数]]}，矩阵 ${units.length} 行、${shots.length} 列。不得改变文案顺序或内容。\n${JSON.stringify({ units, shots: context })}`, signal)) as { scores?: number[][] };
    const assignment = alignFrameScriptUnits(units, context.map(s => s.duration), scoring?.scores || []);
    const response = parseFrameScriptModelJson(await runtime.requestShotPlan(model, `按已经确定的台词分配为每个镜头生成改编建议，保持原镜头构图和运镜，只有台词或资产要求冲突时才修改。没有接入的资产不得假装已接入。锁定字段不能改变；若与台词矛盾，写明需要用户处理。只生成视觉提示词和视频动作，不把旁白文字写入画面。返回 {"shots":[{"id":"原镜头id","imageGenerationPrompt":"最终图片提示词","videoMotionPrompt":"最终动作","warnings":["冲突或缺失资产"],"reason":"本次修改说明"}]}，每个镜头恰好一次。没有台词的镜头保留原有画面。\n${JSON.stringify({ shots: context.map((s, i) => ({ ...s, assignedDialogue: assignment[i].dialogue })) })}`, signal)) as { shots?: unknown[] };
    if (!Array.isArray(response?.shots) || response.shots.length !== shots.length) throw new Error("模型返回镜头数量不完整，未应用任何修改");
    const seen = new Set<string>();
    const proposed = response.shots.map(value => {
        if (!value || typeof value !== "object") throw new Error("模型镜头格式无效");
        const p = value as Record<string, unknown>;
        if (typeof p.id !== "string" || seen.has(p.id) || !context.some(s => s.id === p.id) || typeof p.imageGenerationPrompt !== "string" || !p.imageGenerationPrompt.trim() || typeof p.videoMotionPrompt !== "string" || !p.videoMotionPrompt.trim() || typeof p.reason !== "string" || !Array.isArray(p.warnings) || p.warnings.some(w => typeof w !== "string")) throw new Error("模型镜头字段不完整或重复，未应用任何修改");
        seen.add(p.id);
        return p as { id: string; imageGenerationPrompt: string; videoMotionPrompt: string; warnings: string[]; reason: string };
    });
    return shots.map((node, i) => {
        const frame = node.metadata!.frameScriptStoryboard!.frames[0];
        const p = proposed.find(p => p.id === frame.id)!;
        const current = frameScriptFinalContent(frame);
        const warnings = [...assignment[i].warnings, ...p.warnings];
        const changes = { dialogue: assignment[i].dialogue, imageGenerationPrompt: p.imageGenerationPrompt, videoMotionPrompt: p.videoMotionPrompt };
        for (const key of ["dialogue", "imageGenerationPrompt", "videoMotionPrompt"] as const) {
            if (frame.lockedFields?.includes(key) && changes[key] !== current[key]) {
                warnings.push(`${key === "dialogue" ? "台词" : key === "imageGenerationPrompt" ? "图片提示词" : "视频动作"}已锁定，本次保留；请核对与新文案是否冲突`);
                changes[key] = current[key];
            }
        }
        return { nodeId: node.id, frameId: frame.id, snapshot: JSON.stringify(frame), ...changes, warnings, reason: p.reason };
    });
}
