import { createContext, useContext } from "react";

import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

// 扩展节点（对比/图表/调色等）要读自己的上游才能工作，但节点经 CanvasProjectWorldLayers
// 渲染、CanvasNodeContentProps 里只有 node 本身，没有 nodes/connections。
// 与 canvas-node-action-context 同一个理由：通过 Context 注入，避免改动 world-layers 的透传链。
// 无 Provider 时静默降级为「没有上游」，节点自行显示空状态而不是崩。
export type CanvasNodeGraphContextValue = {
    getUpstreamNodes?: (nodeId: string) => CanvasNodeData[];
    getNodes?: () => CanvasNodeData[];
    getConnections?: () => CanvasConnection[];
};

export const CanvasNodeGraphContext = createContext<CanvasNodeGraphContextValue>({});

// Hook consumers use these snapshots as effect dependencies; fresh empty arrays loop.
const EMPTY_NODES: CanvasNodeData[] = [];
const EMPTY_CONNECTIONS: CanvasConnection[] = [];

/** 取该节点的直接上游素材节点；无 Provider 或无上游时返回空数组。 */
export function useUpstreamNodes(nodeId: string) {
    const { getUpstreamNodes } = useContext(CanvasNodeGraphContext);
    return getUpstreamNodes?.(nodeId) ?? EMPTY_NODES;
}

export function useCanvasNodes() {
    return useContext(CanvasNodeGraphContext).getNodes?.() ?? EMPTY_NODES;
}

export function useCanvasConnections() {
    return useContext(CanvasNodeGraphContext).getConnections?.() ?? EMPTY_CONNECTIONS;
}
