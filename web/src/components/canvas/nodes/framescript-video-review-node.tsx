import { AlertCircle, ArrowRight, BookOpenCheck, Check, CheckCircle2, Clapperboard, Copy, Download, FilePlus2, Frame, LoaderCircle, Maximize2, PlaySquare, RefreshCw, Scissors, Settings2, Sparkles, Video, Waves } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import copyToClipboard from "copy-to-clipboard";

import { message, Modal } from "antd";
import { AppModal } from "@/components/ui/product/app-modal";
import { frameScriptReviewStatusLabel, frameScriptSkillContext, createDefaultFrameScriptVideoReviewState, sameFrameScriptVideoSourceBinding, type FrameScriptVideoReviewNodeState, type FrameScriptVideoSourceBinding } from "@/lib/framescript-video-review/contracts";
import { frameScriptVideoReviewNodeHeight } from "@/lib/framescript-video-review/node-layout";
import { canRestoreFrameScriptReviewCheckpoint } from "@/lib/framescript-video-review/review-recovery";
import { confirmVideoReview, transcriptForRange } from "@/lib/plugins/video-review";
import type { AnalysisResult } from "@/lib/plugins/video-plugin";
import { separateVideoScreenText } from "@/lib/plugins/video-text-separation";
import { FRAMESCRIPT_DEFAULT_GENERATION_SECONDS, frameScriptOriginalAnalysisForFrame, frameScriptShotEndMs } from "@/lib/framescript-video-review/storyboard-content";
import type { VideoResourceRef } from "@/lib/video-engine/video-ir";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { resolveMediaUrl } from "@/services/file-storage";
import { listAddedSkills, type Skill } from "@/services/api/skills";
import { createFrameScriptVideoReviewRuntime } from "@/services/framescript-video-review-runtime";
import { navigateToSettings } from "@/lib/settings-navigation";
import { ModelPicker } from "@/components/model-picker";
import { normalizeModelOptionValue, selectableModelsByCapability, useEffectiveConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

import { useCanvasNodeActions, type FrameScriptCanvasFrame, type FrameScriptCanvasStoryboardFrame } from "../canvas-node-action-context";
import { useUpstreamNodes } from "../canvas-node-graph-context";

type FrameScriptVideoReviewNodeContentProps = {
    node: CanvasNodeData;
};

const FRAME_SCRIPT_THUMBNAIL_CONCURRENCY = 1;

type RewriteVariant = { index: number; content: string };
type RewriteCard = { title: string; audience?: string; angle?: string; hooks: string[]; narration: string; filming: { label: string; value: string }[]; raw: string };

/** Splits numbered model output without modifying the original saved text. */
function rewriteVariants(content?: string): RewriteVariant[] {
    const source = content?.trim() || "";
    if (!source) return [];
    // Only level-two numbered headings delimit variants. Hook numbering and
    // headings such as "### 60 秒口播" stay inside the current variant.
    const boundaries = [...source.matchAll(/^[ \t]{0,3}##[ \t]*(?:方案|文案|改写)?[ \t]*(\d{1,2})(?:[、.．:：）)][ \t]*|[ \t]+|[ \t]*$)/gm)];
    if (boundaries.length < 2) return [{ index: 0, content: source }];
    return boundaries.map((match, index) => {
        const start = (match.index || 0) + match[0].length;
        const end = index + 1 < boundaries.length ? boundaries[index + 1].index : source.length;
        return { index, content: source.slice(start, end).trim() };
    }).filter((item) => item.content);
}

function rewriteSection(source: string, starts: RegExp, stops: RegExp) {
    starts.lastIndex = 0;
    stops.lastIndex = 0;
    const match = starts.exec(source);
    if (!match || match.index === undefined) return "";
    const from = match.index + match[0].length;
    const remaining = source.slice(from);
    const stop = stops.exec(remaining);
    return remaining.slice(0, stop?.index).trim();
}

function rewriteCard(variant: RewriteVariant): RewriteCard {
    const raw = variant.content.trim();
    const line = (pattern: RegExp) => raw.match(pattern)?.[1]?.trim();
    const firstLine = raw.split("\n").map((item) => item.trim()).find(Boolean) || "";
    const audience = line(/(?:^|\n)\s*(?:[-*]\s*)?(?:人群|目标人群)\s*[：:]\s*([^\n]+)/i)
        ?.replace(/[（(]\s*(?:推断|推测|判断|依据|根据)[\s\S]*$/, "")
        .replace(/[，,；;。\s]*(?:推断依据|推测依据|判断依据|依据)[：:][\s\S]*$/, "")
        .trim();
    const angle = line(/(?:^|\n)\s*(?:[-*]\s*)?(?:转化角度|角度)\s*[：:]\s*([^\n]+)/i);
    const titled = line(/(?:^|\n)\s*(?:#{1,4}\s*)?(?:标题|主题)\s*[：:]\s*([^\n]+)/i)
        || raw.match(/^\s*#{1,4}\s+([^\n]+)/)?.[1]?.trim()
        || (firstLine.length <= 28 && !/[：:。！？]/.test(firstLine) ? firstLine : "");
    const title = titled || `改写文案 ${variant.index + 1}`;
    const sectionNames = String.raw`(?:黄金\s*(?:3|三)\s*秒(?:\s*(?:开头|开场|钩子|文案))?|(?:5|五)\s*个(?:可替换)?(?:黄金)?(?:开头|开场|钩子)|(?:可替换)?开头(?:文案|钩子)?|hooks?|60\s*秒(?:口播|文案)(?:正文)?|主文案(?:正文)?|口播(?:文案|稿)?|正文(?:内容)?|拍摄(?:执行)?建议|分镜(?:建议|脚本))`;
    const sectionEnd = new RegExp(String.raw`(?:^|\n)\s*(?:#{1,4}\s*)?(?:\*\*)?${sectionNames}(?:\*\*)?(?:\s*[（(][^）)\n]*[）)])?(?:\s|:|：|$)[^\n]*`, "gim");
    const hookHeader = new RegExp(String.raw`(?:^|\n)\s*(?:#{1,4}\s*)?(?:\*\*)?(?:黄金\s*(?:3|三)\s*秒(?:\s*(?:开头|开场|钩子|文案))?|(?:5|五)\s*个(?:可替换)?(?:黄金)?(?:开头|开场|钩子)|(?:可替换)?开头(?:文案|钩子)?|hooks?)(?:\*\*)?(?:\s*[（(][^）)\n]*[）)])?(?:\s|:|：|$)[^\n]*`, "im");
    const narrationHeader = new RegExp(String.raw`(?:^|\n)\s*(?:#{1,4}\s*)?(?:\*\*)?(?:60\s*秒(?:口播|文案)(?:正文)?|主文案(?:正文)?|口播(?:文案|稿)?|正文(?:内容)?)(?:\*\*)?(?:\s*[（(][^）)\n]*[）)])?(?:\s|:|：|$)[^\n]*`, "im");
    const filmingHeader = new RegExp(String.raw`(?:^|\n)\s*(?:#{1,4}\s*)?(?:\*\*)?(?:拍摄(?:执行)?建议|分镜(?:建议|脚本))(?:\*\*)?(?:\s*[（(][^）)\n]*[）)])?(?:\s|:|：|$)[^\n]*`, "im");
    const hookSource = rewriteSection(raw, hookHeader, sectionEnd);
    const narration = rewriteSection(raw, narrationHeader, sectionEnd);
    const filmingSource = rewriteSection(raw, filmingHeader, sectionEnd);
    const hooks = hookSource.split("\n").map((item) => item.replace(/^\s*(?:[-*]|(?:开头\s*)?\d+\s*[、.．:：）)])\s*/, "").replace(/^\*\*(.*)\*\*$/, "$1").trim()).filter(Boolean).slice(0, 5);
    const filming = filmingSource.split("\n").map((item) => {
        const match = item.match(/^\s*(?:[-*]\s*)?(场景|人物|镜头|产品展示|信任素材)\s*[：:]\s*(.+)$/);
        return match ? { label: match[1], value: match[2].trim() } : null;
    }).filter((item): item is { label: string; value: string } => Boolean(item));
    return { title, audience, angle, hooks, narration, filming, raw };
}

export function FrameScriptVideoReviewNodeContent({ node }: FrameScriptVideoReviewNodeContentProps) {
    const { updateNode, updateMetadata, resizeNode } = useCanvasNodeActions();
    const upstream = useUpstreamNodes(node.id);
    const source = upstream.find((candidate) => candidate.type === "video");
    const state = node.metadata?.framescriptVideoReview || createDefaultFrameScriptVideoReviewState();
    const stateRef = useRef(state);
    stateRef.current = state;
    const [open, setOpen] = useState(false);
    const [reviewMounted, setReviewMounted] = useState(false);
    const [autoPrepare, setAutoPrepare] = useState(false);
    const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
    const sourceRef = source ? videoReferenceForNode(source) : null;
    const sourceBinding = source ? videoBindingForNode(source) : null;
    const backgroundTranscriptionKeyRef = useRef("");
    const initialStatusRef = useRef(state.status);
    const initialRewriteStatusRef = useRef(state.transcriptRewriteStatus);
    const [sourceThumbnail, setSourceThumbnail] = useState("");
    const currentSourceBindingRef = useRef<FrameScriptVideoSourceBinding | null>(sourceBinding);
    currentSourceBindingRef.current = sourceBinding;
    const staleSource = Boolean(state.source && (!source || !sourceRef || !sourceBinding
        || state.sourceNodeId !== source.id
        || !sameFrameScriptVideoSourceBinding(state.sourceBinding, sourceBinding)
        || state.source.kind !== sourceRef.kind
        || state.source.id !== sourceRef.id));

    useEffect(() => {
        // The FrameScript card follows the approved 1.85:1 reference ratio.
        // Preserve the user's current width and derive only its height.
        const height = frameScriptVideoReviewNodeHeight(node.width);
        if (Math.abs(node.height - height) <= 1 || !resizeNode) return;
        resizeNode(node.id, { width: node.width, height });
    }, [node.height, node.id, node.width, resizeNode]);

    const updateState = (patch: Partial<FrameScriptVideoReviewNodeState>) => {
        const contextPatch = patch.breakdown
            ? { content: frameScriptSkillContext(patch.breakdown) }
            : Object.hasOwn(patch, "breakdown") ? { content: "" } : {};
        const next = {
            ...(node.metadata?.framescriptVideoReview || createDefaultFrameScriptVideoReviewState()),
            ...patch,
            schemaVersion: 1 as const,
            updatedAt: new Date().toISOString(),
        };
        if (updateNode) {
            updateNode(node.id, (current) => ({
                ...current,
                metadata: {
                    ...current.metadata,
                    framescriptVideoReview: {
                        ...(current.metadata?.framescriptVideoReview || createDefaultFrameScriptVideoReviewState()),
                        ...patch,
                        schemaVersion: 1 as const,
                        updatedAt: next.updatedAt,
                    },
                    ...contextPatch,
                },
            }));
            return;
        }
        updateMetadata?.(node.id, { framescriptVideoReview: next, ...contextPatch });
    };
    const updateStateRef = useRef(updateState);
    updateStateRef.current = updateState;

    useEffect(() => {
        // Candidate extraction is an in-browser request. It cannot survive a
        // page reload or HMR remount, so a persisted in-progress label would
        // otherwise leave the node permanently stuck without a real job.
        const initialStatus = initialStatusRef.current;
        if (initialStatus !== "preparing" && initialStatus !== "transcribing" && initialStatus !== "analyzing") return;
        updateStateRef.current({
            status: "error",
            errorMessage: "上一次拆解请求已结束但未返回结果；请重新拆解。",
            transcriptionStatus: undefined,
            transcriptionError: undefined,
        });
    }, []);

    useEffect(() => {
        if (initialRewriteStatusRef.current !== "pending") return;
        updateStateRef.current({
            transcriptRewriteStatus: "failed",
            transcriptRewriteError: "上次改写请求没有返回结果，可能因页面刷新或连接中断而结束；请点击「再改一版」重试。",
        });
    }, []);

    useEffect(() => {
        let live = true;
        let generatedUrl = "";
        const fallback = source?.metadata?.previewContent || "";
        setSourceThumbnail(fallback);
        const storageKey = source?.metadata?.storageKey;
        if (!storageKey) return () => { live = false; };
        void resolveMediaUrl(storageKey, "").then(async (url) => {
            if (!url) return;
            const thumbnail = await captureVideoThumbnail(url, 0);
            generatedUrl = thumbnail;
            if (live) setSourceThumbnail(thumbnail);
            else URL.revokeObjectURL(thumbnail);
        }).catch(() => {
            // The neutral video icon remains when the source cannot expose a poster.
        });
        return () => {
            live = false;
            if (generatedUrl) URL.revokeObjectURL(generatedUrl);
        };
    }, [source?.id, source?.metadata?.previewContent, source?.metadata?.storageKey]);

    const canTranscribe = state.status === "awaiting-review" || state.status === "completed";
    useEffect(() => {
        const draft = state.draft;
        if (!draft || staleSource || !canTranscribe || state.transcriptionStatus !== "pending") return;
        const requestBinding = sourceBinding;
        if (!requestBinding) return;
        const key = `${draft.source.kind}:${draft.source.id}:${draft.sourceFingerprint}:${draft.revision}`;
        if (backgroundTranscriptionKeyRef.current === key) return;
        backgroundTranscriptionKeyRef.current = key;
        const controller = new AbortController();
        let live = true;
        void (async () => {
            try {
                const runtime = await createFrameScriptVideoReviewRuntime();
                const nextDraft = await runtime.workflow.retryTranscription(runtime.provider, draft, { signal: controller.signal });
                if (!live || !sameFrameScriptVideoSourceBinding(currentSourceBindingRef.current, requestBinding)) return;
                const transcriptionCompleted = Boolean(nextDraft.transcript);
                const currentBreakdown = stateRef.current.breakdown;
                const breakdown = transcriptionCompleted && currentBreakdown ? {
                    ...currentBreakdown,
                    transcript: nextDraft.transcript,
                    analysis: {
                        ...currentBreakdown.analysis,
                        segments: currentBreakdown.analysis.segments.map((segment) => ({
                            ...segment,
                            transcript: transcriptForRange(nextDraft.transcript, segment.startMs, segment.endMs)
                                .map((part) => part.originalText).join("\n") || undefined,
                        })),
                    },
                } : undefined;
                updateStateRef.current({
                    draft: nextDraft,
                    ...(breakdown ? { breakdown } : {}),
                    transcriptionStatus: transcriptionCompleted ? "completed" : "failed",
                    transcriptionError: transcriptionCompleted ? undefined : nextDraft.warnings?.[0]?.message || "未检测到可用的音频转写结果",
                });
            } catch (error) {
                if (!live || controller.signal.aborted || !sameFrameScriptVideoSourceBinding(currentSourceBindingRef.current, requestBinding)) return;
                updateStateRef.current({
                    transcriptionStatus: "failed",
                    transcriptionError: reviewErrorMessage(error),
                });
            }
        })();
        return () => {
            live = false;
            controller.abort();
            if (backgroundTranscriptionKeyRef.current === key) backgroundTranscriptionKeyRef.current = "";
        };
    }, [sourceBinding?.assetId, sourceBinding?.nodeId, sourceBinding?.storageKey, staleSource, state.draft?.revision, state.draft?.sourceFingerprint, canTranscribe, state.transcriptionStatus]);

    const processing = state.status === "preparing" || state.status === "transcribing" || state.status === "analyzing";
    const completed = state.status === "completed" && Boolean(state.breakdown);
    const confirmedCount = state.review?.frames.length || state.breakdown?.review.frames.length || 0;
    const transcriptReady = Boolean(state.draft?.transcript || state.breakdown?.transcript);
    const transcriptionPending = state.transcriptionStatus === "pending";
    const sourceTitle = source?.title || state.sourceTitle || "尚未连接视频";
    const processingLabel = state.status === "transcribing"
        ? "正在转写原音频为文案"
        : state.status === "analyzing"
            ? "正在理解已确认镜头"
            : "正在扫描视频并提取候选画面";
    const closeModal = () => { setOpen(false); setAutoPrepare(false); };
    const openForPrepare = () => { setReviewMounted(true); setAutoPrepare(true); setOpen(true); };
    const openReview = () => { setReviewMounted(true); setAutoPrepare(false); setOpen(true); };

    return <>
        <div className="flex h-full w-full min-h-0 flex-col overflow-hidden rounded-[30px] border border-[#363742] bg-[radial-gradient(circle_at_14%_8%,rgba(116,87,255,0.12),transparent_31%),linear-gradient(132deg,#1b1b24_0%,#101116_74%,#0d0e12_100%)] px-8 pb-7 pt-10 text-white shadow-[0_20px_54px_rgba(0,0,0,0.34)]">
            <div className="flex items-center justify-between gap-5">
                <div className="flex min-w-0 items-center gap-4"><span className="grid size-[58px] shrink-0 place-items-center rounded-[18px] bg-[linear-gradient(145deg,rgba(105,83,255,0.3),rgba(61,45,111,0.42))] text-[#9f8cff] ring-1 ring-[#a394ff]/20"><Scissors className="size-8" strokeWidth={1.8} /></span><h3 className="truncate text-[28px] font-bold tracking-[-0.03em]">视频拆解</h3></div>
                <FrameScriptCanvasStatus status={state.status} completed={completed} />
            </div>

            <div className="mt-7 flex min-h-0 flex-1 items-center gap-6">
                <div className="relative grid h-[102px] w-[154px] shrink-0 place-items-center overflow-hidden rounded-[18px] bg-[linear-gradient(145deg,rgba(64,65,75,0.9),rgba(36,37,45,0.92))] text-white/75 ring-1 ring-white/10">{sourceThumbnail ? <img src={sourceThumbnail} alt={`${sourceTitle} 首帧`} className="size-full object-cover" loading="lazy" /> : null}<span className={`absolute inset-0 grid place-items-center ${sourceThumbnail ? "bg-black/25" : "bg-black/15"}`}><Video className="size-10 drop-shadow-[0_2px_8px_rgba(0,0,0,0.65)]" strokeWidth={1.7} /></span></div>
                <div className="min-w-0"><div className="truncate text-[25px] font-medium tracking-[-0.02em] text-white">{sourceTitle}</div><p className={`mt-3 text-[15px] leading-6 ${state.status === "error" || staleSource ? "text-amber-200/90" : "text-white/60"}`}>{state.status === "awaiting-review" ? `已提取 ${state.draft?.frames.length || 0} 个候选画面 · ${transcriptionPending ? "音频转写中" : transcriptReady ? "音频已转写" : state.transcriptionError ? "音频转写待重试" : "待手动转写"}` : completed ? `已确认 ${confirmedCount} 个镜头 · ${transcriptReady ? "音频已转写" : "音频转写未完成"}` : state.status === "error" || staleSource ? (staleSource ? "原视频已变化，请重新拆解" : state.errorMessage || "拆解失败，请重试") : "提取关键画面；语音转写可手动开始"}</p></div>
            </div>

            {processing ? <div className="mt-6 border-t border-white/10 pt-5"><div className="flex items-center gap-3 text-[17px] font-medium text-white/60"><LoaderCircle className="size-8 animate-spin text-[#8175ff]" strokeWidth={1.7} />{processingLabel}</div></div>
                : completed ? <div className="mt-6 grid grid-cols-[0.82fr_1.18fr] gap-4 border-t border-white/10 pt-5"><button type="button" className="inline-flex h-14 items-center justify-center gap-3 rounded-[17px] border border-white/15 px-4 text-[16px] font-semibold text-white/85 transition hover:border-white/35 hover:bg-white/5" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setRestartConfirmOpen(true); }}><RefreshCw className="size-6" strokeWidth={1.8} />重新拆解</button><button type="button" className="inline-flex h-14 items-center justify-center gap-3 rounded-[17px] bg-gradient-to-r from-[#684fff] to-[#2477f2] px-4 text-[16px] font-semibold text-white shadow-[0_10px_30px_rgba(63,91,255,0.25)] transition hover:brightness-110" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); openReview(); }}><Sparkles className="size-6" strokeWidth={1.8} />查看拆解结果</button></div>
                    : <div className="mt-6"><button type="button" className="inline-flex h-14 w-[min(300px,100%)] items-center justify-center gap-3 rounded-[17px] bg-gradient-to-r from-[#684fff] to-[#2477f2] px-5 text-[20px] font-semibold text-white shadow-[0_10px_30px_rgba(63,91,255,0.25)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45" disabled={!source || !sourceRef} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); state.status === "awaiting-review" ? openReview() : openForPrepare(); }}>{state.status === "awaiting-review" ? <Frame className="size-6" strokeWidth={1.8} /> : <PlaySquare className="size-6" strokeWidth={1.8} />}{state.status === "awaiting-review" ? "复核候选画面" : state.status === "error" || staleSource ? "重新拆解" : "开始拆解"}</button></div>}
        </div>
        <Modal open={restartConfirmOpen} title="重新拆解视频？" okText="重新拆解" cancelText="取消" onCancel={() => setRestartConfirmOpen(false)} onOk={() => { setRestartConfirmOpen(false); openForPrepare(); }}>
            <p className="mb-0 text-sm leading-6 text-[var(--muted-foreground)]">将重新提取关键画面；语音转写需在复核面板中手动开始。当前的候选画面、人工确认和拆解结果会被替换。</p>
        </Modal>
        {reviewMounted ? <FrameScriptReviewModal
            open={open}
            autoPrepare={autoPrepare}
            node={node}
            source={source}
            sourceRef={sourceRef}
            sourceBinding={sourceBinding}
            state={state}
            staleSource={staleSource}
            onClose={closeModal}
            onUpdate={updateState}
        /> : null}
    </>;
}

function FrameScriptReviewModal({ open, autoPrepare, node, source, sourceRef, sourceBinding, state, staleSource, onClose, onUpdate }: {
    open: boolean;
    autoPrepare: boolean;
    node: CanvasNodeData;
    source?: CanvasNodeData;
    sourceRef: VideoResourceRef | null;
    sourceBinding: FrameScriptVideoSourceBinding | null;
    state: FrameScriptVideoReviewNodeState;
    staleSource: boolean;
    onClose: () => void;
    onUpdate: (patch: Partial<FrameScriptVideoReviewNodeState>) => void;
}) {
    const { addFrameScriptImageNodes, addFrameScriptStoryboardNode, addFrameScriptTranscriptNode } = useCanvasNodeActions();
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [revisingFrames, setRevisingFrames] = useState(false);
    const [sourceUrl, setSourceUrl] = useState("");
    const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
    const [thumbnailFailures, setThumbnailFailures] = useState<Record<string, true>>({});
    const requestTokenRef = useRef(0);
    const activeRequestRef = useRef(false);
    const persistenceTokenRef = useRef<string | null>(null);
    const checkpointWriteRef = useRef<Promise<void> | null>(null);
    const transcriptRewriteRequestRef = useRef(0);
    const [rewriteSetupOpen, setRewriteSetupOpen] = useState(false);
    const [availableSkills, setAvailableSkills] = useState<Skill[]>([]);
    const [skillsLoading, setSkillsLoading] = useState(false);
    const [skillsLoadError, setSkillsLoadError] = useState("");
    const [selectedRewriteSkillId, setSelectedRewriteSkillId] = useState("");
    const [materialsOpen, setMaterialsOpen] = useState(false);
    const [feedback, setFeedback] = useState("");
    const [showPreviousRewrite, setShowPreviousRewrite] = useState(false);
    const [materialsDraft, setMaterialsDraft] = useState(state.transcriptRewriteMaterials || {});
    const [retentionDraft, setRetentionDraft] = useState<NonNullable<FrameScriptVideoReviewNodeState["transcriptRewriteRetention"]>>(state.transcriptRewriteRetention || "skill");
    const rewriteConfig = useEffectiveConfig();
    const restoredCheckpointRef = useRef("");
    const restoredSelectionRef = useRef<string[] | null>(null);
    const autoPrepareStartedRef = useRef(false);
    const currentBindingRef = useRef<FrameScriptVideoSourceBinding | null>(sourceBinding);
    const onUpdateRef = useRef(onUpdate);
    currentBindingRef.current = sourceBinding;
    onUpdateRef.current = onUpdate;
    const queueCheckpointWrite = (write: () => Promise<void>) => {
        const previous = checkpointWriteRef.current?.catch(() => undefined) || Promise.resolve();
        const queued = previous.then(write);
        checkpointWriteRef.current = queued;
        void queued.finally(() => {
            if (checkpointWriteRef.current === queued) checkpointWriteRef.current = null;
        }).catch(() => undefined);
        return queued;
    };
    const busy = !staleSource && (state.status === "preparing" || state.status === "transcribing" || state.status === "analyzing");
    const transcriptionPending = state.transcriptionStatus === "pending";
    const draft = state.draft;
    const requestTranscription = () => {
        if (!draft || staleSource || transcriptionPending) return;
        transcriptRewriteRequestRef.current += 1;
        onUpdate({ transcriptionStatus: "pending", transcriptionError: undefined, transcriptRewriteStatus: undefined, transcriptRewrite: undefined, transcriptRewriteError: undefined });
    };

    useEffect(() => {
        if (!open) return;
        const confirmed = state.review?.frames?.length ? state.review.frames : state.breakdown?.review.frames;
        setSelectedIds(confirmed?.map((frame) => frame.id) || restoredSelectionRef.current || []);
    }, [draft?.revision, open, state.breakdown?.review.frames, state.review]);

    useEffect(() => {
        requestTokenRef.current += 1;
        activeRequestRef.current = false;
        persistenceTokenRef.current = null;
        checkpointWriteRef.current = null;
        restoredCheckpointRef.current = "";
        restoredSelectionRef.current = null;
    }, [sourceBinding?.assetId, sourceBinding?.nodeId, sourceBinding?.storageKey]);

    // A page refresh cannot resume an in-flight browser request. The single
    // checkpoint recovery path below converts that transient state into a
    // fresh manual-review state while preserving the storage write token.
    useEffect(() => {
        if (!sourceRef || !canRestoreFrameScriptReviewCheckpoint(state, { open, autoPrepare, staleSource, activeRequest: activeRequestRef.current })) return;
        const checkpointKey = `${sourceRef.kind}:${sourceRef.id}`;
        if (restoredCheckpointRef.current === checkpointKey) return;
        restoredCheckpointRef.current = checkpointKey;
        let live = true;
        void (async () => {
            try {
                const runtime = await createFrameScriptVideoReviewRuntime();
                const restored = await runtime.persistence.load(sourceRef);
                if (!live) return;
                if (restored.status === "missing") {
                    if (state.status === "preparing" || state.status === "transcribing" || state.status === "analyzing") onUpdateRef.current({ status: "error", errorMessage: "页面已刷新，之前的本地处理无法恢复；请重新准备候选帧。", draft: undefined, review: undefined, breakdown: undefined, persistenceToken: undefined });
                    return;
                }
                if (restored.status !== "restored") {
                    if (state.status === "preparing" || state.status === "transcribing" || state.status === "analyzing") onUpdateRef.current({ status: "error", errorMessage: "原视频已变化，请重新准备候选帧。", draft: undefined, review: undefined, breakdown: undefined, persistenceToken: undefined });
                    return;
                }
                restoredSelectionRef.current = restored.selectedIds;
                persistenceTokenRef.current = restored.writeToken;
                onUpdateRef.current({
                    status: "awaiting-review",
                    source: sourceRef,
                    sourceNodeId: source?.id,
                    sourceBinding: sourceBinding || undefined,
                    sourceTitle: source?.title,
                    draft: restored.draft,
                    review: undefined,
                    breakdown: undefined,
                    persistenceToken: restored.writeToken,
                    errorMessage: undefined,
                    transcriptionStatus: restored.draft.transcript ? "completed" : "pending",
                    transcriptionError: undefined,
                });
            } catch (error) {
                // Checkpoint recovery is best-effort; durable canvas metadata remains authoritative.
                if (live && (state.status === "preparing" || state.status === "transcribing" || state.status === "analyzing")) onUpdateRef.current({ status: "error", errorMessage: reviewErrorMessage(error), draft: undefined, review: undefined, breakdown: undefined, persistenceToken: undefined });
            }
        })();
        return () => {
            live = false;
            // If the modal closes while recovery is pending, allow the next
            // open to start a fresh checkpoint load instead of treating the
            // cancelled attempt as already restored.
            if (restoredCheckpointRef.current === checkpointKey) restoredCheckpointRef.current = "";
        };
    }, [autoPrepare, draft, open, source?.id, sourceBinding?.assetId, sourceBinding?.nodeId, sourceBinding?.storageKey, sourceRef?.id, sourceRef?.kind, staleSource, state.status, state.breakdown]);

    useEffect(() => {
        let live = true;
        const fallback = source?.metadata?.previewContent || source?.metadata?.content || "";
        setSourceUrl(fallback);
        const storageKey = source?.metadata?.storageKey;
        if (!storageKey) return () => { live = false; };
        void resolveMediaUrl(storageKey, fallback).then((url) => { if (live) setSourceUrl(url || fallback); }).catch(() => { if (live) setSourceUrl(fallback); });
        return () => { live = false; };
    }, [source?.id, source?.metadata?.content, source?.metadata?.previewContent, source?.metadata?.storageKey]);

    useEffect(() => {
        const persistedFrames = state.review?.frames?.length
            ? state.review.frames
            : state.breakdown?.review.frames?.length
                ? state.breakdown.review.frames
                : (state.breakdown?.analysis.keyframes || []).map((frame) => ({ ...frame, id: `frame-${frame.timeMs}` }));
        const previewFrames = draft?.frames?.length ? draft.frames : persistedFrames;
        const supplied = Object.fromEntries(previewFrames.flatMap((frame) => frame.previewDataUrl ? [[frame.id, frame.previewDataUrl] as const] : []));
        const frames = previewFrames.filter((frame) => !frame.previewDataUrl);
        if (!open || !previewFrames.length || (!sourceUrl && frames.length > 0)) return;
        let live = true;
        const urls: string[] = [];
        let cursor = 0;
        setThumbnails(supplied);
        setThumbnailFailures({});
        const worker = async () => {
            while (live) {
                const frame = frames[cursor++];
                if (!frame) return;
                try {
                    const url = await captureVideoThumbnail(sourceUrl, frame.timeMs);
                    urls.push(url);
                    if (live) setThumbnails((current) => ({ ...current, [frame.id]: url }));
                    else URL.revokeObjectURL(url);
                } catch {
                    if (live) setThumbnailFailures((current) => ({ ...current, [frame.id]: true }));
                }
            }
        };
        void Promise.all(Array.from({ length: Math.min(FRAME_SCRIPT_THUMBNAIL_CONCURRENCY, frames.length) }, worker));
        return () => {
            live = false;
            urls.forEach((url) => URL.revokeObjectURL(url));
        };
    }, [draft?.revision, open, sourceUrl, state.breakdown?.analysis.keyframes, state.breakdown?.review.frames, state.review?.frames]);

    const prepare = async () => {
        if (!source || !sourceRef || !sourceBinding || activeRequestRef.current) return;
        const token = ++requestTokenRef.current;
        const requestBinding = sourceBinding;
        activeRequestRef.current = true;
        transcriptRewriteRequestRef.current += 1;
        onUpdate({ status: "preparing", source: sourceRef, sourceNodeId: source.id, sourceBinding: requestBinding, sourceTitle: source.title, errorMessage: undefined, draft: undefined, review: undefined, breakdown: undefined, persistenceToken: undefined, transcriptionStatus: undefined, transcriptionError: undefined, transcriptRewriteStatus: undefined, transcriptRewrite: undefined, transcriptRewriteError: undefined });
        try {
            const runtime = await createFrameScriptVideoReviewRuntime();
            const nextDraft = await runtime.workflow.prepare(runtime.provider, sourceRef, false);
            // The source binding, rather than the modal-local request counter,
            // is the durable invalidation boundary. React remounts can reset
            // that counter while a valid server extraction is in flight.
            if (!sameFrameScriptVideoSourceBinding(currentBindingRef.current, requestBinding)) return;
            activeRequestRef.current = false;
            // Candidate previews are ready now. IndexedDB is only a recovery
            // checkpoint and can take noticeable time for many JPEG previews;
            // never keep the review UI in "preparing" while it is writing.
            onUpdate({ status: "awaiting-review", source: sourceRef, sourceNodeId: source.id, sourceBinding: requestBinding, sourceTitle: source.title, draft: nextDraft, review: undefined, breakdown: undefined, persistenceToken: undefined, errorMessage: undefined, transcriptionStatus: undefined, transcriptionError: undefined, transcriptRewriteStatus: undefined, transcriptRewrite: undefined, transcriptRewriteError: undefined });
            void queueCheckpointWrite(async () => {
                const checkpoint = await runtime.persistence.save(nextDraft, [], persistenceTokenRef.current);
                if (!sameFrameScriptVideoSourceBinding(currentBindingRef.current, requestBinding)) return;
                persistenceTokenRef.current = checkpoint.writeToken;
                if (token !== requestTokenRef.current) return;
                onUpdateRef.current({ persistenceToken: checkpoint.writeToken });
            }).catch(() => {
                // Canvas metadata already contains the review draft, so local
                // checkpoint failure must not interrupt the user's review.
            });
        } catch (error) {
            if (!sameFrameScriptVideoSourceBinding(currentBindingRef.current, requestBinding)) return;
            activeRequestRef.current = false;
            onUpdate({ status: "error", errorMessage: reviewErrorMessage(error) });
        }
    };

    useEffect(() => {
        if (!autoPrepare) {
            autoPrepareStartedRef.current = false;
            return;
        }
        if (autoPrepareStartedRef.current) return;
        autoPrepareStartedRef.current = true;
        void prepare();
    }, [autoPrepare, prepare]);

    const confirm = async () => {
        if (!draft || staleSource || !sourceBinding || activeRequestRef.current) return;
        const token = ++requestTokenRef.current;
        const requestBinding = sourceBinding;
        activeRequestRef.current = true;
        try {
            const review = confirmVideoReview(draft, selectedIds);
            if (token !== requestTokenRef.current || !sameFrameScriptVideoSourceBinding(currentBindingRef.current, requestBinding)) return;
            activeRequestRef.current = false;
            onUpdate({ status: "awaiting-review", review, persistenceToken: persistenceTokenRef.current || state.persistenceToken || undefined, errorMessage: undefined });
            const runtime = await createFrameScriptVideoReviewRuntime();
            void queueCheckpointWrite(async () => {
                const checkpoint = await runtime.persistence.save(draft, selectedIds, persistenceTokenRef.current ?? state.persistenceToken ?? null);
                if (token !== requestTokenRef.current || !sameFrameScriptVideoSourceBinding(currentBindingRef.current, requestBinding)) return;
                persistenceTokenRef.current = checkpoint.writeToken;
                onUpdateRef.current({ persistenceToken: checkpoint.writeToken });
            }).catch(() => {
                // The confirmed canvas state remains usable if local recovery storage is unavailable.
            });
        } catch (error) {
            if (token !== requestTokenRef.current || !sameFrameScriptVideoSourceBinding(currentBindingRef.current, requestBinding)) return;
            activeRequestRef.current = false;
            onUpdate({ status: "error", errorMessage: reviewErrorMessage(error) });
        }
    };

    const analyze = async () => {
        if (!draft || !state.review || staleSource || !reviewMatchesSelection || !sourceBinding) return;
        const previousBreakdown = state.breakdown;
        const previousFrameIds = new Set(previousBreakdown?.review.frames.map((frame) => frame.id) || []);
        const addedFrameIds = selectedIds.filter((id) => !previousFrameIds.has(id));
        if (previousBreakdown && !addedFrameIds.length) {
            setRevisingFrames(false);
            return;
        }
        const token = ++requestTokenRef.current;
        const requestBinding = sourceBinding;
        activeRequestRef.current = true;
        onUpdate({ status: "analyzing", errorMessage: undefined });
        try {
            const runtime = await createFrameScriptVideoReviewRuntime();
            const reviewForRequest = previousBreakdown ? confirmVideoReview(draft, addedFrameIds) : state.review;
            const incoming = await runtime.workflow.analyzeSelected(runtime.provider, draft, reviewForRequest, ["video-analysis", "scene-understanding", "asset-analysis", "prompt-extraction"]);
            if (token !== requestTokenRef.current || !sameFrameScriptVideoSourceBinding(currentBindingRef.current, requestBinding)) return;
            activeRequestRef.current = false;
            const breakdown = previousBreakdown ? {
                ...previousBreakdown,
                review: state.review,
                screenText: [],
                analysis: {
                    ...previousBreakdown.analysis,
                    ...incoming.analysis,
                    summary: [previousBreakdown.analysis.summary, incoming.analysis.summary].filter(Boolean).join("\n\n"),
                    segments: [...previousBreakdown.analysis.segments, ...incoming.analysis.segments].sort((left, right) => left.startMs - right.startMs),
                    keyframes: [...(previousBreakdown.analysis.keyframes || []), ...(incoming.analysis.keyframes || []).filter((frame) => !(previousBreakdown.analysis.keyframes || []).some((existing) => existing.timeMs === frame.timeMs))].sort((left, right) => left.timeMs - right.timeMs),
                },
            } : { ...incoming, screenText: [] };
            const cleanedBreakdown = {
                ...breakdown,
                screenText: [],
                analysis: { ...breakdown.analysis, segments: breakdown.analysis.segments.map((segment) => {
                    const clean = { ...segment };
                    delete clean.screenText;
                    return clean;
                }) },
            };
            setRevisingFrames(false);
            onUpdate({
                status: "completed",
                breakdown: cleanedBreakdown,
                errorMessage: "",
            });
        } catch (error) {
            if (token !== requestTokenRef.current || !sameFrameScriptVideoSourceBinding(currentBindingRef.current, requestBinding)) return;
            activeRequestRef.current = false;
            onUpdate({ status: "error", errorMessage: reviewErrorMessage(error) });
        }
    };

    const selectedCount = selectedIds.length;
    const selectedSet = new Set(selectedIds);
    const activeReview = state.review?.frames?.length ? state.review : state.breakdown?.review;
    const selectedPreviewsReady = Boolean(selectedIds.length) && selectedIds.every((id) => Boolean(thumbnails[id]) && !thumbnailFailures[id]);
    const reviewMatchesSelection = Boolean(activeReview
        && activeReview.frames.length === selectedIds.length
        && activeReview.frames.every((frame) => selectedSet.has(frame.id)));
    const summary = state.breakdown?.analysis.summary || state.breakdown?.analysis.segments.map((segment) => segment.description || segment.prompt).filter(Boolean).join("\n\n");
    const buildConfirmedFrames = (): FrameScriptCanvasStoryboardFrame[] => {
        if (!sourceRef) return [];
        const sourceFrames = draft?.frames?.length ? draft.frames : activeReview?.frames || [];
        const confirmed = selectedIds.flatMap((id) => {
            const frame = sourceFrames.find((candidate) => candidate.id === id);
            const imageUrl = thumbnails[id];
            return frame && imageUrl ? [{ frame, imageUrl }] : [];
        }).sort((left, right) => left.frame.timeMs - right.frame.timeMs);
        return confirmed.map(({ frame, imageUrl }, index) => {
            const nextTimeMs = confirmed[index + 1]?.frame.timeMs;
            const provisionalEndMs = nextTimeMs ?? draft?.durationMs ?? frame.timeMs + 1000;
            const segment = state.breakdown?.analysis.segments.find((candidate) => candidate.startMs <= frame.timeMs && candidate.endMs > frame.timeMs)
                || state.breakdown?.analysis.segments.find((candidate) => candidate.startMs < provisionalEndMs && candidate.endMs > frame.timeMs);
            const endMs = frameScriptShotEndMs(frame.timeMs, nextTimeMs, segment?.endMs, draft?.durationMs ?? state.breakdown?.analysis.durationMs);
            const transcript = transcriptForRange(state.breakdown?.transcript || draft?.transcript, frame.timeMs, endMs)
                .map((item) => item.cleanedText || item.originalText)
                .filter(Boolean)
                .join(" ");
            const description = separateVideoScreenText(segment?.description);
            const prompt = separateVideoScreenText(segment?.prompt);
            return {
                id: frame.id,
                originalAnalysis: frameScriptOriginalAnalysisForFrame(state.breakdown, frame.id),
                index: index + 1,
                timeMs: frame.timeMs,
                imageUrl,
                sourceVideoId: sourceRef.id,
                reasons: [...frame.reasons],
                durationSeconds: FRAMESCRIPT_DEFAULT_GENERATION_SECONDS,
                durationSource: "default",
                description: description.visual || segment?.description,
                imageGenerationPrompt: prompt.visual || description.visual || segment?.prompt || segment?.description,
                videoMotionPrompt: description.visual || prompt.visual || segment?.description || segment?.prompt,
                dialogue: segment?.transcript || transcript,
            };
        });
    };
    const exportConfirmedFrames = async () => {
        if (!addFrameScriptImageNodes || !activeReview || !reviewMatchesSelection || !sourceRef) return;
        const frames: FrameScriptCanvasFrame[] = buildConfirmedFrames();
        if (!frames.length) return;
        try { await addFrameScriptImageNodes(node, frames); message.success("已输出确认分镜图片"); }
        catch (error) { message.error(error instanceof Error ? error.message : "导出失败"); }
    };
    const exportStoryboard = async () => {
        if (!addFrameScriptStoryboardNode || !activeReview || !reviewMatchesSelection || !sourceRef) return;
        const frames = buildConfirmedFrames();
        if (!frames.length) return;
        try { await addFrameScriptStoryboardNode(node, frames); onClose(); }
        catch (error) { message.error(error instanceof Error ? error.message : "导出失败"); }
    };
    const exportTranscript = async (content: string) => {
        if (!content.trim() || !addFrameScriptTranscriptNode) {
            message.warning("当前结果没有可输出的主文案，请重新生成");
            return;
        }
        await addFrameScriptTranscriptNode(node, content);
    };
    const openRewriteSetup = () => {
        setSelectedRewriteSkillId(state.transcriptRewriteSkillId || "");
        setSkillsLoadError("");
        setRewriteSetupOpen(true);
        setSkillsLoading(true);
        void listAddedSkills()
            .then(({ skills }) => setAvailableSkills(skills.filter((skill) => skill.isAdded)))
            .catch((error) => setSkillsLoadError(reviewErrorMessage(error)))
            .finally(() => setSkillsLoading(false));
    };
    const openMaterials = () => {
        setMaterialsDraft(state.transcriptRewriteMaterials || {});
        setRetentionDraft(state.transcriptRewriteRetention || "skill");
        setMaterialsOpen(true);
    };
    const missingRequiredMaterials = ["product", "benefits"].filter((key) => !state.transcriptRewriteMaterials?.[key as "product" | "benefits"]?.trim());
    const saveMaterials = () => {
        onUpdate({ transcriptRewriteMaterials: materialsDraft, transcriptRewriteRetention: retentionDraft });
        setMaterialsOpen(false);
    };
    const rewriteTranscript = async (selection: { skillId: string; model: string }, mode: "all" | "selected" = "all") => {
        const transcript = state.breakdown?.transcript?.text || draft?.transcript?.text || "";
        if (!transcript.trim() || state.transcriptRewriteStatus === "pending") return;
        const currentVariants = state.transcriptRewriteVariants?.length
            ? state.transcriptRewriteVariants
            : rewriteVariants(state.transcriptRewrite).map((variant) => ({ content: variant.content, history: [] }));
        const selectedIndex = Math.min(Math.max(state.transcriptRewriteSelectedIndex || 0, 0), Math.max(currentVariants.length - 1, 0));
        const selectedVariant = currentVariants[selectedIndex];
        const request = ++transcriptRewriteRequestRef.current;
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 120_000);
        const skill = availableSkills.find((item) => item.skillId === selection.skillId);
        onUpdate({ transcriptRewriteStatus: "pending", transcriptRewriteError: undefined, transcriptRewriteSkillId: selection.skillId, transcriptRewriteSkillName: skill?.skillName, transcriptRewriteModel: selection.model });
        try {
            const runtime = await createFrameScriptVideoReviewRuntime();
            const retention = state.transcriptRewriteRetention || "skill";
            const rewritten = await runtime.rewriteTranscript({ transcript, model: selection.model, skillId: selection.skillId, materials: state.transcriptRewriteMaterials, feedback, previousRewrite: mode === "selected" ? selectedVariant?.content : state.transcriptRewrite, history: mode === "selected" ? selectedVariant?.history : state.transcriptRewriteHistory, retention, count: mode === "selected" ? 1 : state.transcriptRewriteCount || 1, signal: controller.signal });
            if (request !== transcriptRewriteRequestRef.current) return;
            const history = state.transcriptRewriteHistory || [];
            const nextHistory = state.transcriptRewrite?.trim() && state.transcriptRewrite !== history[history.length - 1]?.content
                ? [...history, { content: state.transcriptRewrite, feedback: state.transcriptRewriteFeedback || "", retention, createdAt: new Date().toISOString() }].slice(-20)
                : history;
            const generatedVariants = rewriteVariants(rewritten).map((variant) => variant.content);
            const expectedCount = mode === "selected" ? 1 : state.transcriptRewriteCount || 1;
            if (generatedVariants.length !== expectedCount) {
                throw new Error(`模型本次返回了 ${generatedVariants.length} 条，设置为 ${expectedCount} 条；未替换现有结果，请重试。`);
            }
            const incompleteIndex = generatedVariants.findIndex((content) => rewriteCard({ index: 0, content }).hooks.length !== 5);
            if (incompleteIndex >= 0) {
                const hookCount = rewriteCard({ index: incompleteIndex, content: generatedVariants[incompleteIndex] }).hooks.length;
                throw new Error(`第 ${incompleteIndex + 1} 条只返回 ${hookCount}/5 个开头；现有结果已保留，请点击「再改一版」重试。`);
            }
            const nextVariants = mode === "selected" && selectedVariant
                ? currentVariants.map((variant, index) => index === selectedIndex ? { content: generatedVariants[0] || rewritten, history: [...variant.history, { content: variant.content, feedback: feedback || "", retention, createdAt: new Date().toISOString() }].slice(-20) } : variant)
                : generatedVariants.map((content) => ({ content, history: [] }));
            const serialized = nextVariants.map((variant, index) => `## ${index + 1}\n${variant.content}`).join("\n\n");
            setShowPreviousRewrite(false);
            onUpdate({ transcriptRewriteStatus: "completed", transcriptRewrite: serialized || rewritten, transcriptRewriteVariants: nextVariants, transcriptRewriteSelectedIndex: mode === "selected" ? selectedIndex : 0, transcriptRewriteHistory: nextHistory, transcriptRewriteFeedback: feedback, transcriptRewriteError: undefined });
        } catch (error) {
            if (request !== transcriptRewriteRequestRef.current) return;
            onUpdate({ transcriptRewriteStatus: "failed", transcriptRewriteError: controller.signal.aborted ? "请求等待超过 120 秒，已停止等待；请检查模型渠道后重试。" : reviewErrorMessage(error) });
        } finally {
            window.clearTimeout(timeoutId);
        }
    };
    const confirmRewriteSkill = () => {
        const skill = availableSkills.find((item) => item.skillId === selectedRewriteSkillId);
        if (!skill) {
            message.warning("请先选择一个 Skill");
            return;
        }
        const selectedModel = normalizeModelOptionValue(state.transcriptRewriteModel || rewriteConfig.textModel, rewriteConfig.channels);
        onUpdate({ transcriptRewriteSkillId: skill.skillId, transcriptRewriteSkillName: skill.skillName, transcriptRewriteModel: selectedModel || undefined });
        setRewriteSetupOpen(false);
    };
    const startConfiguredRewrite = () => {
        if (!state.transcriptRewriteSkillId) {
            openRewriteSetup();
            return;
        }
        if (!state.transcriptRewriteModel) {
            message.warning("请先选择文字模型");
            return;
        }
        if (missingRequiredMaterials.length) {
            openMaterials();
            return;
        }
        void rewriteTranscript({ skillId: state.transcriptRewriteSkillId, model: state.transcriptRewriteModel });
    };

    const rerunRewrite = () => {
        if (!state.transcriptRewriteSkillId || !state.transcriptRewriteModel) {
            startConfiguredRewrite();
            return;
        }
        void rewriteTranscript({ skillId: state.transcriptRewriteSkillId, model: state.transcriptRewriteModel }, "selected");
    };
    const updateTranscriptText = (text: string) => {
        const patch: Partial<FrameScriptVideoReviewNodeState> = {};
        if (state.draft?.transcript) {
            patch.draft = { ...state.draft, transcript: { ...state.draft.transcript, text } };
        }
        if (state.breakdown?.transcript) {
            patch.breakdown = { ...state.breakdown, transcript: { ...state.breakdown.transcript, text } };
        }
        if (Object.keys(patch).length) onUpdate(patch);
    };
    const selectedRewriteHistory = state.transcriptRewriteVariants?.[state.transcriptRewriteSelectedIndex || 0]?.history.map((entry) => entry.content)
        || (state.transcriptRewriteHistory || []).map((entry) => entry.content);
    const rewritePanelOptions: Omit<TranscriptPanelProps, "transcript"> = {
        rewrite: state.transcriptRewrite,
        rewriteHistory: selectedRewriteHistory,
        rewriteVersions: state.transcriptRewriteVariants?.map((variant) => variant.history.length + 1) || [],
        showPreviousRewrite,
        onTogglePreviousRewrite: () => setShowPreviousRewrite((value) => !value),
        feedback,
        onFeedbackChange: setFeedback,
        materials: state.transcriptRewriteMaterials,
        onOpenMaterials: openMaterials,
        onRewriteAgain: rerunRewrite,
        rewriteStatus: state.transcriptRewriteStatus,
        rewriteError: state.transcriptRewriteError,
        skillName: state.transcriptRewriteSkillName,
        model: state.transcriptRewriteModel,
        rewriteCount: state.transcriptRewriteCount || 1,
        onRewriteCountChange: (count: number) => onUpdate({ transcriptRewriteCount: count }),
        selectedRewriteIndex: state.transcriptRewriteSelectedIndex || 0,
        onSelectRewrite: (index: number) => {
            setShowPreviousRewrite(false);
            onUpdate({ transcriptRewriteSelectedIndex: index });
        },
        onOpenRewriteSetup: openRewriteSetup,
        onModelChange: (model: string) => onUpdate({ transcriptRewriteModel: model, transcriptRewriteError: undefined }),
        onTranscriptChange: updateTranscriptText,
        onStartRewrite: startConfiguredRewrite,
        onOpenModelSettings: () => navigateToSettings({ section: "models" }),
        onExport: addFrameScriptTranscriptNode ? (content: string) => void exportTranscript(content) : undefined,
    };

    return <Modal open={open} onCancel={onClose} footer={null} width="min(1120px, calc(100vw - 32px))" centered title={null} className="framescript-review-modal">
        <div className="flex max-h-[min(780px,calc(100vh-48px))] min-h-[560px] overflow-hidden rounded-[26px] border border-[#a394ff]/20 bg-[radial-gradient(circle_at_top_left,rgba(105,83,255,0.16),transparent_34%),linear-gradient(145deg,#171724,#0e0f15_68%)] text-white shadow-[0_32px_100px_rgba(0,0,0,0.58)]">
            <section className="flex min-w-0 flex-1 flex-col">
                <header className="flex items-start justify-between gap-4 border-b border-[#a394ff]/15 bg-[linear-gradient(90deg,rgba(105,83,255,0.10),transparent_55%)] px-6 py-5">
                    <div className="min-w-0"><div className="flex items-center gap-3 text-lg font-semibold tracking-[-0.02em]"><span className="grid size-8 place-items-center rounded-[10px] bg-[linear-gradient(145deg,rgba(105,83,255,0.42),rgba(61,45,111,0.58))] text-[#b4a6ff] ring-1 ring-[#a394ff]/25"><Scissors className="size-4" /></span>视频拆解</div><p className="mt-2 text-xs text-white/45">候选帧提取完成即可复核；语音转写由你手动开始。</p>{((state.status === "error" && state.errorMessage) || (state.transcriptionStatus === "failed" && state.transcriptionError)) ? <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300/25 bg-amber-300/8 px-3 py-2 text-xs leading-5 text-amber-100"><AlertCircle className="mt-0.5 size-3.5 shrink-0" />{state.status === "error" ? state.errorMessage : state.transcriptionError}</div> : null}</div>
                    <div className="flex items-center gap-2"><TranscriptionAction status={state.transcriptionStatus} transcriptReady={Boolean(draft?.transcript)} disabled={!draft || staleSource || busy} onClick={requestTranscription} /><StatusPill status={state.status} /></div>
                </header>

                <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-5">
                    {!source || !sourceRef ? <EmptyState icon={<PlaySquare className="size-5" />} title="连接一个已保存的视频" description="请从视频节点拖线到 FrameScript 节点；原视频会由宿主按权限读取。" />
                        : state.breakdown && !staleSource && (!revisingFrames || !draft) ? <AnalysisResult summary={summary} segments={state.breakdown.analysis.segments} reviewFrames={state.review?.frames?.length ? state.review.frames : state.breakdown.review.frames} thumbnails={thumbnails} selectedCount={state.review?.frames?.length || state.breakdown.review.frames.length} transcript={state.breakdown.transcript?.text || draft?.transcript?.text} rewritePanelOptions={rewritePanelOptions} onAddFrames={() => { setSelectedIds(state.review?.frames?.map((frame) => frame.id) || state.breakdown?.review.frames.map((frame) => frame.id) || []); setRevisingFrames(true); }} />
                        : !draft || staleSource ? <PrepareState source={source} busy={busy} staleSource={staleSource} onPrepare={() => void prepare()} />
                        : <CandidateReview draft={draft} thumbnails={thumbnails} thumbnailFailures={thumbnailFailures} selectedSet={selectedSet} transcript={draft.transcript?.text} rewritePanelOptions={rewritePanelOptions} onToggle={(id) => { if (state.breakdown?.review.frames.some((frame) => frame.id === id)) { message.info("已分析画面会保留，不会重复提交"); return; } setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]); }} />}
                </div>

                {draft && (!state.breakdown || revisingFrames) && !staleSource ? <footer className="flex items-center justify-between gap-4 border-t border-[#a394ff]/15 bg-black/10 px-6 py-4">
                    <div className="min-w-0 text-xs text-white/45">{draft.transcript ? <span className="inline-flex items-center gap-1 text-emerald-300/90"><Waves className="size-3.5" />原视频音频已转写</span> : transcriptionPending ? <span className="inline-flex items-center gap-1 text-violet-200"><LoaderCircle className="size-3.5 animate-spin" />候选帧可先复核，音频正在转写</span> : state.transcriptionError ? <span className="text-amber-200/90">{state.transcriptionError}</span> : draft.warnings?.[0] ? <span className="text-amber-200/90">{draft.warnings[0].message}</span> : "未检测到可用语音转写"}<span className="ml-3 hidden text-white/35 xl:inline">确认后开始逐帧分析，完成后可生成分镜复刻。</span></div>
                    <div className="flex items-center gap-2">
                        {state.review && reviewMatchesSelection && !(state.breakdown && revisingFrames) ? <button type="button" disabled={busy || !selectedPreviewsReady || !addFrameScriptImageNodes} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#a394ff]/45 bg-[#6b56f5]/[0.08] px-3 text-xs font-semibold text-[#c3b9ff] disabled:opacity-50" onClick={() => void exportConfirmedFrames()}><Download className="size-3.5" />导出已确认分镜</button> : null}
                        {state.review && reviewMatchesSelection ? <button type="button" disabled className="hidden h-9 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-xs font-semibold text-white/45 sm:inline-flex" title="完成逐帧分析后可导出分镜复刻"><Clapperboard className="size-3.5" />分析后导出分镜复刻</button> : null}
                        {state.breakdown && revisingFrames ? <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-xs text-white/65" onClick={() => { setSelectedIds(state.review?.frames.map((frame) => frame.id) || state.breakdown?.review.frames.map((frame) => frame.id) || []); setRevisingFrames(false); }}>返回已分析结果</button> : null}
                        {reviewMatchesSelection ? <button type="button" disabled={busy || transcriptionPending || !selectedPreviewsReady || Boolean(state.breakdown && !selectedIds.some((id) => !(state.breakdown?.review.frames || []).some((frame) => frame.id === id)))} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-r from-[#684fff] to-[#2477f2] px-4 text-xs font-semibold text-white shadow-[0_8px_20px_rgba(63,91,255,0.22)] disabled:opacity-50" onClick={() => void analyze()}>{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}{state.breakdown ? "分析新增画面" : "开始逐帧分析"}</button>
                            : <button type="button" disabled={!selectedCount || busy || transcriptionPending || !selectedPreviewsReady} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-r from-[#684fff] to-[#2477f2] px-4 text-xs font-semibold text-white shadow-[0_8px_20px_rgba(63,91,255,0.22)] disabled:opacity-50" onClick={() => void confirm()}><Check className="size-3.5" />确认 {selectedCount} 个候选画面</button>}
                    </div>
                </footer> : null}
                {draft && state.breakdown && !revisingFrames && activeReview && reviewMatchesSelection && !staleSource ? <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[#a394ff]/15 bg-black/10 px-6 py-4"><button type="button" disabled={busy} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-xs font-semibold text-white/70 hover:border-[#a394ff]/45 hover:text-white disabled:opacity-50" onClick={() => { setSelectedIds(activeReview.frames.map((frame) => frame.id)); setRevisingFrames(true); }}><RefreshCw className="size-3.5" />补选分镜画面</button><div className="flex flex-wrap items-center justify-end gap-3"><button type="button" disabled={!selectedPreviewsReady || !addFrameScriptImageNodes} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#a394ff]/45 bg-[#6b56f5]/[0.08] px-3 text-xs font-semibold text-[#c3b9ff] disabled:opacity-50" onClick={() => void exportConfirmedFrames()}><Download className="size-3.5" />导出确认分镜图片</button><button type="button" disabled={!selectedPreviewsReady || !addFrameScriptStoryboardNode} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-r from-[#684fff] to-[#2477f2] px-3 text-xs font-semibold text-white shadow-[0_8px_20px_rgba(63,91,255,0.22)] disabled:opacity-50" onClick={() => void exportStoryboard()}><Clapperboard className="size-3.5" />导出分镜复刻</button></div></footer> : null}
            </section>
        </div>
        <RewriteSetupModal open={rewriteSetupOpen} skills={availableSkills} skillsLoading={skillsLoading} skillsLoadError={skillsLoadError} selectedSkillId={selectedRewriteSkillId} onClose={() => setRewriteSetupOpen(false)} onSelectSkill={setSelectedRewriteSkillId} onConfirm={confirmRewriteSkill} />
        <RewriteMaterialsModal open={materialsOpen} materials={materialsDraft} retention={retentionDraft} skillName={state.transcriptRewriteSkillName} onChange={setMaterialsDraft} onRetentionChange={setRetentionDraft} onClose={() => setMaterialsOpen(false)} onSave={saveMaterials} />
    </Modal>;
}

function PrepareState({ source, busy, staleSource, onPrepare }: { source: CanvasNodeData; busy: boolean; staleSource: boolean; onPrepare: () => void }) {
    return <div className="mx-auto flex max-w-md flex-col items-center py-20 text-center"><span className="grid size-14 place-items-center rounded-2xl bg-[#6b56f5]/15 text-[#c3b9ff]"><Frame className="size-6" /></span><h3 className="mt-5 text-base font-semibold">{staleSource ? "视频内容已更新" : "准备候选帧复核"}</h3><p className="mt-2 text-sm leading-6 text-white/50">{staleSource ? "重新扫描后会使旧的人工确认失效。" : `将为「${source.title || "当前视频"}」先提取候选画面；完成后立即开放复核，语音转写可手动开始。`}</p><button type="button" disabled={busy} className="mt-6 inline-flex h-10 items-center gap-2 rounded-lg bg-gradient-to-r from-[#684fff] to-[#2477f2] px-4 text-sm font-semibold text-white shadow-[0_8px_20px_rgba(63,91,255,0.22)] disabled:opacity-50" onClick={onPrepare}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : <PlaySquare className="size-4" />}{busy ? "正在提取候选帧…" : staleSource ? "重新准备复核" : "提取候选帧"}</button></div>;
}

function RewriteSetupModal({ open, skills, skillsLoading, skillsLoadError, selectedSkillId, onClose, onSelectSkill, onConfirm }: { open: boolean; skills: Skill[]; skillsLoading: boolean; skillsLoadError: string; selectedSkillId: string; onClose: () => void; onSelectSkill: (skillId: string) => void; onConfirm: () => void }) {
    const [query, setQuery] = useState("");
    const selectedSkill = skills.find((skill) => skill.skillId === selectedSkillId);
    const visibleSkills = skills.filter((skill) => `${skill.skillName}\n${skill.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    return <Modal open={open} onCancel={onClose} footer={null} centered zIndex={1100} width="min(720px, calc(100vw - 32px))" title={null} className="framescript-rewrite-setup-modal">
        <div className="rounded-2xl border border-[#a394ff]/25 bg-[linear-gradient(145deg,#1b1929,#0e0f15)] p-5 text-white shadow-[0_32px_100px_rgba(0,0,0,0.55)]">
            <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#6b56f5]/20 text-[#c9c0ff]"><BookOpenCheck className="size-5" /></span><div><h3 className="text-lg font-bold">选择改写 Skill</h3><p className="mt-1 text-xs leading-5 text-white/50">选择后确认保存；模型和改写操作在原视频转写框下方完成。</p></div></div>
            <section className="mt-5"><div className="flex items-center justify-between gap-3"><h4 className="text-sm font-semibold">选择 Skill</h4>{selectedSkill ? <span className="text-xs text-[#c9c0ff]">已选：{selectedSkill.skillName}</span> : null}</div><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skill 名称或说明" className="mt-3 h-9 w-full rounded-lg border border-white/12 bg-[#11121a] px-3 text-xs text-white outline-none placeholder:text-white/30 focus:border-[#a394ff]/60" />{skillsLoading ? <div className="mt-3 flex items-center gap-2 text-xs text-white/55"><LoaderCircle className="size-4 animate-spin" />正在加载技能列表…</div> : skillsLoadError ? <p className="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2 text-xs leading-5 text-amber-200">技能列表读取失败：{skillsLoadError}</p> : visibleSkills.length ? <div className="thin-scrollbar mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">{visibleSkills.map((skill) => <button type="button" key={skill.skillId} aria-pressed={selectedSkillId === skill.skillId} onClick={() => onSelectSkill(skill.skillId)} className={`w-full rounded-xl border p-3 text-left transition ${selectedSkillId === skill.skillId ? "border-[#a394ff]/70 bg-[#6b56f5]/15" : "border-white/10 bg-black/15 hover:border-white/25"}`}><div className="flex items-center gap-2 text-sm font-semibold"><BookOpenCheck className="size-4 text-[#c9c0ff]" />{skill.skillName}<span className="ml-auto text-[10px] font-normal text-white/35">v{skill.version}</span></div><p className="mt-1 line-clamp-2 text-xs leading-5 text-white/50">{skill.description || "未填写技能说明"}</p></button>)}</div> : skills.length ? <p className="mt-3 rounded-lg border border-dashed border-white/15 px-3 py-3 text-xs leading-5 text-white/45">没有匹配的 Skill。</p> : <p className="mt-3 rounded-lg border border-dashed border-white/15 px-3 py-3 text-xs leading-5 text-white/45">当前没有已添加的 Skill。请先在技能库添加一个改写类 Skill，再返回此处选择。</p>}</section>
            <div className="mt-6 flex justify-end gap-3"><button type="button" className="h-10 rounded-lg border border-white/15 px-4 text-sm text-white/65 transition hover:bg-white/[0.06]" onClick={onClose}>取消</button><button type="button" disabled={!selectedSkillId} className="inline-flex h-10 items-center gap-2 rounded-lg bg-gradient-to-r from-[#684fff] to-[#2477f2] px-4 text-sm font-semibold text-white shadow-[0_8px_20px_rgba(63,91,255,0.22)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45" onClick={onConfirm}><Check className="size-4" />确认 Skill 选择</button></div>
        </div>
    </Modal>;
}

type RewriteMaterials = NonNullable<FrameScriptVideoReviewNodeState["transcriptRewriteMaterials"]>;

function RewriteMaterialsModal({ open, materials, retention, skillName, onChange, onRetentionChange, onClose, onSave }: { open: boolean; materials: RewriteMaterials; retention: NonNullable<FrameScriptVideoReviewNodeState["transcriptRewriteRetention"]>; skillName?: string; onChange: (value: RewriteMaterials) => void; onRetentionChange: (value: NonNullable<FrameScriptVideoReviewNodeState["transcriptRewriteRetention"]>) => void; onClose: () => void; onSave: () => void }) {
    const [showOptional, setShowOptional] = useState(false);
    const update = (key: keyof RewriteMaterials, value: string) => onChange({ ...materials, [key]: value });
    const inputClass = "mt-1.5 h-10 w-full rounded-lg border border-white/15 bg-[#11121a] px-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-[#a394ff]/70";
    const labelClass = "block text-xs font-semibold text-white/75";
    const retentionDescription = {
        skill: "按当前 Skill 对原文的要求处理。",
        light: "保留主要事实和顺序，只优化措辞。",
        structure: "参考原文的开头、节奏和结构，用补充资料重写内容。",
        major: "只参考主题或切入角度，重新组织文案。",
    }[retention];
    return <AppModal open={open} onCancel={onClose} footer={null} centered destroyOnHidden width="min(560px, calc(100vw - 32px))" title={null} className="framescript-rewrite-setup-modal">
        <div className="rounded-2xl border border-[#a394ff]/25 bg-[linear-gradient(145deg,#1b1929,#0e0f15)] p-5 text-white shadow-[0_32px_100px_rgba(0,0,0,0.55)]">
            <header className="flex items-start justify-between gap-4"><div><h3 className="inline-flex items-center gap-2 text-lg font-bold"><FilePlus2 className="size-5 text-[#b4a6ff]" />补充资料</h3><div className="mt-2 flex items-center gap-2 text-sm font-semibold">{skillName || "当前改写 Skill"}<span className="rounded-full border border-amber-300/35 bg-amber-300/10 px-2 py-0.5 text-[10px] font-medium text-amber-200">必填 2 项</span></div></div><button type="button" aria-label="关闭" onClick={onClose} className="rounded-lg p-1 text-white/55 hover:bg-white/10 hover:text-white"><span aria-hidden="true">×</span></button></header>
            <p className="mt-3 rounded-lg border border-[#a394ff]/20 bg-[#a394ff]/[0.06] px-3 py-2 text-xs leading-5 text-white/60">改写前会先从原文提取人物设定，并主观推断可能受众；证据不足时不会臆造。你也可以在「更多资料」中补充或修正。</p>
            <div className="mt-5 space-y-4">
                <label className={labelClass}>产品 <span className="text-rose-400">*</span><input autoFocus value={materials.product || ""} maxLength={100} onChange={(event) => update("product", event.target.value)} placeholder="请输入产品名称" className={inputClass} /></label>
                <label className={labelClass}>核心卖点 <span className="text-rose-400">*</span><textarea value={materials.benefits || ""} maxLength={300} onChange={(event) => update("benefits", event.target.value)} placeholder="填写已确认的产品特点" className="mt-1.5 min-h-24 w-full resize-y rounded-lg border border-white/15 bg-[#11121a] px-3 py-2.5 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-[#a394ff]/70" /><span className="mt-1 block text-right text-[10px] text-white/35">{(materials.benefits || "").length}/300</span></label>
            </div>
            <section className="mt-4 border-t border-white/10 pt-4"><label className={labelClass}>原文保留程度<select value={retention} onChange={(event) => onRetentionChange(event.target.value as typeof retention)} className={inputClass}><option value="skill">跟随 Skill（默认）</option><option value="light">轻度改写</option><option value="structure">结构仿写</option><option value="major">大幅重写</option></select></label><p className="mt-2 text-[11px] leading-5 text-white/45">{retentionDescription}</p></section>
            <div className="mt-4 border-t border-white/10 pt-3"><button type="button" aria-expanded={showOptional} onClick={() => setShowOptional((value) => !value)} className="flex w-full items-center gap-2 text-left text-sm font-semibold text-white/75"><span className="text-[#c3b9ff]">{showOptional ? "▾" : "▸"}</span>更多资料（选填）</button><p className="ml-5 mt-1 text-[11px] text-white/40">人设、目标人群修正、价格、产地、认证和补充要求</p>{showOptional ? <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className={`${labelClass} sm:col-span-2`}>人设（选填，默认从原文提取）<textarea value={materials.persona || ""} maxLength={300} onChange={(event) => update("persona", event.target.value)} placeholder="如需修正原文提取的人物身份、关系、动机或表达风格，可在此填写" className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-white/15 bg-[#11121a] px-3 py-2.5 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-[#a394ff]/70" /></label><label className={`${labelClass} sm:col-span-2`}>目标人群判断（选填，默认从原文推断）<input value={materials.audience || ""} maxLength={160} onChange={(event) => update("audience", event.target.value)} placeholder="可填写你希望面向的人群；模型默认根据原文主观推断" className={inputClass} /></label><label className={labelClass}>价格<input value={materials.price || ""} onChange={(event) => update("price", event.target.value)} placeholder="选填" className={inputClass} /></label><label className={labelClass}>产地<input value={materials.origin || ""} onChange={(event) => update("origin", event.target.value)} placeholder="选填" className={inputClass} /></label><label className={labelClass}>认证<input value={materials.certification || ""} onChange={(event) => update("certification", event.target.value)} placeholder="选填" className={inputClass} /></label><label className={`${labelClass} sm:col-span-2`}>补充要求<textarea value={materials.requirements || ""} maxLength={500} onChange={(event) => update("requirements", event.target.value)} placeholder="例如：语气自然，避免夸张承诺" className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-white/15 bg-[#11121a] px-3 py-2.5 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-[#a394ff]/70" /></label></div> : null}</div>
            <p className="mt-3 text-[11px] text-white/40">未填写的选填资料不会写入文案。</p>
            <footer className="mt-5 flex justify-end gap-2 border-t border-white/10 pt-4"><button type="button" onClick={onClose} className="h-10 rounded-lg border border-white/15 px-4 text-sm text-white/70 hover:bg-white/[0.06]">取消</button><button type="button" onClick={onSave} className="h-10 rounded-lg bg-gradient-to-r from-[#684fff] to-[#2477f2] px-5 text-sm font-semibold text-white">保存资料</button></footer>
        </div>
    </AppModal>;
}

type TranscriptPanelProps = { transcript: string; onTranscriptChange: (value: string) => void; rewrite?: string; rewriteHistory?: string[]; rewriteVersions: number[]; showPreviousRewrite?: boolean; onTogglePreviousRewrite?: () => void; feedback?: string; onFeedbackChange?: (value: string) => void; materials?: RewriteMaterials; onOpenMaterials: () => void; onRewriteAgain: () => void; rewriteStatus?: FrameScriptVideoReviewNodeState["transcriptRewriteStatus"]; rewriteError?: string; skillName?: string; model?: string; rewriteCount: number; onRewriteCountChange: (count: number) => void; selectedRewriteIndex: number; onSelectRewrite: (index: number) => void; onOpenRewriteSetup: () => void; onModelChange: (model: string) => void; onStartRewrite: () => void; onOpenModelSettings: () => void; onExport?: (content: string) => void };

type RewriteComposition = { hookIndex: number; includeHook: boolean };

function RewriteResultCards({ variants, versions, selectedIndex, onSelect, compositions, onSelectHook, onUseMainOnly, onCopy }: {
    variants: RewriteVariant[];
    versions: number[];
    selectedIndex: number;
    onSelect: (index: number) => void;
    compositions: Record<number, RewriteComposition>;
    onSelectHook: (variantIndex: number, hookIndex: number) => void;
    onUseMainOnly: (variantIndex: number) => void;
    onCopy: (variantIndex: number, mode: "main" | "composed") => void;
}) {
    return <div className="mt-3 space-y-4">{variants.map((variant, index) => {
        const item = rewriteCard(variant);
        const selected = index === selectedIndex;
        const composition = compositions[index] || { hookIndex: 0, includeHook: false };
        return <article key={`${variant.index}-${variant.content.slice(0, 24)}`} className={`overflow-hidden rounded-xl border transition ${selected ? "border-[#a394ff]/75 bg-[#111322] ring-1 ring-[#a394ff]/45" : "border-white/10 bg-[#11121a]/70 hover:border-white/20"}`}>
            <header className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
                <button type="button" onClick={() => onSelect(index)} className="flex min-w-0 items-center gap-2 text-left">
                    <span className={`shrink-0 text-lg font-bold tabular-nums ${selected ? "text-[#a394ff]" : "text-white/55"}`}>{String(index + 1).padStart(2, "0")}</span>
                    <span className="max-w-40 shrink truncate whitespace-nowrap text-sm font-bold text-white">{item.title}</span>
                    {selected ? <span className="shrink-0 whitespace-nowrap rounded bg-[#6b56f5]/15 px-1.5 py-1 text-[10px] font-semibold leading-none text-[#c3b9ff]">已选中</span> : null}
                    {item.audience ? <span title={`人群：${item.audience}`} className="hidden min-w-0 max-w-[24rem] truncate whitespace-nowrap rounded bg-white/[0.05] px-2 py-1 text-[10px] text-white/55 sm:inline">人群：{item.audience}</span> : null}
                    {item.angle ? <span title={`转化角度：${item.angle}`} className="hidden min-w-0 max-w-48 truncate whitespace-nowrap rounded bg-white/[0.05] px-2 py-1 text-[10px] text-white/55 lg:inline">转化角度：{item.angle}</span> : null}
                </button>
                <div className="flex shrink-0 items-center gap-2">
                    <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold text-white/55">v{versions[index] || 1}</span>
                    <button type="button" aria-label={`复制第 ${index + 1} 条组合文案`} title={composition.includeHook ? `复制开头 ${composition.hookIndex + 1} + 主文案` : "复制仅主文案"} onClick={() => onCopy(index, "composed")} className="inline-flex size-7 items-center justify-center rounded-md border border-white/12 text-white/60 hover:border-[#a394ff]/45 hover:bg-[#6b56f5]/15 hover:text-white"><Copy className="size-4" /></button>
                    <button type="button" aria-label={`选择改写文案 ${index + 1}`} aria-pressed={selected} onClick={() => onSelect(index)} className={`grid size-6 place-items-center rounded-full border ${selected ? "border-[#a394ff] bg-[#6b56f5] text-white" : "border-white/30"}`}>{selected ? <Check className="size-3.5" /> : null}</button>
                </div>
            </header>
            <div className="grid divide-y divide-white/[0.08] xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.65fr)_minmax(0,0.9fr)] xl:divide-x xl:divide-y-0">
                <section className="min-w-0 p-4">
                    <div className="flex items-center justify-between text-[11px] font-semibold text-[#b69aff]"><span>黄金 3 秒</span><span className="text-white/40">{item.hooks.length}/5 个可选开头</span></div>
                    {item.hooks.length < 5 ? <p role="status" className="mt-1 text-[11px] leading-5 text-amber-200/80">模型本次只返回了 {item.hooks.length} 个开头；重新改写时会校验必须补齐 5 个。</p> : null}
                    <p className="mt-1 text-[10px] text-white/35">选择一个，与主文案自由搭配</p>
                    <ol className="mt-3 space-y-2">
                        {Array.from({ length: 5 }, (_, hookIndex) => {
                            const hook = item.hooks[hookIndex];
                            const active = composition.includeHook && composition.hookIndex === hookIndex;
                            return <li key={hookIndex}>
                                    <button type="button" disabled={!hook} aria-pressed={active} onClick={() => { if (hook) { onSelect(index); onSelectHook(index, hookIndex); } }} className={`flex w-full gap-2 rounded-md px-1.5 py-0.5 text-left text-[15px] leading-6 transition ${hook ? "hover:bg-white/[0.04]" : "cursor-default"} ${active ? "bg-[#6b56f5]/15 text-white" : hook ? "text-white/65" : "text-white/25"}`}>
                                    <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border text-[9px] ${active ? "border-[#a394ff] bg-[#6b56f5] text-white" : "border-white/25 text-[#9e8cff]"}`}>{active ? <Check className="size-3" /> : hookIndex + 1}</span>
                                    <span>{hook || "未生成此开头"}</span>
                                </button>
                            </li>;
                        })}
                    </ol>
                </section>
                <section className="min-w-0 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold text-[#b69aff]">
                        <span>60 秒口播 · 主文案</span>
                        <div className="flex items-center gap-2">
                            <button type="button" aria-pressed={!composition.includeHook} onClick={() => onUseMainOnly(index)} className={`rounded-md border px-2 py-1 text-[10px] ${composition.includeHook ? "border-white/10 text-white/45" : "border-[#a394ff]/40 bg-[#6b56f5]/15 text-[#d5ccff]"}`}>仅主文案</button>
                            <button type="button" aria-label={`复制第 ${index + 1} 条主文案`} title="复制仅主文案" onClick={() => onCopy(index, "main")} className="inline-flex size-6 items-center justify-center rounded-md border border-white/12 text-white/60 hover:border-[#a394ff]/45 hover:bg-[#6b56f5]/15 hover:text-white"><Copy className="size-3.5" /></button>
                        </div>
                    </div>
                    {item.narration ? <div className="mt-3 space-y-2 text-[15px] leading-6 text-white/80">{item.narration.split(/\n\s*\n/).map((paragraph, paragraphIndex) => <p key={paragraphIndex} className="whitespace-pre-wrap">{paragraph}</p>)}</div> : <p className="mt-3 text-xs leading-5 text-amber-200/70">未返回主文案，请重新生成后再复制或输出。</p>}
                    {composition.includeHook && item.hooks[composition.hookIndex] ? <p className="mt-3 border-t border-white/10 pt-2 text-[10px] text-[#c3b9ff]/70">当前组合：开头 {composition.hookIndex + 1} + 主文案</p> : null}
                </section>
                <section className="min-w-0 p-4">
                    <div className="flex items-center justify-between text-[11px] font-semibold text-[#b69aff]"><span>拍摄建议</span><span className="text-white/30">{item.filming.length ? `${item.filming.length} 项` : "—"}</span></div>
                    {item.filming.length ? <dl className="mt-3 space-y-2">{item.filming.map((advice, adviceIndex) => <div key={`${advice.label}-${adviceIndex}`} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 text-[11px] leading-5"><dt className="w-[4.5rem] rounded bg-white/[0.06] px-1.5 py-0.5 text-center text-white/50">{advice.label}</dt><dd className="min-w-0 text-white/65">{advice.value}</dd></div>)}</dl> : <p className="mt-3 text-xs leading-5 text-white/35">未返回拍摄建议</p>}
                </section>
            </div>
        </article>;
    })}</div>;
}

function TranscriptPanel({ transcript, onTranscriptChange, rewrite, rewriteHistory = [], rewriteVersions, showPreviousRewrite, onTogglePreviousRewrite, feedback, onFeedbackChange, materials, onOpenMaterials, onRewriteAgain, rewriteStatus, rewriteError, skillName, model, rewriteCount, onRewriteCountChange, selectedRewriteIndex, onSelectRewrite, onOpenRewriteSetup, onModelChange, onStartRewrite, onOpenModelSettings, onExport }: TranscriptPanelProps) {
    const rewriting = rewriteStatus === "pending";
    const [transcriptExpanded, setTranscriptExpanded] = useState(false);
    const [feedbackExpanded, setFeedbackExpanded] = useState(false);
    const [rewriteCountInput, setRewriteCountInput] = useState(String(rewriteCount));
    const [compositions, setCompositions] = useState<Record<number, RewriteComposition>>({});
    useEffect(() => { setRewriteCountInput(String(rewriteCount)); }, [rewriteCount]);
    const config = useEffectiveConfig();
    const modelAvailable = Boolean(model && selectableModelsByCapability(config, "text").includes(model));
    const skillButtonLabel = skillName || "选择 Skill";
    const requiredMissing = [materials?.product, materials?.benefits].filter((value) => !value?.trim()).length;
    const rewriteReady = Boolean(rewrite?.trim());
    const displayedRewrite = showPreviousRewrite && rewriteHistory.length ? rewriteHistory[rewriteHistory.length - 1] : rewrite;
    const variants = rewriteVariants(displayedRewrite);
    const selectedIndex = Math.min(Math.max(selectedRewriteIndex, 0), Math.max(variants.length - 1, 0));
    const compositionFor = (variantIndex: number) => compositions[variantIndex] || { hookIndex: 0, includeHook: false };
    const outputFor = (variantIndex: number, mode: "main" | "composed" = "composed") => {
        const item = variants[variantIndex] ? rewriteCard(variants[variantIndex]) : undefined;
        if (!item?.narration) return "";
        const composition = compositionFor(variantIndex);
        const hook = mode === "composed" && composition.includeHook ? item.hooks[composition.hookIndex] : "";
        return hook ? `${hook}\n\n${item.narration}` : item.narration;
    };
    const selectedOutput = outputFor(selectedIndex);
    const copyOutput = (variantIndex: number, mode: "main" | "composed") => {
        const content = outputFor(variantIndex, mode);
        if (!content) {
            message.warning("当前结果没有可复制的主文案");
            return;
        }
        copyToClipboard(content);
        const composition = compositionFor(variantIndex);
        message.success(mode === "main" ? "主文案已复制" : composition.includeHook ? `开头 ${composition.hookIndex + 1} + 主文案已复制` : "主文案已复制");
    };
    return <div className="mt-5 space-y-3"><style>{`.framescript-review-modal .mt-5.space-y-3 > section:first-of-type > header { min-height: 24px; align-items: center; } .framescript-review-modal .mt-5.space-y-3 > section:first-of-type > header > h3 { display: inline-flex; height: 24px; align-items: center; line-height: 1; }`}</style>
        <section className="rounded-2xl border border-white/10 bg-black/15 p-5"><header className="flex items-center justify-between gap-3"><h3 className="text-base font-bold text-white">原视频语音转文字</h3><div className="flex items-center gap-2"><button type="button" onClick={onOpenMaterials} className="inline-flex h-6 items-center gap-1.5 rounded-md border border-[#a394ff]/60 bg-[#6b56f5]/10 px-2 text-xs font-semibold text-white hover:bg-[#6b56f5]/20"><span>▤</span>补充资料<span className={`rounded-full px-1.5 py-0.5 text-[10px] leading-none ${requiredMissing ? "bg-amber-300/15 text-amber-200" : "bg-emerald-300/15 text-emerald-200"}`}>{requiredMissing ? `缺${requiredMissing}项` : "资料已完善"}</span></button><button type="button" disabled={rewriting} title={skillName ? `当前 Skill：${skillName}` : "选择用于改写的 Skill"} className="inline-flex h-6 max-w-[16rem] items-center gap-1.5 rounded-md border border-[#a394ff]/65 bg-[#6b56f5]/10 px-2 text-xs font-bold text-white hover:bg-[#6b56f5]/20 disabled:opacity-50" onClick={onOpenRewriteSetup}><BookOpenCheck className="size-3.5 shrink-0" /><span className="truncate">{skillButtonLabel}</span></button><button type="button" aria-label="复制原视频语音转文字" title="复制转写文本" className="inline-flex size-6 items-center justify-center rounded-md border border-white/12 text-white/70 hover:border-[#a394ff]/45 hover:bg-[#6b56f5]/15 hover:text-white" onClick={() => { copyToClipboard(transcript); message.success("转写文本已复制"); }}><Copy className="size-3.5" /></button></div></header><div className="relative mt-3"><textarea aria-label="编辑原视频语音转文字" value={transcript} disabled={rewriting} onChange={(event) => onTranscriptChange(event.currentTarget.value)} className="block max-h-48 min-h-28 w-full resize-y overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-[#11121a]/45 px-3 py-2 pr-10 text-sm leading-7 text-white/70 outline-none transition focus:border-[#a394ff]/60 focus:bg-[#11121a]/80 disabled:opacity-60" /><button type="button" aria-label="放大编辑原视频语音转文字" title="放大编辑" onClick={() => setTranscriptExpanded(true)} className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md border border-white/15 bg-[#171724]/90 text-white/60 hover:border-[#a394ff]/50 hover:text-white"><Maximize2 className="size-3.5" /></button></div>{!rewriting ? <p className="mt-1 text-[10px] text-white/35">可直接编辑，修改会保存并用于后续改写。</p> : null}<div className="mt-4 grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-[minmax(0,1fr)_112px_auto]"><div><div className="mb-1 flex items-center"><span className="text-xs font-semibold text-white/65">文字模型</span></div><div className="rounded-lg border border-white/12 bg-[#11121a]"><ModelPicker config={config} value={model} onChange={onModelChange} capability="text" fullWidth showSelectedPrice={false} showOptionPrices={false} placeholder="选择文字模型" className="!border-0 !bg-transparent !shadow-none" onMissingConfig={onOpenModelSettings} /></div>{model && !modelAvailable ? <p className="mt-1 text-[11px] text-amber-200">已保存的模型当前不可用，请重新选择。</p> : null}</div><div><div className="mb-1 flex items-center justify-between gap-2"><span className="text-xs font-semibold text-white/65">改写条数</span><span className="text-[10px] text-white/35">1–20</span></div><input aria-label="改写条数" inputMode="numeric" type="number" min={1} max={20} step={1} value={rewriteCountInput} disabled={rewriting} onChange={(event) => { const next = event.currentTarget.value; setRewriteCountInput(next); if (!next) return; const count = Number(next); if (Number.isFinite(count)) { const normalized = Math.max(1, Math.min(20, Math.trunc(count))); setRewriteCountInput(String(normalized)); onRewriteCountChange(normalized); } }} onBlur={() => { if (!rewriteCountInput) { setRewriteCountInput("1"); onRewriteCountChange(1); } }} className="block h-8 w-full rounded-lg border border-white/15 bg-[#11121a] px-3 text-sm text-white outline-none focus:border-[#a394ff]/70 disabled:opacity-50" /></div><button type="button" disabled={rewriting || !modelAvailable} className="inline-flex h-11 items-center justify-center gap-2 self-end rounded-lg bg-gradient-to-r from-[#684fff] to-[#2477f2] px-5 text-sm font-bold text-white disabled:opacity-45" onClick={onStartRewrite}>{rewriting ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{rewriting ? "正在改写" : "开始改写"}</button></div></section>
        <section className="rounded-2xl border border-white/10 bg-black/15 p-5"><div className="flex items-center justify-between gap-3"><h4 className="text-sm font-bold text-white">改写结果</h4>{variants.length > 1 ? <span className="text-xs text-white/45">已生成 {variants.length} 条 · 选择一条继续处理</span> : null}</div>{rewrite ? <RewriteResultCards variants={variants} versions={rewriteVersions} selectedIndex={selectedIndex} onSelect={onSelectRewrite} compositions={compositions} onSelectHook={(variantIndex, hookIndex) => setCompositions((current) => ({ ...current, [variantIndex]: { hookIndex, includeHook: true } }))} onUseMainOnly={(variantIndex) => setCompositions((current) => ({ ...current, [variantIndex]: { ...compositionFor(variantIndex), includeHook: false } }))} onCopy={copyOutput} /> : <div className="mt-3 grid min-h-28 place-items-center rounded-xl border border-white/10 bg-[#11121a]/70 text-xs text-white/40"><span className="inline-flex items-center gap-2"><span className="text-base">▤</span>{rewriting ? "正在生成改写文案…" : "生成后的文案显示在这里"}</span></div>}{rewriteError ? <div role="alert" className="mt-3 rounded-lg border border-amber-300/30 bg-amber-300/[0.07] px-3 py-2 text-xs leading-5 text-amber-200">改写失败：{rewriteError}</div> : null}<div className="mt-4 border-t border-white/10 pt-3"><div className="mb-2 flex items-center justify-between gap-3"><label className="text-xs font-semibold text-white/75">{variants.length > 1 ? `继续调整 · 第 ${selectedIndex + 1} 条` : "继续调整"}</label><button type="button" disabled={rewriting} onClick={onOpenRewriteSetup} title={skillName ? `当前 Skill：${skillName}` : "选择用于改写的 Skill"} className="inline-flex h-7 max-w-[16rem] items-center gap-1.5 rounded-md border border-[#a394ff]/45 px-2 text-[11px] font-semibold text-[#c9c0ff] hover:bg-[#6b56f5]/10 disabled:opacity-50"><BookOpenCheck className="size-3.5 shrink-0" /><span className="truncate">{skillName || "选择 Skill"}</span></button></div><div className="relative"><textarea aria-label="继续调整要求" value={feedback || ""} onChange={(event) => onFeedbackChange?.(event.target.value)} maxLength={500} placeholder="例如：开头冲突更强，缩短到 60 秒…" className="min-h-20 w-full resize-y rounded-lg border border-white/15 bg-[#11121a] px-3 py-2.5 pr-10 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-[#a394ff]/70" /><button type="button" aria-label="放大编辑继续调整要求" title="放大编辑" onClick={() => setFeedbackExpanded(true)} className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md border border-white/15 bg-[#171724]/90 text-white/60 hover:border-[#a394ff]/50 hover:text-white"><Maximize2 className="size-3.5" /></button></div><div className="mt-2 flex justify-end gap-2"><button type="button" disabled={!rewriteHistory.length} onClick={() => { onTogglePreviousRewrite?.(); }} className="h-8 rounded-lg border border-white/15 px-3 text-xs text-white/65 disabled:opacity-40">{showPreviousRewrite ? "查看当前版" : "查看上一版"}</button><button type="button" disabled={!rewriteReady || rewriting} onClick={onRewriteAgain} className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition disabled:opacity-45 ${rewriting ? "cursor-wait bg-gradient-to-r from-[#684fff] to-[#2477f2] text-white" : "border border-[#a394ff]/40 text-white/80 hover:bg-[#6b56f5]/10"}`}>{rewriting ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}{rewriting ? "正在改写" : "再改一版"}</button></div></div></section>
        <Modal open={transcriptExpanded || feedbackExpanded} onCancel={() => { setTranscriptExpanded(false); setFeedbackExpanded(false); }} footer={null} width="min(900px, calc(100vw - 32px))" centered title={transcriptExpanded ? "编辑原视频语音转文字" : "继续调整要求"} className="framescript-review-modal"><div className="space-y-3"><textarea autoFocus aria-label={transcriptExpanded ? "放大编辑原视频语音转文字" : "放大编辑继续调整要求"} disabled={rewriting} maxLength={transcriptExpanded ? undefined : 500} value={transcriptExpanded ? transcript : feedback || ""} onChange={(event) => transcriptExpanded ? onTranscriptChange(event.currentTarget.value) : onFeedbackChange?.(event.currentTarget.value)} className="min-h-[50vh] w-full resize-y rounded-xl border border-white/15 bg-[#11121a] p-4 text-sm leading-7 text-white outline-none focus:border-[#a394ff]/70 disabled:opacity-60" /><div className="flex justify-end"><button type="button" onClick={() => { setTranscriptExpanded(false); setFeedbackExpanded(false); }} className="h-9 rounded-lg border border-white/15 px-4 text-sm text-white/75">完成</button></div></div></Modal>
        {onExport ? <button type="button" disabled={!rewriteReady || !selectedOutput.trim()} className="flex h-11 w-full items-center justify-between rounded-xl border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-white/80 disabled:opacity-45" onClick={() => onExport(selectedOutput)}><span className="inline-flex items-center gap-2"><ArrowRight className="size-4" />输出到下一个节点</span><span className="text-[11px] text-white/45">{selectedOutput ? compositionFor(selectedIndex).includeHook ? `开头 ${compositionFor(selectedIndex).hookIndex + 1} + 主文案` : "仅主文案" : "暂未生成完整主文案"}</span></button> : null}
    </div>;
}

function CandidateReview({ draft, thumbnails, thumbnailFailures, selectedSet, transcript, rewritePanelOptions, onToggle }: { draft: NonNullable<FrameScriptVideoReviewNodeState["draft"]>; thumbnails: Record<string, string>; thumbnailFailures: Record<string, true>; selectedSet: Set<string>; transcript?: string; rewritePanelOptions: Omit<TranscriptPanelProps, "transcript">; onToggle: (id: string) => void }) {
    return <div><div><h3 className="text-sm font-semibold">候选帧人工复核</h3><p className="mt-1 text-xs text-white/45">只可选择已显示的画面；确认后会生成画面文案和对应语音/台词。</p></div><div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">{draft.frames.map((frame) => { const selected = selectedSet.has(frame.id); const preview = thumbnails[frame.id]; const failed = thumbnailFailures[frame.id]; const ready = Boolean(preview); return <button type="button" key={frame.id} aria-pressed={selected} disabled={!ready && !selected} className={`group relative overflow-hidden rounded-xl border text-left transition disabled:cursor-not-allowed disabled:opacity-55 ${selected ? "border-[#a394ff] bg-[#6b56f5]/[0.08] ring-1 ring-[#a394ff]/70" : "border-white/10 hover:border-white/30"}`} onClick={() => onToggle(frame.id)}><div className="relative bg-white/[0.04]">{preview ? <img src={preview} alt={`${formatTime(frame.timeMs)} 候选画面`} className="block h-auto w-full object-contain" /> : <div className="grid aspect-video size-full place-items-center gap-1 text-[10px] text-white/30"><Frame className="size-4" /><span>{failed ? "预览读取失败" : "预览准备中"}</span></div>}{selected ? <span className="absolute right-2 top-2 grid size-5 place-items-center rounded-full bg-[#a394ff] text-[#181526]"><Check className="size-3" /></span> : null}</div><div className="space-y-1 p-2"><div className="flex justify-between gap-2 text-[11px] font-semibold"><span>{formatTime(frame.timeMs)}</span><span className="text-white/45">{Math.round(frame.score * 100)}%</span></div><div className="truncate text-[10px] text-white/45">{frame.reasons.map(reasonLabel).join(" · ")}</div></div></button>; })}</div>{transcript ? <TranscriptPanel transcript={transcript} {...rewritePanelOptions} /> : draft.warnings?.[0] ? <div className="mt-5 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-3 text-xs leading-5 text-amber-100">候选帧已准备完成，可继续人工复核；{draft.warnings[0].message}</div> : <div className="mt-5 rounded-xl border border-dashed border-white/10 p-3 text-xs text-white/35">当前未检测到可用的原视频语音转文字。</div>}</div>;
}

function AnalysisResult({ summary, segments, reviewFrames, thumbnails, selectedCount, transcript, rewritePanelOptions, onAddFrames }: { summary?: string; segments: AnalysisResult["segments"]; reviewFrames: readonly { id: string; timeMs: number }[]; thumbnails: Record<string, string>; selectedCount: number; transcript?: string; rewritePanelOptions: Omit<TranscriptPanelProps, "transcript">; onAddFrames: () => void }) {
    const [frameOrientations, setFrameOrientations] = useState<Record<string, "portrait" | "landscape">>({});
    const orderedSegments = [...segments].sort((left, right) => left.startMs - right.startMs);
    const frameByTime = new Map(reviewFrames.map((frame) => [frame.timeMs, frame]));
    const frameForSegment = (segment: AnalysisResult["segments"][number], index: number) => {
        const targetTime = segment.keyframe?.timeMs ?? segment.startMs;
        const exact = frameByTime.get(targetTime);
        if (exact) return exact;
        const nearest = reviewFrames
            .map((frame) => ({ frame, distance: Math.abs(frame.timeMs - targetTime) }))
            .sort((left, right) => left.distance - right.distance)[0];
        return nearest?.distance <= 1500 ? nearest.frame : reviewFrames[index];
    };
    const rememberFrameOrientation = (frameId: string, image: HTMLImageElement) => {
        const orientation = image.naturalWidth > image.naturalHeight ? "landscape" : "portrait";
        setFrameOrientations((current) => current[frameId] === orientation ? current : { ...current, [frameId]: orientation });
    };
    const overall = separateVideoScreenText(summary);
    return <div>
        <div className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-full bg-emerald-400/15 text-emerald-300"><CheckCircle2 className="size-4" /></span>
            <div><h3 className="text-sm font-semibold">已生成视频理解上下文</h3><p className="text-xs text-white/45">基于 {selectedCount} 个经人工确认的画面。</p></div><button type="button" onClick={onAddFrames} className="ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[#a394ff]/35 px-3 text-xs text-[#c3b9ff] hover:bg-[#6b56f5]/10"><RefreshCw className="size-3.5" />补选画面</button>
        </div>
        <div className="mt-5 grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-12">
            {orderedSegments.length ? orderedSegments.map((segment, index) => {
                const frame = frameForSegment(segment, index);
                const preview = frame ? thumbnails[frame.id] : undefined;
                const frameId = frame?.id || `${segment.startMs}-${index}`;
                const orientation = frameOrientations[frameId] || "portrait";
                const description = separateVideoScreenText(segment.description);
                const prompt = separateVideoScreenText(segment.prompt);
                return <article key={`${segment.startMs}-${index}`} className={`overflow-hidden rounded-xl border border-white/10 bg-black/20 ${orientation === "landscape" ? "xl:col-span-4" : "xl:col-span-3"}`}>
                    <div className="overflow-hidden bg-black/25">{preview ? <img src={preview} alt={`镜头 ${index + 1} 原始画面`} className="block h-auto w-full object-contain" onLoad={(event) => rememberFrameOrientation(frameId, event.currentTarget)} /> : <div className="grid h-36 w-full place-items-center text-[10px] text-white/35">原帧读取中</div>}</div>
                    <div className="p-3">
                        <div className="flex items-center justify-between gap-2 text-xs"><span className="font-semibold text-[#c3b9ff]">镜头 {index + 1}</span><span className="text-white/40">{formatTime(segment.startMs)}–{formatTime(segment.endMs)}</span></div>
                        <p className="mt-2 line-clamp-4 text-xs leading-5 text-white/75"><span className="text-white/45">画面文案：</span>{prompt.visual || description.visual || "—"}</p>
                        {segment.transcript ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-emerald-200/75"><span className="text-white/45">语音/台词：</span>{segment.transcript}</p> : null}
                    </div>
                </article>;
            }) : <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-xs leading-6 text-white/55">分析已返回结构化分段结果，可连接到 Skill 作为上下文。</div>}
        </div>
        {overall.visual ? <details className="mt-4 rounded-xl border border-white/10 p-3"><summary className="cursor-pointer py-1 text-base font-bold tracking-[-0.01em] text-white/90 marker:text-[#b4a6ff]">整体分析摘要</summary><pre className="mt-3 whitespace-pre-wrap text-xs leading-6 text-white/60">{overall.visual}</pre></details> : null}
        {transcript ? <TranscriptPanel transcript={transcript} {...rewritePanelOptions} /> : null}
    </div>;
}

function EmptyState({ icon, title, description }: { icon: ReactNode; title: string; description: string }) { return <div className="mx-auto flex max-w-sm flex-col items-center py-24 text-center"><span className="grid size-12 place-items-center rounded-2xl bg-white/[0.05] text-white/50">{icon}</span><h3 className="mt-4 text-sm font-semibold">{title}</h3><p className="mt-2 text-xs leading-5 text-white/45">{description}</p></div>; }
function FrameScriptCanvasStatus({ status, completed }: { status: FrameScriptVideoReviewNodeState["status"]; completed: boolean }) {
    const detail = completed ? { label: "已完成", tone: "border-emerald-300/30 bg-emerald-400/10 text-emerald-300" }
        : status === "awaiting-review" ? { label: "待复核", tone: "border-[#a394ff]/30 bg-[#6b56f5]/15 text-[#c3b9ff]" }
            : status === "preparing" || status === "transcribing" || status === "analyzing" ? { label: "拆解中", tone: "border-violet-300/30 bg-violet-500/15 text-violet-200" }
                : status === "error" ? { label: "需重试", tone: "border-amber-300/30 bg-amber-300/10 text-amber-200" }
                    : { label: "未开始", tone: "border-white/15 bg-white/[0.045] text-white/55" };
    return <span className={`inline-flex h-12 shrink-0 items-center gap-2 rounded-full border px-5 text-[18px] font-semibold ${detail.tone}`}>{completed ? <Check className="size-6" strokeWidth={2.2} /> : status === "preparing" || status === "transcribing" || status === "analyzing" ? <span className="size-3 rounded-full bg-current" /> : null}{detail.label}</span>;
}
function StatusPill({ status }: { status: FrameScriptVideoReviewNodeState["status"] }) { const tone = status === "completed" ? "bg-emerald-400/12 text-emerald-300" : status === "error" ? "bg-amber-400/12 text-amber-200" : status === "awaiting-review" ? "bg-[#6b56f5]/15 text-[#c3b9ff]" : "bg-white/[0.07] text-white/55"; return <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-medium ${tone}`}>{frameScriptReviewStatusLabel(status)}</span>; }
function TranscriptionAction({ status, transcriptReady, disabled, onClick }: { status?: FrameScriptVideoReviewNodeState["transcriptionStatus"]; transcriptReady: boolean; disabled: boolean; onClick: () => void }) {
    if (transcriptReady || status === "completed") return <span className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full border border-emerald-300/35 bg-emerald-400/12 px-5 text-[15px] font-semibold text-emerald-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"><CheckCircle2 className="size-5" strokeWidth={2.1} />语音转写完成</span>;
    if (status === "pending") return <span className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full border border-violet-300/30 bg-violet-400/12 px-5 text-base font-semibold text-violet-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"><LoaderCircle className="size-5 animate-spin" strokeWidth={2.1} />语音转写中</span>;
    return <button type="button" disabled={disabled} onClick={onClick} className="inline-flex h-11 shrink-0 items-center rounded-full border border-amber-300/55 bg-amber-300/10 px-5 text-base font-semibold text-amber-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition hover:bg-amber-300/18 disabled:cursor-not-allowed disabled:opacity-45">语音转写</button>;
}

function videoReferenceForNode(node: CanvasNodeData): VideoResourceRef | null {
    const resourceId = resourceIdFromStorageKey(node.metadata?.storageKey);
    if (resourceId) return { kind: "resource", id: resourceId };
    if (node.metadata?.assetId) return { kind: "asset", id: node.metadata.assetId };
    return null;
}

function videoBindingForNode(node: CanvasNodeData): FrameScriptVideoSourceBinding {
    return {
        nodeId: node.id,
        storageKey: node.metadata?.storageKey || undefined,
        assetId: node.metadata?.assetId || undefined,
    };
}

function reviewErrorMessage(error: unknown) { return error instanceof Error ? error.message : "视频拆解失败，请稍后重试"; }
function formatTime(ms: number) { const total = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`; }
function reasonLabel(reason: string) { return ({ opening: "开场", closing: "收尾", "visual-change": "画面变化", "scene-cut": "切镜", "scene-change": "场景变化", "motion-change": "运动变化", "person-movement": "人物运动", "text-change": "字幕变化", manual: "人工保留" } as Record<string, string>)[reason] || reason; }

async function captureVideoThumbnail(sourceUrl: string, timeMs: number) {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    const loaded = waitForVideoEvent(video, "loadeddata");
    video.src = sourceUrl;
    video.load();
    await loaded;
    const seeked = waitForVideoEvent(video, "seeked");
    video.currentTime = Math.max(0, Math.min(timeMs / 1000, Math.max(0, video.duration - 0.02)));
    await seeked;
    const max = 480;
    const ratio = Math.min(1, max / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(2, Math.round(video.videoWidth * ratio));
    canvas.height = Math.max(2, Math.round(video.videoHeight * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建预览画布");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("无法生成预览")), "image/jpeg", 0.82));
    video.removeAttribute("src");
    video.load();
    return URL.createObjectURL(blob);
}

function waitForVideoEvent(video: HTMLVideoElement, event: "loadeddata" | "seeked") { return new Promise<void>((resolve, reject) => { const timeout = window.setTimeout(() => done(new Error("读取视频预览超时")), 12_000); const done = (error?: Error) => { window.clearTimeout(timeout); video.removeEventListener(event, onDone); video.removeEventListener("error", onError); error ? reject(error) : resolve(); }; const onDone = () => done(); const onError = () => done(new Error("读取视频预览失败")); video.addEventListener(event, onDone, { once: true }); video.addEventListener("error", onError, { once: true }); }); }
