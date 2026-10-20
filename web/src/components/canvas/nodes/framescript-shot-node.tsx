import { useEffect, useMemo, useRef, useState } from "react";
import { App, Popover } from "antd";
import { Clapperboard, Copy, LockKeyhole, Unlock, X, ImagePlus, Scan, History } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { AssetLibraryPickerModal, type AssetLibraryPickerItem } from "@/components/assets/asset-library-picker-modal";
import { ASSET_CATEGORY_LABELS, normalizeAssetCategory } from "@/lib/asset-category";
import { useAssetStore, type ImageAsset } from "@/stores/use-asset-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { ModelPicker } from "@/components/model-picker";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { FrameScriptCreativeContent } from "@/lib/framescript-video-review/contracts";
import { frameScriptNodeDisplayTitle } from "@/lib/framescript-video-review/node-title";
import { FRAMESCRIPT_DEFAULT_GENERATION_SECONDS, frameScriptFinalContent, isLegacyFrameScriptSourceDuration, type FrameScriptStoryboardFrame } from "@/lib/framescript-video-review/storyboard-content";
import { resolveMediaUrl } from "@/services/file-storage";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { useCanvasNodes } from "../canvas-node-graph-context";
import { useCanvasNodeActions } from "../canvas-node-action-context";
import { CanvasResourceMentionTextarea } from "../canvas-resource-mention-textarea";
import { FrameScriptShotPlanPanel } from "./framescript-shot-plan-panel";

const assets = { person: "人物", scene: "场景", product: "产品", prop: "互动道具" } as const;
const panel = "rounded-xl border border-[#a394ff]/20 bg-white/[0.02] p-4";
const button = "inline-flex h-8 items-center justify-center gap-2 rounded-lg border border-[#a394ff]/30 px-3 text-sm text-white/80 hover:bg-white/5 disabled:opacity-40";
const fields = { dialogue: "本镜台词", imageGenerationPrompt: "图片提示词", videoMotionPrompt: "视频动作" } as const;
type MentionImage = { id: string; label: string; title: string; category: string; token: string; previewUrl?: string };

function FrameScriptMentionTextarea({ initialValue, label, readOnly, references, onSave, onDraftChange, className = "min-h-20 w-full resize-y rounded-lg border border-white/15 bg-black/15 p-3 text-sm leading-6 outline-none focus:border-[#a394ff] read-only:opacity-60" }: { initialValue: string; label: string; readOnly: boolean; references: MentionImage[]; onSave: (value: string) => void; onDraftChange?: (value: string) => void; className?: string }) {
    const [value, setValue] = useState(initialValue);
    const mentionReferences = useMemo<CanvasResourceReference[]>(() => references.map(reference => ({
        id: reference.id,
        nodeId: reference.token.startsWith("@[asset:") ? `asset:${reference.id.replace(/^asset:/, "")}` : reference.id,
        kind: "image",
        label: reference.label,
        title: `${reference.category} · ${reference.title}`,
        previewUrl: reference.previewUrl,
        active: true,
        mentionToken: reference.token,
        ...(reference.token.startsWith("@[asset:") ? { assetId: reference.id.replace(/^asset:/, "") } : {}),
    })), [references]);
    return <CanvasResourceMentionTextarea
        value={value}
        references={mentionReferences}
        onChange={(next) => { setValue(next); onDraftChange?.(next); }}
        onBlur={() => onSave(value)}
        readOnly={readOnly}
        aria-label={label}
        placeholder={references.length ? "输入 @ 选择已接入的参考图片" : "请先在接入资产中选择图片"}
        sendOnEnter={false}
        className={className}
        containerClassName={className.includes("55vh") ? "h-[55vh]" : "h-20"}
    />;
}

export function FrameScriptShotNodeContent({ node }: { node: CanvasNodeData }) {
    const nodes = useCanvasNodes();
    const allAssets = useAssetStore(state => state.assets);
    const modelConfig = useEffectiveConfig();
    const libraryAssets = useMemo(() => allAssets.filter((asset): asset is ImageAsset => asset.kind === "image" && asset.status !== "archived"), [allAssets]);
    const actions = useCanvasNodeActions();
    const { message } = App.useApp();
    const state = node.metadata?.frameScriptStoryboard;
    const frame = state?.frames[0];
    const draftPromptsRef = useRef<{ frameId?: string; imageGenerationPrompt?: string; videoMotionPrompt?: string }>({});
    const open = actions.activeFrameScriptShotId === node.id;
    const [sourceView, setSourceView] = useState(false);
    const [assetPickerCategory, setAssetPickerCategory] = useState<keyof typeof assets | null>(null);
    const [hoveredAssetCategory, setHoveredAssetCategory] = useState<keyof typeof assets | null>(null);
    const [assetPageIndexes, setAssetPageIndexes] = useState<Record<keyof typeof assets, number>>({ person: 0, scene: 0, product: 0, prop: 0 });
    const [expanded, setExpanded] = useState<keyof FrameScriptCreativeContent | null>(null);
    const [preview, setPreview] = useState<Record<string, string>>({});
    const [portrait, setPortrait] = useState(Boolean(frame?.sourceHeight && frame?.sourceWidth && frame.sourceHeight > frame.sourceWidth));
    const source = nodes.find(n => n.id === frame?.imageNodeId);
    const review = nodes.find(n => n.id === state?.sourceNodeId)?.metadata?.framescriptVideoReview;
    const sourceEndMs = review?.breakdown?.analysis.durationMs ?? review?.draft?.durationMs ?? frame?.originalAnalysis?.endMs;
    const legacySourceDuration = frame && isLegacyFrameScriptSourceDuration(frame, sourceEndMs);
    const shownDurationSeconds = legacySourceDuration ? FRAMESCRIPT_DEFAULT_GENERATION_SECONDS : frame?.durationSeconds;
    useEffect(() => {
        if (!frame || !legacySourceDuration) return;
        const previousDuration = frame.durationSeconds;
        actions.updateNode?.(node.id, current => {
            const latest = current.metadata?.frameScriptStoryboard;
            if (!latest) return current;
            return { ...current, metadata: { ...current.metadata, frameScriptStoryboard: {
                ...latest,
                frames: latest.frames.map(item => item.id === frame.id && isLegacyFrameScriptSourceDuration(item, sourceEndMs)
                    ? { ...item, durationSeconds: FRAMESCRIPT_DEFAULT_GENERATION_SECONDS, durationSource: "default" as const } : item),
                updatedAt: new Date().toISOString(),
            } } };
        });
        nodes.filter(candidate => candidate.type === CanvasNodeType.Video
            && candidate.metadata?.frameScriptStoryboardNodeId === node.id
            && candidate.metadata?.frameScriptStoryboardFrameId === frame.id
            && candidate.metadata.seconds === String(previousDuration))
            .forEach(candidate => actions.updateNode?.(candidate.id, current => ({
                ...current, metadata: { ...current.metadata, seconds: String(FRAMESCRIPT_DEFAULT_GENERATION_SECONDS) },
            })));
    }, [legacySourceDuration, frame?.id, frame?.durationSeconds, node.id, nodes, actions.updateNode, sourceEndMs]);
    const generated = nodes.findLast(n => (n.type === CanvasNodeType.Image || n.type === CanvasNodeType.Video) && n.metadata?.frameScriptStoryboardNodeId === node.id && n.metadata.frameScriptStoryboardFrameId === frame?.id);
    const generatedImage = nodes.findLast(n => n.type === CanvasNodeType.Image && n.metadata?.frameScriptStoryboardNodeId === node.id && n.metadata.frameScriptStoryboardFrameId === frame?.id);
    const candidates = nodes.filter(n => (n.type === CanvasNodeType.Image || n.type === CanvasNodeType.Drawing || n.metadata?.workflowKind === "character") && n.id !== frame?.imageNodeId);
    const previewNodes = [...new Map([...(source ? [source] : []), ...candidates, ...nodes.filter(n => (n.type === CanvasNodeType.Video || n.type === CanvasNodeType.Image) && n.metadata?.frameScriptStoryboardNodeId === node.id)].map(n => [n.id, n])).values()];
    const pickerItems: AssetLibraryPickerItem[] = [
        ...candidates.map(n => ({ id: `canvas:${n.id}`, title: n.title || "画布图片", category: "canvas", kindLabel: "画布图片", mediaKind: "image" as const, imageUrl: preview[n.id], imageFit: "contain" as const })),
        ...libraryAssets.map(asset => ({ id: asset.id, title: asset.title, category: normalizeAssetCategory(asset.category), kindLabel: "素材库", mediaKind: "image" as const, asset, imageUrl: asset.coverUrl, imageStorageKey: asset.data.storageKey, imageFit: "contain" as const })),
    ];
    const mentionImages: MentionImage[] = [];
    const seenMentionIds = new Set<string>();
    const addMentionImage = (id: string | undefined, category: string) => {
        if (!id) return;
        const canvasNode = nodes.find(candidate => (candidate.id === id || candidate.metadata?.assetId === id)
            && candidate.type === CanvasNodeType.Image);
        const libraryAsset = libraryAssets.find(asset => asset.id === id || asset.id === canvasNode?.metadata?.assetId);
        if (!canvasNode && !libraryAsset) return;
        const canonicalId = canvasNode?.id || `asset:${id}`;
        if (seenMentionIds.has(canonicalId)) return;
        seenMentionIds.add(canonicalId);
        mentionImages.push({
            id: canonicalId, category, label: `图片${mentionImages.length + 1}`,
            title: canvasNode?.title || libraryAsset?.title || category,
            token: canvasNode ? `@[node:${canvasNode.id}]` : `@[asset:${id}]`,
            previewUrl: preview[canvasNode?.id || `library:${id}`] || libraryAsset?.coverUrl,
        });
    };
    addMentionImage(frame?.imageNodeId, "原帧");
    frame?.referenceNodeIds?.forEach(id => addMentionImage(id, "其他参考"));
    for (const [category, label] of Object.entries(assets)) frame?.assets?.[category as keyof typeof assets]?.forEach(id => addMentionImage(id, label));
    useEffect(() => {
        let live = true;
        void Promise.all([
            ...previewNodes.map(async n => {
                try { return [n.id, await resolveMediaUrl(n.metadata?.storageKey, n.metadata?.content || n.metadata?.characterCoverUrl || "")] as const; }
                catch { return [n.id, ""] as const; }
            }),
            ...libraryAssets.map(async asset => {
                try { return [`library:${asset.id}`, await resolveMediaUrl(asset.data.storageKey, asset.data.dataUrl || asset.coverUrl)] as const; }
                catch { return [`library:${asset.id}`, asset.coverUrl || ""] as const; }
            }),
        ]).then(entries => { if (live) setPreview(Object.fromEntries(entries)); });
        return () => { live = false; };
    }, [nodes, libraryAssets]);
    if (!frame || !state) return null;
    const content = frameScriptFinalContent(frame);
    if (draftPromptsRef.current.frameId !== frame.id) draftPromptsRef.current = { frameId: frame.id, imageGenerationPrompt: content.imageGenerationPrompt, videoMotionPrompt: content.videoMotionPrompt };
    const generationDraft = () => ({
        imageGenerationPrompt: draftPromptsRef.current.imageGenerationPrompt ?? content.imageGenerationPrompt,
        videoMotionPrompt: draftPromptsRef.current.videoMotionPrompt ?? content.videoMotionPrompt,
        imageModel: frame.imageModel || generatedImage?.metadata?.model || modelConfig.imageModel || modelConfig.model || undefined,
    });
    const update = (change: (current: FrameScriptStoryboardFrame) => FrameScriptStoryboardFrame) => actions.updateNode?.(node.id, current => {
        const latest = current.metadata?.frameScriptStoryboard;
        if (!latest) return current;
        return { ...current, metadata: { ...current.metadata, frameScriptStoryboard: { ...latest, frames: latest.frames.map(f => f.id === frame.id ? change(f) : f), updatedAt: new Date().toISOString() } } };
    });
    const saveDuration = (durationSeconds: number) => {
        const previousDuration = frame.durationSeconds;
        update(current => ({ ...current, durationSeconds, durationSource: "manual" }));
        nodes.filter(candidate => candidate.type === CanvasNodeType.Video
            && candidate.metadata?.frameScriptStoryboardNodeId === node.id
            && candidate.metadata?.frameScriptStoryboardFrameId === frame.id
            && candidate.metadata.seconds === String(previousDuration))
            .forEach(candidate => actions.updateNode?.(candidate.id, current => ({
                ...current, metadata: { ...current.metadata, seconds: String(durationSeconds) },
            })));
    };
    const save = (key: keyof FrameScriptCreativeContent, value: string) => update(f => {
        if (f.lockedFields?.includes(key) || frameScriptFinalContent(f)[key] === value) return f;
        return { ...f, [key]: value, creativeHistory: [...(f.creativeHistory || []), { ...frameScriptFinalContent(f), durationSeconds: f.durationSeconds, createdAt: new Date().toISOString() }] };
    });
    const restore = () => update(f => {
        const previous = f.creativeHistory?.at(-1);
        if (!previous) return f;
        const restored = { ...f, durationSeconds: previous.durationSeconds, creativeHistory: f.creativeHistory!.slice(0, -1) };
        for (const key of Object.keys(fields) as (keyof FrameScriptCreativeContent)[]) if (!f.lockedFields?.includes(key)) restored[key] = previous[key];
        return restored;
    });
    const pickerSelection = (assetIds: string[]) => assetIds.map(id => candidates.some(candidate => candidate.id === id) ? `canvas:${id}` : id);
    const confirmAssetPicker = (selectedIds: string[]) => {
        if (!assetPickerCategory) return;
        const resolvedIds = selectedIds.map(id => id.startsWith("canvas:") ? id.slice("canvas:".length) : id);
        update(f => ({ ...f, assets: { ...f.assets, [assetPickerCategory]: Array.from(new Set(resolvedIds)) } }));
        setAssetPageIndexes(current => ({ ...current, [assetPickerCategory]: 0 }));
        setAssetPickerCategory(null);
    };
    const editor = (key: keyof FrameScriptCreativeContent) => <section key={key} className={panel}>
        <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-base font-bold">{fields[key]}</h3><div className="flex gap-1">
            <button className={button} title={frame.lockedFields?.includes(key) ? "解锁" : "锁定，合并时保留"} onClick={() => update(f => ({ ...f, lockedFields: f.lockedFields?.includes(key) ? f.lockedFields.filter(k => k !== key) : [...(f.lockedFields || []), key] }))}>{frame.lockedFields?.includes(key) ? <LockKeyhole size={14} /> : <Unlock size={14} />}</button>
            <button className={button} title="放大编辑" onClick={() => setExpanded(key)}><Scan size={14} /></button>
            <button className={button} title="复制" onClick={() => void navigator.clipboard.writeText(content[key]).catch(() => message.error("复制失败"))}><Copy size={14} /></button>
        </div></div>
        {key === "dialogue" ? <textarea key={`${key}-${content[key]}`} aria-label={fields[key]} defaultValue={content[key]} readOnly={frame.lockedFields?.includes(key)} onBlur={e => save(key, e.target.value)} className="min-h-20 w-full resize-y rounded-lg border border-white/15 bg-black/15 p-3 text-sm leading-6 outline-none focus:border-[#a394ff] read-only:opacity-60" /> : <FrameScriptMentionTextarea key={`${key}-${content[key]}`} initialValue={content[key]} label={fields[key]} readOnly={Boolean(frame.lockedFields?.includes(key))} references={mentionImages} onDraftChange={value => { draftPromptsRef.current[key] = value; }} onSave={value => save(key, value)} />}
    </section>;
    return <>
        <div className="flex h-full flex-col rounded-2xl border border-[#a394ff]/30 bg-gradient-to-br from-[#292040] to-[#101116] p-5 pt-9 text-white" onPointerDown={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-lg font-semibold"><Clapperboard className="text-[#a394ff]" />{frameScriptNodeDisplayTitle(node)}</div>
            <div className="my-3 flex min-h-0 flex-1 gap-3">{source && preview[source.id] ? <img src={preview[source.id]} className="w-24 rounded-lg object-contain" alt="原帧" /> : null}<p className="line-clamp-4 text-sm leading-6 text-white/65">{content.imageGenerationPrompt || "尚无图片提示词"}</p></div>
            <button className="h-10 rounded-xl bg-gradient-to-r from-[#684fff] to-[#2477f2] text-base font-semibold" onClick={() => actions.openFrameScriptShot?.(node.id)}>编辑镜头 · {shownDurationSeconds} 秒</button>
        </div>
        <AppModal open={open} onCancel={() => actions.openFrameScriptShot?.(null)} footer={null} closable={false} width="min(1480px, 96vw)" centered flush>
            <div className="flex max-h-[96vh] flex-col overflow-hidden rounded-2xl border border-[#a394ff]/50 bg-gradient-to-br from-[#211c36] via-[#13141e] to-[#0e1016] text-white" onPointerDown={e => e.stopPropagation()}>
                <header className="flex items-center justify-between border-b border-[#a394ff]/20 px-6 py-4"><div><h2 className="flex items-center gap-3 text-xl font-semibold"><Clapperboard className="text-[#a394ff]" />{frameScriptNodeDisplayTitle(node)}</h2><p className="mt-1 text-xs text-white/45">{portrait ? "竖版视频" : "横版视频"} · 跟随原帧比例</p></div><div className="flex gap-2"><button className={button} onClick={() => setSourceView(!sourceView)}>原片对照</button><button className={button} disabled={!frame.creativeHistory?.length} onClick={restore}><History size={14} />回退上一版</button><button className={button} aria-label="关闭镜头" onClick={() => actions.openFrameScriptShot?.(null)}><X size={18} /></button></div></header>
                <div className="grid min-h-0 content-start items-start gap-4 overflow-y-auto p-5 lg:grid-cols-2">
                    <div className={`grid min-w-0 gap-4 ${portrait ? "grid-cols-2" : "grid-cols-1"}`}>
                        <section className={`${panel} min-w-0`}><div className="mb-3 flex h-9 items-center justify-between gap-2"><h3 className="text-base font-bold">原帧参考</h3><button className={button} disabled={!source} onClick={() => { if (source) { actions.openFrameScriptShot?.(null); actions.openFrameScriptAssetDecomposition?.(source); } }}>提取背景</button></div>{source && preview[source.id] ? <div className={`grid w-full place-items-center overflow-hidden rounded-lg ${portrait ? "aspect-[9/16] max-h-[65vh]" : "aspect-video"}`}><img src={preview[source.id]} alt="原帧参考" onLoad={e => setPortrait(e.currentTarget.naturalHeight > e.currentTarget.naturalWidth)} className="h-full w-full object-contain" /></div> : <p className="text-white/45">原帧不可用</p>}</section>
                        <section className={`${panel} min-w-0`}><h3 className="mb-3 flex h-9 items-center text-base font-bold">生成画面</h3>{generated && preview[generated.id] ? generated.type === CanvasNodeType.Video ? <video src={preview[generated.id]} controls className={`w-full rounded-lg object-contain ${portrait ? "aspect-[9/16] max-h-[65vh]" : "aspect-video"}`} /> : <img src={preview[generated.id]} alt="生成画面" className={`w-full rounded-lg object-contain ${portrait ? "aspect-[9/16] max-h-[65vh]" : "aspect-video"}`} /> : <div className={`grid min-h-40 w-full place-items-center rounded-lg border border-white/10 text-center text-sm text-white/40 ${portrait ? "aspect-[9/16] max-h-[65vh]" : "aspect-video"}`}>{generated?.metadata?.status === "loading" ? "正在生成画面…" : generated?.metadata?.status === "error" ? generated.metadata.errorDetails || "生成失败，请重试" : "生成后的画面显示在这里"}</div>}</section>
                    </div>
                    <div className="min-w-0 space-y-3">
                        <section className={panel}><h3 className="mb-3 text-base font-bold">接入资产</h3><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Object.entries(assets).map(([category, label]) => {
                            const key = category as keyof typeof assets;
                            const ids = frame.assets?.[key] || [];
                            const activePage = Math.min(assetPageIndexes[key], Math.max(ids.length - 1, 0));
                            const mainId = ids[activePage];
                            const canvasNode = mainId ? nodes.find(n => n.id === mainId || n.metadata?.assetId === mainId) : undefined;
                            const libraryAsset = mainId ? libraryAssets.find(asset => asset.id === mainId || asset.id === canvasNode?.metadata?.assetId) : undefined;
                            const image = mainId ? preview[canvasNode?.id || `library:${mainId}`] || libraryAsset?.coverUrl || "" : "";
                            const title = canvasNode?.title || libraryAsset?.title || label;
                            return <div key={key} className="min-w-0">
                                <h4 className="mb-2 flex items-center justify-between gap-1 text-sm font-semibold"><span className="truncate">{label}</span>{ids.length > 0 ? <span className="shrink-0 text-xs font-normal text-white/45">{ids.length} 张</span> : null}</h4>
                                <Popover
                                    trigger="hover"
                                    placement="left"
                                    arrow={false}
                                    mouseEnterDelay={0.15}
                                    open={hoveredAssetCategory === key && assetPickerCategory === null && Boolean(image)}
                                    onOpenChange={next => setHoveredAssetCategory(next && image ? key : null)}
                                    content={image ? <div className="space-y-2"><img src={image} alt={`${label}：${title}`} className="block h-auto w-auto rounded-lg object-contain" style={{ maxWidth: "min(420px, 70vw)", maxHeight: "min(55vh, 420px)" }} /><div className="max-w-[420px] truncate text-xs text-white/80">{title} · {activePage + 1}/{ids.length}</div>{ids.length > 1 ? <div className="flex max-w-[420px] flex-wrap gap-1" aria-label={`${label}图片页码`}>{ids.map((id, index) => <button key={`${id}-${index}`} type="button" aria-label={`查看${label}第 ${index + 1} 张图片`} aria-current={index === activePage ? "page" : undefined} className={`grid size-7 place-items-center rounded-md border text-xs font-semibold ${index === activePage ? "border-[#a394ff] bg-[#a394ff] text-[#181526]" : "border-white/20 text-white hover:border-[#a394ff] hover:bg-white/10"}`} onMouseEnter={() => setAssetPageIndexes(current => ({ ...current, [key]: index }))} onFocus={() => setAssetPageIndexes(current => ({ ...current, [key]: index }))} onClick={() => setAssetPageIndexes(current => ({ ...current, [key]: index }))}>{index + 1}</button>)}</div> : null}</div> : null}
                                    styles={{ content: { padding: 8, border: "1px solid rgba(163,148,255,0.35)", borderRadius: 12, background: "#181824", boxShadow: "0 16px 48px rgba(0,0,0,0.45)" } }}
                                >
                                    <div className="relative">
                                        <button type="button" aria-label={ids.length ? `管理${label}图片，已接入${ids.length}张` : `从画布或素材库接入${label}`} title={ids.length ? `点击管理${label}图片` : `接入${label}图片`} className="relative block aspect-[4/3] w-full overflow-hidden rounded-lg border border-dashed border-[#a394ff]/40 bg-[#a394ff]/[0.04] text-left text-xs text-[#c5b9ff] hover:bg-[#a394ff]/10" onClick={() => { setHoveredAssetCategory(null); setAssetPickerCategory(key); }}>
                                            {mainId ? <>{image ? <img className="absolute inset-0 h-full w-full object-cover" src={image} alt={title} /> : <span className="absolute inset-0 grid place-items-center text-white/45">图片加载中</span>}<span className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/80 to-transparent" /><span className="absolute bottom-1.5 left-2 right-2 truncate text-white">{title}</span><span aria-hidden="true" className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-md border border-[#a394ff]/60 bg-[#292342]/95 text-lg leading-none text-white">＋</span></> : <span className="grid h-full place-content-center gap-2 text-center"><span className="text-xl leading-none">＋</span><span>接入图片</span></span>}
                                        </button>
                                    </div>
                                </Popover>
                            </div>;
                        })}</div></section>
                        {editor("imageGenerationPrompt")}{editor("videoMotionPrompt")}
                        {sourceView ? <section className={panel}><h3 className="mb-2 font-semibold">原始反推 · 只读</h3>{Object.entries(fields).map(([key, label]) => <p key={key} className="mb-2 whitespace-pre-wrap text-sm text-white/65">{label}：{frame.originalAnalysis?.[key as keyof FrameScriptCreativeContent] || "未提供"}</p>)}</section> : null}
                    </div>
                    <div className="min-w-0 lg:col-span-2">{editor("dialogue")}</div>
                    <div className="min-w-0 lg:col-span-2"><FrameScriptShotPlanPanel node={node} /></div>
                </div>
                <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-[#a394ff]/20 px-6 py-4"><span className="text-xs text-white/45">仅处理当前镜头 · 编辑后失焦保存</span><div className="flex flex-wrap items-center gap-3"><div className="flex min-w-48 max-w-64 items-center gap-2"><span className="shrink-0 text-sm text-white/70">图片模型</span><ModelPicker config={modelConfig} value={frame.imageModel || generatedImage?.metadata?.model || modelConfig.imageModel} capability="image" requirements={{ capability: "image", input: { textCount: content.imageGenerationPrompt.trim() ? 1 : 0, imageCount: mentionImages.length, videoCount: 0, audioCount: 0, characterCount: 0 } }} fullWidth showSelectedPrice={false} showOptionPrices={false} onChange={model => update(current => ({ ...current, imageModel: model }))} /></div><label className="mr-4 flex items-center gap-3 whitespace-nowrap text-base" title="新视频的生成时长，与原片片段长度无关；默认 6 秒，可手动修改">生成时长<input aria-label="本镜生成时长（秒）" type="number" min={1} key={shownDurationSeconds} defaultValue={shownDurationSeconds} className="h-10 w-24 rounded-lg border border-white/20 bg-black/20 px-3 text-base" onBlur={e => { const durationSeconds = Number(e.target.value); if (Number.isFinite(durationSeconds) && durationSeconds >= 1) saveDuration(durationSeconds); else { e.target.value = String(shownDurationSeconds); message.warning("生成时长至少为 1 秒"); } }} />秒</label><button className="inline-flex h-10 items-center gap-2 rounded-lg border border-[#a394ff]/30 px-4 text-base font-bold disabled:opacity-40" disabled={generatedImage?.metadata?.status === "loading"} onClick={() => { const draft = generationDraft(); if (!draft.imageGenerationPrompt?.trim()) { message.warning("请先填写图片提示词"); return; } void Promise.resolve(actions.createFrameScriptImageGenerationNodes?.(node, frame.id, draft)).catch(error => message.error(error instanceof Error ? error.message : "图片生成失败")); }}><ImagePlus size={16} />{generatedImage?.metadata?.status === "loading" ? "生成中" : "生成图片"}</button><button className="inline-flex h-10 items-center gap-2 rounded-lg bg-gradient-to-r from-[#684fff] to-[#2477f2] px-5 text-base font-bold" onClick={() => { const draft = generationDraft(); if (!draft.videoMotionPrompt?.trim()) { message.warning("请先填写视频动作"); return; } void Promise.resolve(actions.createFrameScriptVideoGenerationNodes?.(node, frame.id, draft)).then(() => actions.openFrameScriptShot?.(null)).catch(error => message.error(error instanceof Error ? error.message : "视频生成准备失败")); }}>生成视频</button></div></footer>
            </div>
        </AppModal>
        <AssetLibraryPickerModal
            remoteLibrary
            includeLocalItemsWithRemote
            open={assetPickerCategory !== null}
            title={assetPickerCategory ? `接入${assets[assetPickerCategory]}` : "接入图片"}
            eyebrow="画布图片与素材库"
            mediaKinds={["image"]}
            items={pickerItems}
            categoryLabels={{ all: "全部图片", canvas: "画布图片", ...ASSET_CATEGORY_LABELS }}
            initialSelectedIds={pickerSelection(frame.assets?.[assetPickerCategory || "person"] || [])}
            multiple
            confirmLabel={count => `接入所选图片${count ? `（${count}）` : ""}`}
            emptyTitle="还没有可接入的图片"
            emptyDescription="可先在画布添加图片，或把图片加入素材库。"
            onClose={() => setAssetPickerCategory(null)}
            onConfirm={confirmAssetPicker}
        />
        <AppModal open={Boolean(expanded)} title={expanded ? fields[expanded] : ""} onCancel={() => setExpanded(null)} footer={null} width={900}>{expanded ? expanded === "dialogue" ? <textarea key={`${expanded}-${content[expanded]}`} defaultValue={content[expanded]} readOnly={frame.lockedFields?.includes(expanded)} onBlur={e => save(expanded, e.target.value)} className="h-[55vh] w-full rounded-lg border border-white/15 bg-transparent p-4 text-base leading-7" /> : <FrameScriptMentionTextarea key={`${expanded}-${content[expanded]}`} initialValue={content[expanded]} label={fields[expanded]} readOnly={Boolean(frame.lockedFields?.includes(expanded))} references={mentionImages} onDraftChange={value => { draftPromptsRef.current[expanded] = value; }} onSave={value => save(expanded, value)} className="h-[55vh] w-full rounded-lg border border-white/15 bg-transparent p-4 text-base leading-7" /> : null}</AppModal>
    </>;
}
