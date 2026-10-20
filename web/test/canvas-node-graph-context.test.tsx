import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasNodeGraphContext, useCanvasNodes, useCanvasConnections, useUpstreamNodes } from "../src/components/canvas/canvas-node-graph-context";
import type { CanvasNodeData, CanvasConnection } from "../src/types/canvas";

test("missing graph readers return stable snapshots across renders", () => {
    const snapshots: unknown[][] = [];
    function Probe() {
        snapshots.push([useCanvasNodes(), useCanvasConnections(), useUpstreamNodes("review")]);
        return null;
    }
    for (let i = 0; i < 3; i++) renderToStaticMarkup(<CanvasNodeGraphContext.Provider value={{}}><Probe /></CanvasNodeGraphContext.Provider>);
    for (const snapshot of snapshots.slice(1)) {
        snapshot.forEach((value, index) => expect(value).toBe(snapshots[0][index]));
    }
});

test("graph readers expose the supplied node and connection snapshots", () => {
    const nodes: CanvasNodeData[] = [];
    const connections: CanvasConnection[] = [];
    function Probe() {
        expect(useCanvasNodes()).toBe(nodes);
        expect(useCanvasConnections()).toBe(connections);
        return null;
    }
    renderToStaticMarkup(<CanvasNodeGraphContext.Provider value={{ getNodes: () => nodes, getConnections: () => connections }}><Probe /></CanvasNodeGraphContext.Provider>);
});
