import { nanoid } from "nanoid";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { FRAMESCRIPT_STORYBOARD_NODE_TYPE } from "@/lib/framescript-video-review/contracts";
import { frameScriptGenerationMetadata } from "@/lib/framescript-video-review/storyboard-content";
import { readImageMeta } from "@/lib/image-utils";
import { uploadImage } from "@/services/image-storage";
import { isResourceUrl, resourceFileUrl, resourceStorageKey } from "@/services/api/resources";
import { useAssetStore } from "@/stores/use-asset-store";
import type { FrameScriptCanvasFrame, FrameScriptCanvasStoryboardFrame, FrameScriptGenerationDraft } from "@/components/canvas/canvas-node-action-context";

export function createFrameScriptCanvasActions(host: {
    nodes: () => CanvasNodeData[];
    connections: () => CanvasConnection[];
    commit: (nodes: CanvasNodeData[], connections: CanvasConnection[]) => void;
    openGeneration: (id: string) => void;
    generateImage: (id: string, prompt: string) => Promise<void>;
    openShot: (id: string) => void;
}) {
    let exporting = false;
    const exportFrames = async (source: CanvasNodeData, frames: readonly FrameScriptCanvasFrame[], storyboard: boolean) => {
        if (exporting) throw new Error("正在导出，请稍候");
        if (!frames.length) throw new Error("没有确认的镜头");
        exporting = true;
        try {
            const additions: CanvasNodeData[] = [];
            const edges: CanvasConnection[] = [];
            const shotIds: string[] = [];
            for (const [offset, input] of frames.entries()) {
                const existing = host.nodes().find(n => n.metadata?.frameScriptStoryboard?.sourceNodeId === source.id && n.metadata.frameScriptStoryboard.frames.some(f => f.id === input.id));
                if (storyboard && existing) { shotIds.push(existing.id); continue; }
                const imageTitle = `FrameScript 原帧 ${input.index} · ${input.id}`;
                let image = host.nodes().find(n => n.type === CanvasNodeType.Image && n.title === imageTitle && host.connections().some(c => c.fromNodeId === source.id && c.toNodeId === n.id));
                let width = 0, height = 0;
                if (!image) {
                    // Confirmed frames may already be stored as platform resources. Reuse
                    // those references: fetching their display URL as a Blob can fail on
                    // cross-origin object storage and needlessly duplicates the image.
                    const resourceId = isResourceUrl(input.imageUrl)
                        ? /^.*\/resources\/([^/?#]+)\/file(?:[?#].*)?$/.exec(input.imageUrl)?.[1]
                        : undefined;
                    const uploaded = resourceId
                        ? { url: resourceFileUrl(resourceId), storageKey: resourceStorageKey(resourceId), ...await readImageMeta(input.imageUrl) }
                        : await uploadImage(input.imageUrl);
                    width = uploaded.width; height = uploaded.height;
                    image = createCanvasNode(CanvasNodeType.Image, { x: source.position.x + source.width + 240, y: source.position.y + offset * 380 + 150 }, { content: uploaded.url, storageKey: uploaded.storageKey });
                    image.title = imageTitle;
                    additions.push(image);
                    edges.push({ id: nanoid(), fromNodeId: source.id, toNodeId: image.id });
                }
                if (!storyboard) continue;
                const frame = input as FrameScriptCanvasStoryboardFrame;
                const shot = createCanvasNode(FRAMESCRIPT_STORYBOARD_NODE_TYPE, { x: source.position.x + source.width + 780, y: source.position.y + offset * 380 + 150 }, {
                    frameScriptStoryboard: { schemaVersion: 1, sourceNodeId: source.id, sourceVideoId: input.sourceVideoId, presentation: "single-shot", frames: [{ ...frame, imageNodeId: image.id, sourceWidth: width || undefined, sourceHeight: height || undefined }], updatedAt: new Date().toISOString() },
                });
                shot.title = `视频拆解 · 镜头 ${String(frame.index).padStart(2, "0")}`;
                shot.width = 420; shot.height = 300;
                shot.position = { x: source.position.x + source.width + 520, y: source.position.y + offset * 380 };
                additions.push(shot);
                edges.push({ id: nanoid(), fromNodeId: image.id, toNodeId: shot.id });
                shotIds.push(shot.id);
            }
            host.commit([...host.nodes(), ...additions], [...host.connections(), ...edges]);
            if (shotIds[0]) host.openShot(shotIds[0]);
        } finally { exporting = false; }
    };
    return {
        addFrameScriptImageNodes: (source: CanvasNodeData, frames: readonly FrameScriptCanvasFrame[]) => exportFrames(source, frames, false),
        addFrameScriptStoryboardNode: (source: CanvasNodeData, frames: readonly FrameScriptCanvasStoryboardFrame[]) => exportFrames(source, frames, true),
        createFrameScriptImageGenerationNodes: (source: CanvasNodeData, frameId?: string, draft?: FrameScriptGenerationDraft) => {
            return createGenerationNodes(source, frameId, "image", draft);
        },
        createFrameScriptVideoGenerationNodes: (source: CanvasNodeData, frameId?: string, draft?: FrameScriptGenerationDraft) => {
            return createGenerationNodes(source, frameId, "video", draft);
        },
    };
    function createGenerationNodes(source: CanvasNodeData, frameId: string | undefined, kind: "image" | "video", draft?: FrameScriptGenerationDraft) {
            const latest = host.nodes().find(n => n.id === source.id) || source;
            const frames = latest.metadata?.frameScriptStoryboard?.frames.filter(f => !frameId || f.id === frameId) || [];
            if (!frames.length) return;
            const updatedSource = draft && frameId && latest.metadata?.frameScriptStoryboard ? {
                ...latest,
                metadata: { ...latest.metadata, frameScriptStoryboard: {
                    ...latest.metadata.frameScriptStoryboard,
                    frames: latest.metadata.frameScriptStoryboard.frames.map(frame => frame.id === frameId ? { ...frame, ...draft } : frame),
                    updatedAt: new Date().toISOString(),
                } },
            } : latest;
            const additions: CanvasNodeData[] = [];
            const updates = new Map<string, CanvasNodeData>();
            const edges: CanvasConnection[] = [];
            const removedReferenceEdges = new Set<string>();
            const availableNodes = [...host.nodes()];
            let openId = "";
            for (const originalFrame of frames) {
                const frame = draft && originalFrame.id === frameId ? { ...originalFrame, ...draft } : originalFrame;
                const type = kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Video;
                // Keep completed image generations intact; each retry needs its own bound result node.
                const existing = host.nodes().findLast(n => n.type === type && n.metadata?.frameScriptStoryboardNodeId === source.id && n.metadata.frameScriptStoryboardFrameId === frame.id && (kind !== "image" || !n.metadata?.content));
                const assetNodeId = (id: string) => {
                    const existingAssetNode = availableNodes.find(n => n.id === id || n.metadata?.assetId === id);
                    if (existingAssetNode) return existingAssetNode.id;
                    const asset = useAssetStore.getState().assets.find(item => item.id === id && item.kind === "image");
                    if (!asset || asset.kind !== "image") return id;
                    const referenceNode = createCanvasNode(CanvasNodeType.Image, { x: source.position.x + source.width + 120, y: source.position.y + 100 + additions.length * 180 }, {
                        content: asset.data.dataUrl || asset.coverUrl,
                        storageKey: asset.data.storageKey,
                        assetId: asset.id,
                        naturalWidth: asset.data.width,
                        naturalHeight: asset.data.height,
                    });
                    referenceNode.title = asset.title || "素材库图片";
                    additions.push(referenceNode);
                    availableNodes.push(referenceNode);
                    return referenceNode.id;
                };
                const assets = Object.fromEntries(Object.entries(frame.assets || {}).map(([category, ids]) => [category, (ids || []).map(assetNodeId)])) as typeof frame.assets;
                const generationFrame = { ...frame, assets };
                const references = [...new Set([frame.imageNodeId, ...(frame.referenceNodeIds || []), ...Object.values(assets || {}).flat()].filter((id): id is string => Boolean(id)))];
                if (existing) {
                    existing.metadata?.frameScriptStoryboardReferenceNodeIds?.filter(id => !references.includes(id))
                        .forEach(id => removedReferenceEdges.add(`${id}\0${existing.id}`));
                    updates.set(existing.id, { ...existing, metadata: { ...existing.metadata, ...frameScriptGenerationMetadata(generationFrame, kind, source.id, references) } });
                    references.filter(id => !host.connections().some(edge => edge.fromNodeId === id && edge.toNodeId === existing.id))
                        .forEach(id => edges.push({ id: nanoid(), fromNodeId: id, toNodeId: existing.id }));
                    openId ||= existing.id;
                    continue;
                }
                const node = createCanvasNode(type, { x: source.position.x + source.width + 260, y: source.position.y + additions.filter(item => item.type === type).length * 380 + 150 }, frameScriptGenerationMetadata(generationFrame, kind, source.id, references));
                additions.push(node);
                references.forEach(id => edges.push({ id: nanoid(), fromNodeId: id, toNodeId: node.id }));
                edges.push({ id: nanoid(), fromNodeId: source.id, fromHandleId: `row:${frame.id}`, toNodeId: node.id });
                openId ||= node.id;
            }
            host.commit([...host.nodes().map(node => updates.get(node.id) || (node.id === source.id ? updatedSource : node)), ...additions], [...host.connections().filter(edge => !removedReferenceEdges.has(`${edge.fromNodeId}\0${edge.toNodeId}`)), ...edges]);
            if (!openId) return;
            if (kind === "image") {
                const target = [...updates.values(), ...additions].find(node => node.id === openId);
                return host.generateImage(openId, target?.metadata?.prompt || "");
            }
            host.openGeneration(openId);
    }
}
