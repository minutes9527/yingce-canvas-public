import { expect, test } from "bun:test";

import { createFrameScriptCanvasActions } from "@/pages/canvas/framescript-actions";
import { getNodeDefinition, registerNodeDefinitions, unregisterNodeDefinitions } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

test("the shot image button submits the current draft without leaving for a node editor", async () => {
    const image: CanvasNodeData = { id: "frame-image", type: CanvasNodeType.Image, title: "原帧", position: { x: 0, y: 0 }, width: 200, height: 300, metadata: { content: "data:image/png;base64,a" } };
    const shot: CanvasNodeData = {
        id: "shot", type: CanvasNodeType.Image, title: "镜头", position: { x: 300, y: 0 }, width: 400, height: 300,
        metadata: { frameScriptStoryboard: { schemaVersion: 1, sourceNodeId: "source", frames: [{ id: "frame", index: 1, timeMs: 0, durationSeconds: 6, imageNodeId: image.id, imageGenerationPrompt: "旧图片描述", videoMotionPrompt: "旧动作" }] } },
    };
    let nodes = [image, shot];
    let connections: CanvasConnection[] = [];
    const calls: Array<{ id: string; prompt: string }> = [];
    const actions = createFrameScriptCanvasActions({
        nodes: () => nodes,
        connections: () => connections,
        commit: (nextNodes, nextConnections) => { nodes = nextNodes; connections = nextConnections; },
        openGeneration: () => { throw new Error("image generation must stay in the shot"); },
        generateImage: async (id, prompt) => { calls.push({ id, prompt }); },
        openShot: () => {},
    });

    await actions.createFrameScriptImageGenerationNodes(shot, "frame", { imageGenerationPrompt: "刚输入但尚未失焦的图片描述", videoMotionPrompt: "镜头向前移动", imageModel: "channel::image" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("刚输入但尚未失焦的图片描述");
    expect(nodes.find(node => node.id === calls[0]?.id)?.metadata?.model).toBe("channel::image");
    expect(nodes.find(node => node.id === shot.id)?.metadata?.frameScriptStoryboard?.frames[0]?.videoMotionPrompt).toBe("镜头向前移动");
    expect(connections.some(connection => connection.fromNodeId === image.id && connection.toNodeId === calls[0]?.id)).toBe(true);

    const firstResultId = calls[0]!.id;
    nodes = nodes.map(node => node.id === firstResultId ? { ...node, metadata: { ...node.metadata, content: "data:image/png;base64,result", status: "success" } } : node);
    await actions.createFrameScriptImageGenerationNodes(shot, "frame", { imageGenerationPrompt: "第二张分镜图", imageModel: "channel::image" });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.id).not.toBe(firstResultId);
    expect(nodes.find(node => node.id === firstResultId)?.metadata?.content).toBe("data:image/png;base64,result");
    expect(nodes.find(node => node.id === calls[1]?.id)?.metadata?.frameScriptStoryboardFrameId).toBe("frame");
});

test("storyboard export reuses stored original frames without fetching and reuploading them", async () => {
    const needsRegistration = !getNodeDefinition("framescript-storyboard");
    if (needsRegistration) registerNodeDefinitions([{ type: "framescript-storyboard", label: "视频拆解", icon: null, defaultTitle: "视频拆解", defaultSize: { width: 420, height: 300 }, minSize: { width: 220, height: 160 }, showInCreateMenu: false }], "framescript-export-test");
    const originalImage = globalThis.Image;
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    class LoadedImage {
        naturalWidth = 338;
        naturalHeight = 600;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    Object.assign(globalThis, { Image: LoadedImage, fetch: async () => { fetchCount += 1; throw new Error("resource display URL cannot be fetched as a Blob"); } });
    try {
        const source: CanvasNodeData = { id: "review", type: CanvasNodeType.Text, title: "视频拆解", position: { x: 0, y: 0 }, width: 300, height: 200, metadata: {} };
        let nodes = [source];
        let connections: CanvasConnection[] = [];
        const actions = createFrameScriptCanvasActions({
            nodes: () => nodes,
            connections: () => connections,
            commit: (nextNodes, nextConnections) => { nodes = nextNodes; connections = nextConnections; },
            openGeneration: () => {},
            generateImage: async () => {},
            openShot: () => {},
        });
        await actions.addFrameScriptStoryboardNode(source, [{ id: "frame-0", index: 1, timeMs: 0, durationSeconds: 6, imageUrl: "/api/resources/frame-resource/file", imageGenerationPrompt: "原帧画面" }]);
        const image = nodes.find(node => node.type === CanvasNodeType.Image);
        const shot = nodes.find(node => node.metadata?.frameScriptStoryboard?.sourceNodeId === source.id);
        expect(fetchCount).toBe(0);
        expect(image?.metadata?.storageKey).toBe("resource:frame-resource");
        expect(shot?.metadata?.frameScriptStoryboard?.frames[0]?.imageNodeId).toBe(image?.id);
        expect(shot?.metadata?.frameScriptStoryboard?.frames[0]?.sourceWidth).toBe(338);
        expect(shot?.metadata?.frameScriptStoryboard?.frames[0]?.sourceHeight).toBe(600);
    } finally {
        Object.assign(globalThis, { Image: originalImage, fetch: originalFetch });
        if (needsRegistration) unregisterNodeDefinitions("framescript-export-test");
    }
});
