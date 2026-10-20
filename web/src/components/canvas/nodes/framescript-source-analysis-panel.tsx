import { useMemo, useState } from "react";
import { Modal } from "antd";
import type { FrameScriptCreativeContent, FrameScriptOriginalAnalysis, FrameScriptReplacementSetting, FrameScriptStoryboardNodeState } from "@/lib/framescript-video-review/contracts";
import { applyFrameScriptReplacement, frameScriptFinalContent, frameScriptLatestOriginalAnalysis, sameFrameScriptOriginalAnalysis, type FrameScriptReplacementScope } from "@/lib/framescript-video-review/storyboard-content";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type Props = {
    state: FrameScriptStoryboardNodeState;
    nodes: CanvasNodeData[];
    onClose: () => void;
    onApply: (frameId: string, analysis: FrameScriptOriginalAnalysis) => void;
    onApplyReplacement: (setting: FrameScriptReplacementSetting, frameIds: readonly string[]) => void;
};

export function FrameScriptSourceAnalysisPanel({ state, nodes, onClose, onApply, onApplyReplacement }: Props) {
    const [frameId, setFrameId] = useState(state.frames[0]?.id ?? "");
    const [previewLatest, setPreviewLatest] = useState(false);
    const [replacementKind, setReplacementKind] = useState<FrameScriptReplacementSetting["kind"]>("product");
    const [originalDescription, setOriginalDescription] = useState("");
    const [replacementDescription, setReplacementDescription] = useState("");
    const [replacementScope, setReplacementScope] = useState<FrameScriptReplacementScope>("current");
    const [selectedFrameIds, setSelectedFrameIds] = useState<string[]>(state.frames[0]?.id ? [state.frames[0].id] : []);
    const [selectedReferenceNodeIds, setSelectedReferenceNodeIds] = useState<string[]>([]);
    const [replacementPreview, setReplacementPreview] = useState(false);
    const frame = state.frames.find((item) => item.id === frameId) ?? state.frames[0];
    const review = nodes.find((node) => node.id === state.sourceNodeId)?.metadata?.framescriptVideoReview;
    const candidate = frame ? frameScriptLatestOriginalAnalysis(state, frame, review) : undefined;
    const hasNewAnalysis = Boolean(candidate && !sameFrameScriptOriginalAnalysis(frame?.originalAnalysis, candidate));
    const displayedAnalysis = previewLatest && hasNewAnalysis ? candidate : frame?.originalAnalysis;
    const targetFrameIds = replacementScope === "all" ? state.frames.map((item) => item.id) : replacementScope === "selected" ? selectedFrameIds : frame ? [frame.id] : [];
    const excludedTargetAssetIds = useMemo(() => new Set(state.frames.filter((item) => targetFrameIds.includes(item.id)).flatMap((item) => [item.imageNodeId, item.imageGenerationNodeId].filter((id): id is string => Boolean(id)))), [state.frames, targetFrameIds.join("|")]);
    const assetOptions = useMemo(() => nodes.filter((node) => !excludedTargetAssetIds.has(node.id) && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Drawing || node.metadata?.workflowKind === "character")), [excludedTargetAssetIds, nodes]);
    const replacementSetting: FrameScriptReplacementSetting = {
        id: "replacement-preview",
        kind: replacementKind,
        originalDescription,
        replacementDescription,
        referenceNodeIds: selectedReferenceNodeIds,
    };
    const previewFrame = frame && replacementPreview && replacementDescription.trim() ? applyFrameScriptReplacement(frame, replacementSetting) : frame;
    return <Modal open onCancel={onClose} title="原片对照" footer={null} width="min(1040px, calc(100vw - 32px))" centered getContainer={() => (document.fullscreenElement as HTMLElement) || document.body}>
        <div data-canvas-no-zoom data-canvas-wheel-scroll onPointerDown={(event) => event.stopPropagation()}>
            <div className="mb-4 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm">选择镜头
                    <select aria-label="原片对照镜头" value={frame?.id ?? ""} onChange={(event) => { setFrameId(event.target.value); setPreviewLatest(false); }} className="rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-[var(--foreground)]">
                        {state.frames.map((item) => <option key={item.id} value={item.id}>镜头 {item.index}</option>)}
                    </select>
                </label>
                <span className="text-xs text-[var(--muted-foreground)]">左侧保留原片分析，右侧是实际用于生成的创作内容。</span>
            </div>
            {frame ? <div className="max-h-[65vh] overflow-y-auto">
                <div className="grid gap-4 md:grid-cols-2">
                    <section className="rounded-lg border border-[var(--border)] p-4">
                        <h3 className="mb-3 text-sm font-semibold">{previewLatest && hasNewAnalysis ? "本次分析 · 待应用" : "已保存的原始分析"}</h3>
                        {displayedAnalysis ? <AnalysisFields content={displayedAnalysis} description={displayedAnalysis.description} /> : <p className="text-sm text-[var(--muted-foreground)]">此分镜尚未保存原始分析快照。可预览来源视频的分析结果，再保存为原始分析。</p>}
                        {hasNewAnalysis ? <div className="mt-4 border-t border-[var(--border)] pt-3">
                            <p className="mb-2 text-xs text-[var(--muted-foreground)]">来源视频有可应用的分析结果。应用后保留历史原始分析和你的创作内容。</p>
                            {previewLatest ? <div className="flex flex-wrap gap-3">
                                <button type="button" className="rounded border border-[var(--border)] px-3 py-1.5 text-xs" onClick={() => { if (candidate) onApply(frame.id, candidate); setPreviewLatest(false); }}>{frame.originalAnalysis ? "应用为原始分析" : "保存为原始分析"}</button>
                                <button type="button" className="text-xs text-[var(--muted-foreground)]" onClick={() => setPreviewLatest(false)}>返回已保存分析</button>
                            </div> : <button type="button" className="rounded border border-[var(--border)] px-3 py-1.5 text-xs" onClick={() => setPreviewLatest(true)}>预览本次分析</button>}
                        </div> : null}
                    </section>
                    <section className="rounded-lg border border-[var(--border)] p-4">
                        <h3 className="mb-3 text-sm font-semibold">最终创作内容</h3>
                        <AnalysisFields content={frameScriptFinalContent(frame)} />
                        <p className="mt-3 text-xs text-[var(--muted-foreground)]">可在分镜表中编辑，图片和视频生成分别读取对应提示词。</p>
                        <h4 className="mb-2 mt-4 text-xs font-semibold">替换设定</h4>
                        {frame.replacementSettings?.length ? frame.replacementSettings.map((setting) => <div key={setting.id} className="mb-2 text-xs"><span>{setting.kind === "person" ? "人物" : "产品"}：{setting.originalDescription || "未指定原对象"} → {setting.replacementDescription}</span></div>) : <p className="text-xs text-[var(--muted-foreground)]">尚未保存人物或产品替换设定。</p>}
                    </section>
                </div>
                <section className="mt-4 rounded-lg border border-[var(--border)] p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold">人物 / 产品替换</h3><p className="mt-1 text-xs text-[var(--muted-foreground)]">只修改最终创作提示词，原片分析和历史版本保持不变。</p></div><span className="rounded bg-amber-300/10 px-2 py-1 text-[11px] text-amber-200">预览后确认应用</span></div>
                    <div className="grid gap-3 md:grid-cols-2">
                        <label className="text-xs">替换类型<select aria-label="替换类型" value={replacementKind} onChange={(event) => setReplacementKind(event.target.value as FrameScriptReplacementSetting["kind"])} className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[var(--foreground)]"><option value="person">人物</option><option value="product">产品</option></select></label>
                        <label className="text-xs">原对象（可选，填写后按原文替换）<input aria-label="原对象" value={originalDescription} onChange={(event) => setOriginalDescription(event.target.value)} placeholder="例如：红色礼盒" className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[var(--foreground)]" /></label>
                        <label className="text-xs md:col-span-2">替换为<input aria-label="替换内容" value={replacementDescription} onChange={(event) => setReplacementDescription(event.target.value)} placeholder="例如：我的产品" className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[var(--foreground)]" /></label>
                        <label className="text-xs">应用范围<select aria-label="替换应用范围" value={replacementScope} onChange={(event) => setReplacementScope(event.target.value as FrameScriptReplacementScope)} className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[var(--foreground)]"><option value="current">当前镜头</option><option value="selected">选定镜头</option><option value="all">全部镜头</option></select></label>
                        <div className="text-xs"><span>参考资产（可选）</span><div className="mt-1 flex max-h-24 flex-wrap gap-2 overflow-y-auto rounded border border-[var(--border)] p-2">{assetOptions.length ? assetOptions.map((asset) => <label key={asset.id} className="flex items-center gap-1 text-[var(--muted-foreground)]"><input type="checkbox" checked={selectedReferenceNodeIds.includes(asset.id)} onChange={(event) => setSelectedReferenceNodeIds((current) => event.target.checked ? [...current, asset.id] : current.filter((id) => id !== asset.id))} />{asset.title || asset.id}</label>) : <span className="text-[var(--muted-foreground)]">画布中暂无图片、绘图或人物资产</span>}</div></div>
                    </div>
                    {replacementScope === "selected" ? <div className="mt-3 flex flex-wrap gap-2 text-xs">{state.frames.map((item) => <label key={item.id} className="flex items-center gap-1"><input type="checkbox" checked={selectedFrameIds.includes(item.id)} onChange={(event) => setSelectedFrameIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />镜头 {item.index}</label>)}</div> : null}
                    {replacementPreview && previewFrame ? <div className="mt-3 rounded border border-cyan-300/30 bg-cyan-300/5 p-3 text-xs"><div className="mb-1 font-semibold text-cyan-200">预览：镜头 {previewFrame.index}</div><div className="whitespace-pre-wrap text-[var(--muted-foreground)]">图片提示词：{frameScriptFinalContent(previewFrame).imageGenerationPrompt || "—"}</div><div className="mt-2 whitespace-pre-wrap text-[var(--muted-foreground)]">视频提示词：{frameScriptFinalContent(previewFrame).videoMotionPrompt || "—"}</div></div> : null}
                    <div className="mt-3 flex flex-wrap gap-2"><button type="button" className="rounded border border-[var(--border)] px-3 py-1.5 text-xs" onClick={() => setReplacementPreview(true)} disabled={!replacementDescription.trim() || !targetFrameIds.length}>预览替换</button><button type="button" className="rounded bg-cyan-300 px-3 py-1.5 text-xs font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40" disabled={!replacementPreview || !replacementDescription.trim() || !targetFrameIds.length} onClick={() => { onApplyReplacement({ ...replacementSetting, id: `replacement-${Date.now()}` }, targetFrameIds); setReplacementPreview(false); }}>确认应用到 {targetFrameIds.length} 个镜头</button></div>
                </section>
                {frame.originalAnalysisHistory?.length ? <details className="mt-4 rounded-lg border border-[var(--border)] p-3">
                    <summary className="cursor-pointer text-xs">历史原始分析（{frame.originalAnalysisHistory.length}）</summary>
                    {frame.originalAnalysisHistory.map((analysis, index) => <div key={index} className="mt-3 border-t border-[var(--border)] pt-3"><h4 className="mb-2 text-xs font-semibold">历史版本 {index + 1}</h4><AnalysisFields content={analysis} description={analysis.description} /></div>)}
                </details> : null}
            </div> : null}
        </div>
    </Modal>;
}

function AnalysisFields({ content, description }: { content: FrameScriptCreativeContent; description?: string }) {
    return <dl className="space-y-3 text-xs leading-5">
        {description !== undefined ? <div><dt className="text-[var(--muted-foreground)]">画面描述</dt><dd className="whitespace-pre-wrap break-words">{description || "—"}</dd></div> : null}
        {([["imageGenerationPrompt", "图片提示词"], ["videoMotionPrompt", "视频提示词"], ["dialogue", "台词 / 旁白"]] as const).map(([key, label]) => <div key={key}><dt className="text-[var(--muted-foreground)]">{label}</dt><dd className="whitespace-pre-wrap break-words">{content[key] || "—"}</dd></div>)}
    </dl>;
}
