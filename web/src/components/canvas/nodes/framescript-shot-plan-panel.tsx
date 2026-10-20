import { useEffect, useRef, useState } from "react";
import { App } from "antd";
import { LoaderCircle } from "lucide-react";
import type { CanvasNodeData } from "@/types/canvas";
import { AppModal } from "@/components/ui/product/app-modal";
import { frameScriptFinalContent } from "@/lib/framescript-video-review/storyboard-content";
import { prepareFrameScriptShotPlan, type ShotPlan } from "@/services/framescript-shot-plan";
import { useCanvasNodes } from "../canvas-node-graph-context";
import { useCanvasNodeActions } from "../canvas-node-action-context";

export function FrameScriptShotPlanPanel({ node }: { node: CanvasNodeData }) {
    const nodes = useCanvasNodes();
    const { updateNode } = useCanvasNodeActions();
    const { message } = App.useApp();
    const sourceId = node.metadata?.frameScriptStoryboard?.sourceNodeId;
    const sources = nodes.filter(n => n.metadata?.frameScriptTranscriptSourceNodeId === sourceId);
    const [textId, setTextId] = useState("");
    const [pending, setPending] = useState(false);
    const [plan, setPlan] = useState<ShotPlan[] | null>(null);
    const [sourceSnapshot, setSourceSnapshot] = useState("");
    const [acknowledged, setAcknowledged] = useState(false);
    const [error, setError] = useState("");
    const controller = useRef<AbortController | null>(null);
    useEffect(() => () => controller.current?.abort(), []);
    const text = sources.find(n => n.id === textId);
    const generate = async () => {
        const content = text?.metadata?.content?.trim();
        if (!content) { message.warning("请先输出改写文案并选择文案节点"); return; }
        const model = nodes.find(n => n.id === sourceId)?.metadata?.framescriptVideoReview?.transcriptRewriteModel;
        if (!model) { message.warning("请先在视频拆解中选择文字模型"); return; }
        const shots = nodes.filter(n => n.metadata?.frameScriptStoryboard?.sourceNodeId === sourceId && n.metadata?.frameScriptStoryboard?.presentation === "single-shot").sort((a, b) => a.metadata!.frameScriptStoryboard!.frames[0].timeMs - b.metadata!.frameScriptStoryboard!.frames[0].timeMs);
        setPending(true); setError(""); setAcknowledged(false);
        const abort = new AbortController(); controller.current = abort;
        try {
            const result = await prepareFrameScriptShotPlan(shots, content, model, nodes, abort.signal);
            if (!abort.signal.aborted) { setSourceSnapshot(content); setPlan(result); }
        } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "匹配失败"); }
        finally { if (!abort.signal.aborted) setPending(false); }
    };
    const apply = () => {
        if (!plan || !updateNode) return;
        if (text?.metadata?.content?.trim() !== sourceSnapshot || plan.some(p => JSON.stringify(nodes.find(n => n.id === p.nodeId)?.metadata?.frameScriptStoryboard?.frames.find(f => f.id === p.frameId)) !== p.snapshot)) {
            setError("文案或镜头已变化，请重新生成合并预览"); setPlan(null); return;
        }
        const createdAt = new Date().toISOString();
        for (const p of plan) updateNode(p.nodeId, current => {
            const state = current.metadata?.frameScriptStoryboard;
            if (!state) return current;
            return { ...current, metadata: { ...current.metadata, frameScriptStoryboard: { ...state, updatedAt: createdAt, frames: state.frames.map(f => {
                if (f.id !== p.frameId || JSON.stringify(f) !== p.snapshot) return f;
                return { ...f, dialogue: p.dialogue, imageGenerationPrompt: p.imageGenerationPrompt, videoMotionPrompt: p.videoMotionPrompt, adaptation: { sourceTextNodeId: textId, sourceText: sourceSnapshot, reason: p.reason, warnings: p.warnings, appliedAt: createdAt }, creativeHistory: [...(f.creativeHistory || []), { ...frameScriptFinalContent(f), durationSeconds: f.durationSeconds, createdAt }] };
            }) } } };
        });
        setPlan(null); message.success("已应用到本次复刻镜头，原始反推保持不变");
    };
    return <section className="w-full">
        <div className="flex h-10 min-w-0 items-center gap-2 rounded-xl border border-[#a394ff]/20 bg-white/[0.02] px-2">
            <span className="flex h-full shrink-0 items-center self-center leading-none text-base font-bold">接入改写文案</span>
            <select aria-label="选择改写文案" disabled={pending} value={textId} onChange={e => setTextId(e.target.value)} className="h-full min-w-0 flex-1 rounded-lg border border-white/20 bg-[#181a26] px-2 text-sm"><option value="">选择已输出的改写文案</option>{sources.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select>
            <button type="button" disabled={pending || !textId} className="inline-flex h-full shrink-0 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[#684fff] to-[#2477f2] px-4 text-base font-bold text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50" onClick={() => void generate()}>{pending ? <LoaderCircle size={14} className="animate-spin" /> : null}{pending ? "正在匹配" : "生成合并预览"}</button>
            {pending ? <button className="shrink-0 text-xs" onClick={() => { controller.current?.abort(); setPending(false); }}>取消</button> : null}
        </div>
        {error ? <p role="alert" className="mt-2 text-sm text-amber-200">{error}</p> : null}
        {node.metadata?.frameScriptStoryboard?.frames[0].adaptation ? <p className="mt-2 text-xs text-white/50">本镜改编：{node.metadata.frameScriptStoryboard.frames[0].adaptation.reason}</p> : null}
        <AppModal open={Boolean(plan)} onCancel={() => setPlan(null)} title="文案与镜头合并预览" footer={null} width={1000}>
            <div className="max-h-[65vh] space-y-3 overflow-y-auto">{plan?.map((p, i) => <section key={p.nodeId} className="rounded-lg border border-white/15 p-3"><h3 className="font-semibold">镜头 {i + 1}</h3><p className="my-2 text-sm text-white/55">{p.reason}</p><label className="text-sm">本镜台词<textarea aria-label={`镜头 ${i + 1} 合并台词`} readOnly={nodes.find(n => n.id === p.nodeId)?.metadata?.frameScriptStoryboard?.frames[0].lockedFields?.includes("dialogue")} value={p.dialogue} onChange={e => setPlan(current => current?.map(item => item.nodeId === p.nodeId ? { ...item, dialogue: e.target.value } : item) || null)} className="mt-1 min-h-16 w-full rounded border border-white/15 bg-transparent p-2" /></label><p className="my-2 text-sm">图片提示词：{p.imageGenerationPrompt}</p><p className="text-sm">视频动作：{p.videoMotionPrompt}</p>{p.warnings.map((w, index) => <p key={index} className="mt-1 text-sm text-amber-200">{w}</p>)}</section>)}</div>
            {plan?.some(p => p.warnings.length) ? <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />已核对上述冲突，接受当前方案；需要补镜头的内容稍后处理</label> : null}
            <div className="mt-4 flex justify-end"><button disabled={Boolean(plan?.some(p => p.warnings.length) && !acknowledged)} onClick={apply} className="rounded-lg bg-[#684fff] px-5 py-2 text-white disabled:opacity-40">确认应用到这些镜头</button></div>
        </AppModal>
    </section>;
}
