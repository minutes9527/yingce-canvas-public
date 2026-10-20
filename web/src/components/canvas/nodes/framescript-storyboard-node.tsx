import { ArrowDownToLine, Clapperboard, Image as ImageIcon, ImagePlus, Minimize2, Scan, Sparkles } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { App } from "antd";

import type { CanvasNodeData } from "@/types/canvas";
import { CanvasNodeType } from "@/types/canvas";
import { FRAMESCRIPT_STORYBOARD_NODE_TYPE, type FrameScriptOriginalAnalysis, type FrameScriptStoryboardNodeState } from "@/lib/framescript-video-review/contracts";
import { applyFrameScriptOriginalAnalysis, applyFrameScriptReplacement, editFrameScriptCreativeContent, frameScriptFinalContent, type FrameScriptCreativeEdit } from "@/lib/framescript-video-review/storyboard-content";
import { FrameScriptSourceAnalysisPanel } from "./framescript-source-analysis-panel";
import { useCanvasConnections, useCanvasNodes } from "../canvas-node-graph-context";
import { useCanvasNodeActions } from "../canvas-node-action-context";
import { resolveMediaUrl } from "@/services/file-storage";
import { FrameScriptShotNodeContent } from "./framescript-shot-node";

export function FrameScriptStoryboardNodeContent({ node, scale = 1, onConnectStart }: { node: CanvasNodeData; scale?: number; onConnectStart?: (event: ReactPointerEvent, nodeId: string, handleType: "source" | "target", handleId?: string, anchorRatio?: number) => void }) {
    if (node.metadata?.frameScriptStoryboard?.presentation === "single-shot") return <FrameScriptShotNodeContent node={node} />;
    return <FrameScriptStoryboardTable node={node} scale={scale} onConnectStart={onConnectStart} />;
}

function FrameScriptStoryboardTable({ node, scale = 1, onConnectStart }: { node: CanvasNodeData; scale?: number; onConnectStart?: (event: ReactPointerEvent, nodeId: string, handleType: "source" | "target", handleId?: string, anchorRatio?: number) => void }) {
    const nodes = useCanvasNodes();
    const connections = useCanvasConnections();
    const { createFrameScriptImageGenerationNodes, updateNode } = useCanvasNodeActions();
    const { message } = App.useApp();
    const state = node.metadata?.frameScriptStoryboard;
    const [draftEdits, setDraftEdits] = useState<Record<string, Partial<EditableFrameFields>>>({});
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showSourceAnalysis, setShowSourceAnalysis] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const tableRef = useRef<HTMLDivElement>(null);
    const imageNodes = new Map(nodes.filter((item) => item.type === CanvasNodeType.Image || item.type === CanvasNodeType.Drawing || item.metadata?.workflowKind === "character").map((item) => [item.id, item]));
    const resourceNode = (id: string | undefined) => {
        const candidate = id ? imageNodes.get(id) : undefined;
        return candidate && (candidate.type === CanvasNodeType.Image || candidate.type === CanvasNodeType.Drawing || candidate.metadata?.workflowKind === "character") ? candidate : undefined;
    };
    const collectReferenceNodeIds = (startIds: readonly string[]) => {
        const found: string[] = [];
        const visited = new Set<string>();
        const queue = [...startIds];
        while (queue.length) {
            const upstreamId = queue.shift()!;
            if (visited.has(upstreamId)) continue;
            visited.add(upstreamId);
            const upstream = nodes.find((item) => item.id === upstreamId);
            if (!upstream) continue;
            if (upstream.type === CanvasNodeType.Image || upstream.type === CanvasNodeType.Drawing || upstream.metadata?.workflowKind === "character") {
                found.push(upstream.id);
                continue;
            }
            connections.filter((connection) => connection.toNodeId === upstream.id).forEach((connection) => queue.push(connection.fromNodeId));
        }
        return found;
    };
    const globalConnectionIds = connections.filter((connection) => connection.toNodeId === node.id && !connection.toHandleId?.startsWith("row:")).map((connection) => connection.fromNodeId);
    const dynamicReferenceNodeIds = collectReferenceNodeIds(globalConnectionIds);
    const rowConnectionIds = new Map<string, string[]>();
    connections.filter((connection) => connection.toNodeId === node.id && connection.toHandleId?.startsWith("row:")).forEach((connection) => {
        const rowId = connection.toHandleId!.slice(4);
        rowConnectionIds.set(rowId, [...(rowConnectionIds.get(rowId) || []), ...collectReferenceNodeIds([connection.fromNodeId])]);
    });
    const referenceNodeIds = Array.from(new Set([...(state?.referenceNodeIds || []), ...dynamicReferenceNodeIds]));
    const primaryReferenceNodeId = referenceNodeIds[0];
    const allReferenceIds = Array.from(new Set([...referenceNodeIds, ...(state?.frames || []).flatMap((frame) => frame.referenceNodeIds || (frame.referenceNodeId ? [frame.referenceNodeId] : [])), ...Array.from(rowConnectionIds.values()).flat()]));
    const [referencePreviews, setReferencePreviews] = useState<Record<string, string>>({});
    useEffect(() => {
        let live = true;
        const load = async () => {
            const entries = await Promise.all(allReferenceIds.map(async (id) => {
                const item = imageNodes.get(id);
                if (!item) return [id, ""] as const;
                const fallback = item.metadata?.content || item.metadata?.previewContent || item.metadata?.characterCoverUrl || "";
                const storageKey = item.metadata?.storageKey;
                if (!storageKey) return [id, fallback] as const;
                try {
                    return [id, await resolveMediaUrl(storageKey, fallback) || fallback] as const;
                } catch {
                    return [id, fallback] as const;
                }
            }));
            if (live) setReferencePreviews(Object.fromEntries(entries));
        };
        void load();
        return () => { live = false; };
    }, [allReferenceIds.join("|"), nodes]);
    const previewSource = (item: CanvasNodeData) => referencePreviews[item.id] || item.metadata?.content || item.metadata?.previewContent || item.metadata?.characterCoverUrl || "";
    const editValue = <K extends keyof EditableFrameFields,>(frame: FrameScriptStoryboardNodeState["frames"][number], field: K): EditableFrameFields[K] => {
        const value = draftEdits[frame.id]?.[field];
        if (value !== undefined) return value as EditableFrameFields[K];
        const content = { ...frameContent(frame), durationSeconds: frame.durationSeconds };
        return content[field];
    };
    const frameContent = (frame: FrameScriptStoryboardNodeState["frames"][number]) => {
        const draft = draftEdits[frame.id];
        return draft ? frameScriptFinalContent(editFrameScriptCreativeContent(frame, draft)) : frameScriptFinalContent(frame);
    };
    const setDraftValue = <K extends keyof EditableFrameFields,>(frameId: string, field: K, value: EditableFrameFields[K]) => {
        setDraftEdits((current) => ({ ...current, [frameId]: { ...current[frameId], [field]: value } }));
    };
    const commitFrameEdit = (frameId: string) => {
        const edit = draftEdits[frameId];
        if (!edit || !state || !updateNode) return;
        updateNode(node.id, (current) => {
            const latest = current.metadata?.frameScriptStoryboard;
            if (!latest) return current;
            return { ...current, metadata: { ...current.metadata, frameScriptStoryboard: {
                ...latest,
                frames: latest.frames.map((frame) => frame.id === frameId ? editFrameScriptCreativeContent(frame, edit) : frame),
                updatedAt: new Date().toISOString(),
            } } };
        });
        setDraftEdits((current) => {
            const next = { ...current };
            delete next[frameId];
            return next;
        });
    };
    const applyOriginalAnalysis = (frameId: string, analysis: FrameScriptOriginalAnalysis) => {
        updateNode?.(node.id, (current) => {
            const latest = current.metadata?.frameScriptStoryboard;
            if (!latest || latest.sourceVideoId !== analysis.sourceVideoId) return current;
            return { ...current, metadata: { ...current.metadata, frameScriptStoryboard: {
                ...latest,
                frames: latest.frames.map((frame) => frame.id === frameId ? applyFrameScriptOriginalAnalysis(frame, analysis) : frame),
                updatedAt: new Date().toISOString(),
            } } };
        });
    };
    const applyReplacement = (setting: Parameters<typeof applyFrameScriptReplacement>[1], frameIds: readonly string[]) => {
        const targetIds = new Set(frameIds);
        updateNode?.(node.id, (current) => {
            const latest = current.metadata?.frameScriptStoryboard;
            if (!latest) return current;
            return { ...current, metadata: { ...current.metadata, frameScriptStoryboard: {
                ...latest,
                frames: latest.frames.map((frame) => targetIds.has(frame.id) ? applyFrameScriptReplacement(frame, setting) : frame),
                updatedAt: new Date().toISOString(),
            } } };
        });
    };
    const syncVideoPrompt = (frame: FrameScriptStoryboardNodeState["frames"][number]) => {
        const draft = draftEdits[frame.id];
        const editedFrame = draft ? editFrameScriptCreativeContent(frame, draft) : frame;
        const prompt = frameScriptFinalContent(editedFrame).videoMotionPrompt.trim();
        if (!prompt || !updateNode) {
            message.warning("当前镜头没有可复用的视频提示词");
            return;
        }
        if (draft) commitFrameEdit(frame.id);
        const targets = nodes.filter((candidate) => candidate.type === CanvasNodeType.Video && (
            (candidate.metadata?.frameScriptStoryboardNodeId === node.id && candidate.metadata?.frameScriptStoryboardFrameId === frame.id)
            || connections.some((connection) => connection.toNodeId === candidate.id && connection.fromNodeId === node.id && connection.fromHandleId === `row:${frame.id}`)
        ));
        targets.forEach((target) => updateNode(target.id, (current) => ({
            ...current,
            title: `镜头 ${frame.index} · 视频`,
            metadata: {
                ...current.metadata,
                prompt,
                composerContent: prompt,
                frameScriptStoryboardNodeId: node.id,
                frameScriptStoryboardFrameId: frame.id,
                frameScriptStoryboardVideoPrompt: prompt,
                generationMode: "video" as const,
                videoEditOperation: current.metadata?.videoEditOperation || "image_to_video",
                workflowKind: "shot" as const,
                workflowTitle: `镜头 ${frame.index} 视频`,
                shotIndex: frame.index,
                seconds: String(frame.durationSeconds),
            },
        })));
        if (targets.length) message.success(`已同步到 ${targets.length} 个视频生成节点`);
        else message.info("当前镜头尚未连接视频生成节点");
    };
    useEffect(() => {
        const syncFullscreen = () => setIsFullscreen(typeof document !== "undefined" && document.fullscreenElement === rootRef.current);
        document.addEventListener("fullscreenchange", syncFullscreen);
        return () => document.removeEventListener("fullscreenchange", syncFullscreen);
    }, []);
    useEffect(() => {
        if (!updateNode || isFullscreen || !tableRef.current) return;
        const syncHeight = () => {
            const measured = tableRef.current?.scrollHeight || 0;
            const desired = Math.max(420, Math.min(1400, measured + 54));
            if (Math.abs((node.height || 0) - desired) < 4) return;
            updateNode(node.id, (current) => current.height === desired ? current : { ...current, height: desired });
        };
        const observer = new ResizeObserver(syncHeight);
        observer.observe(tableRef.current);
        syncHeight();
        return () => observer.disconnect();
    }, [isFullscreen, node.height, node.id, state?.updatedAt, updateNode]);
    const toggleFullscreen = async () => {
        if (!rootRef.current || typeof document === "undefined") return;
        try {
            if (document.fullscreenElement === rootRef.current) await document.exitFullscreen();
            else if (isFullscreen) setIsFullscreen(false);
            else await rootRef.current.requestFullscreen();
        } catch {
            // Embedded previews may deny the native API; use a CSS fullscreen fallback.
            setIsFullscreen(true);
        }
    };
    if (!state || node.type !== FRAMESCRIPT_STORYBOARD_NODE_TYPE) {
        return <div className="flex h-full items-center justify-center p-4 text-xs text-white/45">等待 FrameScript 分镜结果</div>;
    }
    return <div ref={rootRef} className={`relative flex h-full min-h-0 flex-col overflow-hidden bg-[#111315] p-3 pt-9 text-white ${isFullscreen ? "fixed inset-0 z-[9999] w-screen rounded-none p-6" : ""}`}>
        <div className="flex items-center gap-2 border-b border-white/10 pb-2">
            <span className="grid size-6 place-items-center rounded-md bg-cyan-400/12 text-cyan-300"><Clapperboard className="size-3.5" /></span>
            <div className="min-w-0 flex-1"><div className="truncate text-[12px] font-semibold">FrameScript 分镜复刻</div><div className="text-[10px] text-white/40">{state.frames.length} 个确认镜头 · 轻量结果</div></div>
            {createFrameScriptImageGenerationNodes ? <button type="button" className="inline-flex h-7 items-center gap-1 rounded-md border border-cyan-300/35 px-2 text-[10px] font-semibold text-cyan-200 hover:bg-cyan-300/10" onClick={() => void createFrameScriptImageGenerationNodes(node)}><ImagePlus className="size-3" />导入图片生成</button> : null}
            <button type="button" aria-label={isFullscreen ? "退出全屏" : "全屏展示"} title={isFullscreen ? "退出全屏" : "全屏展示"} className="inline-flex size-7 items-center justify-center rounded-md border border-white/15 text-white/65 hover:bg-white/10 hover:text-white" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void toggleFullscreen(); }}>{isFullscreen ? <Minimize2 className="size-3.5" /> : <Scan className="size-3.5" />}</button>
            <button type="button" className="inline-flex h-7 items-center rounded-md border border-white/15 px-2 text-[10px] text-white/70 hover:bg-white/10" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setShowSourceAnalysis(true); }}>原片对照</button>
            <Sparkles className="size-3.5 text-cyan-300/80" />
        </div>
        <div ref={tableRef} className="mt-2 min-h-0 flex-none overflow-x-auto overflow-y-hidden rounded-lg border border-white/10 text-[10px]">
            <div className="grid min-w-0 grid-cols-[40px_34px_54px_minmax(190px,1.15fr)_minmax(160px,1fr)_minmax(110px,0.8fr)_188px_40px] border-b border-white/10 bg-white/[0.04] px-2 py-1.5 text-white/45"><span aria-hidden="true" /><span>序号</span><span>时长</span><span>图片提示词</span><span>视频提示词</span><span>台词/旁白</span><span>参考帧 / 资产</span><span aria-hidden="true" /></div>
            {state.frames.map((frame) => {
                const image = frame.imageNodeId ? imageNodes.get(frame.imageNodeId) : undefined;
                const imageUrl = image?.metadata?.content || "";
                const rowConnectionReferenceIds = rowConnectionIds.get(frame.id) || [];
                const rowReferenceIds = Array.from(new Set([...(frame.referenceNodeIds || []), ...(frame.referenceNodeId ? [frame.referenceNodeId] : []), ...rowConnectionReferenceIds, primaryReferenceNodeId].filter((id): id is string => Boolean(id))));
                const rowReferenceNodes = rowReferenceIds.map((id) => resourceNode(id)).filter((item): item is CanvasNodeData => Boolean(item));
                return <div key={frame.id} data-framescript-row-id={frame.id} className="grid min-w-0 grid-cols-[40px_34px_54px_minmax(190px,1.15fr)_minmax(160px,1fr)_minmax(110px,0.8fr)_188px_40px] items-center gap-1 border-b border-white/[0.06] px-2 py-1.5 last:border-b-0"><FrameScriptRowHandle nodeId={node.id} handleId={`row:${frame.id}`} side="left" scale={scale} title={`镜头 ${frame.index} 前置素材输入`} onPointerDown={(event) => onConnectStart?.(event, node.id, "target", `row:${frame.id}`, canvasAnchorRatio(event))} /><span className="text-white/65">{frame.index}</span><input type="number" min={1} step={1} aria-label={`镜头 ${frame.index} 时长`} value={editValue(frame, "durationSeconds") ?? 1} className="h-7 w-full rounded border border-transparent bg-transparent px-1 text-white/70 outline-none hover:border-white/15 focus:border-cyan-300/60 focus:bg-black/20" onPointerDown={(event) => event.stopPropagation()} onChange={(event) => setDraftValue(frame.id, "durationSeconds", Math.max(1, Number(event.target.value) || 1))} onBlur={() => commitFrameEdit(frame.id)} /><EditableFrameCell ariaLabel={`镜头 ${frame.index} 图片提示词`} value={editValue(frame, "imageGenerationPrompt") ?? ""} tone="cyan" onChange={(value) => setDraftValue(frame.id, "imageGenerationPrompt", value)} onBlur={() => commitFrameEdit(frame.id)} /><div className="relative min-w-0"><EditableFrameCell ariaLabel={`镜头 ${frame.index} 视频提示词`} value={editValue(frame, "videoMotionPrompt") ?? ""} onChange={(value) => setDraftValue(frame.id, "videoMotionPrompt", value)} onBlur={() => commitFrameEdit(frame.id)} /><button type="button" aria-label={`镜头 ${frame.index} 同步视频提示词`} title="复用到视频生成窗口" className="absolute right-0 top-0 inline-flex size-5 items-center justify-center rounded border border-cyan-300/30 bg-[#111315] text-cyan-200 hover:bg-cyan-300/10 disabled:opacity-35" disabled={!frameContent(frame).videoMotionPrompt.trim()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); syncVideoPrompt(frame); }}><ArrowDownToLine className="size-3" /></button></div><EditableFrameCell ariaLabel={`镜头 ${frame.index} 台词旁白`} value={editValue(frame, "dialogue") || ""} onChange={(value) => setDraftValue(frame.id, "dialogue", value)} onBlur={() => commitFrameEdit(frame.id)} /><span className="flex min-w-0 items-center gap-1.5 text-white/45"><span className="relative shrink-0">{imageUrl ? <HoverPreviewImage src={imageUrl} alt={`分镜 ${frame.index}`} className="size-9 rounded object-cover" /> : <span className="grid size-9 place-items-center rounded bg-white/[0.06]"><ImageIcon className="size-3" /></span>}<span className="absolute -bottom-1 -right-1 rounded bg-black/80 px-1 text-[8px] text-white/70">原帧</span></span><span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">{rowReferenceNodes.map((reference) => <HoverPreviewImage key={reference.id} src={previewSource(reference)} alt={reference.title} className="size-8 shrink-0 rounded object-cover" />)}<span className="truncate">{rowReferenceNodes.length ? rowReferenceNodes[0].title : image?.title || "未接入前置素材"}</span></span>{createFrameScriptImageGenerationNodes ? <button type="button" className="inline-flex size-6 shrink-0 items-center justify-center rounded border border-white/15 text-cyan-200 hover:bg-cyan-300/10" title={frame.imageNodeId ? "定位/复用图片生成节点" : "导入图片生成"} onPointerDownCapture={(event) => event.stopPropagation()} onMouseDownCapture={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void createFrameScriptImageGenerationNodes(node, frame.id); }}><ImagePlus className="size-3" /></button> : null}</span><FrameScriptRowHandle nodeId={node.id} handleId={`row:${frame.id}`} side="right" scale={scale} title={`镜头 ${frame.index} 图片生成输出`} onPointerDown={(event) => onConnectStart?.(event, node.id, "source", `row:${frame.id}`, canvasAnchorRatio(event))} /></div>;
            })}
        </div>
        <div className="flex items-center justify-between gap-3 pt-2 text-[10px] text-white/35"><span>表格保存最终创作内容，失焦后自动保存。视频提示词可用右侧箭头复用到已连接的视频生成窗口；原片分析可在“原片对照”中查看。</span><span className="shrink-0">每行一个生成锚点 · 创建后手动点击图片节点生成</span></div>
        {showSourceAnalysis ? <FrameScriptSourceAnalysisPanel state={state} nodes={nodes} onClose={() => setShowSourceAnalysis(false)} onApply={applyOriginalAnalysis} onApplyReplacement={applyReplacement} /> : null}
    </div>;
}

type EditableFrameFields = FrameScriptCreativeEdit;

function HoverPreviewImage({ src, alt, className }: { src: string; alt: string; className: string }) {
    const [preview, setPreview] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
    if (!src) return null;
    const showPreview = (event: React.MouseEvent<HTMLSpanElement>) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        setPreview({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height });
    };
    const previewWidth = 240;
    const previewHeight = 280;
    const previewLeft = preview ? Math.min(Math.max(8, preview.left - 4), Math.max(8, window.innerWidth - previewWidth - 8)) : 0;
    const previewTop = preview ? (preview.top > previewHeight + 16 ? preview.top - previewHeight - 8 : Math.min(window.innerHeight - previewHeight - 8, preview.top + preview.height + 8)) : 0;
    return <>
        <span className="relative inline-flex shrink-0" onMouseEnter={showPreview} onMouseLeave={() => setPreview(null)}>
            <img src={src} alt={alt} title={alt} className={className} />
        </span>
        {preview && typeof document !== "undefined" ? createPortal(<div className="pointer-events-none fixed z-[1000] overflow-hidden rounded-lg border border-cyan-300/60 bg-black/90 p-1 shadow-2xl" style={{ left: previewLeft, top: previewTop, width: previewWidth, height: previewHeight }}><img src={src} alt="" className="block size-full object-contain" /></div>, document.body) : null}
    </>;
}

function EditableFrameCell({ ariaLabel, value, tone = "default", onChange, onBlur }: { ariaLabel: string; value: string; tone?: "default" | "cyan" | "amber"; onChange: (value: string) => void; onBlur: () => void }) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    useLayoutEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.style.height = "0px";
        textarea.style.height = `${Math.max(textarea.scrollHeight, 48)}px`;
    }, [value]);
    return <textarea ref={textareaRef} aria-label={ariaLabel} value={value} placeholder="—" rows={1} style={{ overflowY: "hidden", scrollbarWidth: "none" }} className={`min-h-12 w-full resize-none appearance-none overflow-hidden rounded border border-transparent bg-transparent px-1 py-1 text-[10px] leading-4 outline-none [scrollbar-width:none] [&::-webkit-resizer]:hidden [&::-webkit-scrollbar]:hidden hover:border-white/15 focus:border-cyan-300/60 focus:bg-black/20 ${tone === "cyan" ? "text-cyan-100/80" : tone === "amber" ? "text-amber-200/70" : "text-white/70"}`} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => onChange(event.target.value)} onBlur={onBlur} />;
}

function canvasAnchorRatio(event: ReactPointerEvent<HTMLButtonElement>) {
    const shell = event.currentTarget.closest<HTMLElement>(".canvas-node-shell");
    const bounds = shell?.getBoundingClientRect();
    if (!bounds || bounds.height <= 0) return 0.5;
    const handleBounds = event.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (handleBounds.top + handleBounds.height / 2 - bounds.top) / bounds.height));
}

function FrameScriptRowHandle({ nodeId, handleId, side, scale, title, onPointerDown }: { nodeId: string; handleId: string; side: "left" | "right"; scale: number; title: string; onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void }) {
    const hitSize = Math.max(36, 44 / Math.max(scale, 0.05));
    return <button type="button" data-canvas-no-zoom data-canvas-row-handle="true" data-canvas-node-id={nodeId} data-canvas-handle-id={handleId} data-canvas-handle-side={side} aria-label={title} title={title} className="canvas-connection-handle relative z-[var(--node-z-handle)] flex shrink-0 cursor-pointer touch-none items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/80" style={{ width: hitSize, height: hitSize }} onPointerDown={onPointerDown}><span className="block size-3 rounded-full border-2 border-[#111315] bg-cyan-300 shadow-[0_0_0_2px_rgba(103,232,249,.22)] transition-transform hover:scale-125" /></button>;
}
