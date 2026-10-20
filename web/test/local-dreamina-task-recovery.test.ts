import { expect, test } from "bun:test";

import { listGenerationTasks, type GenerationTask } from "../src/services/api/task-center";

function task(id: string, updatedAt: string): GenerationTask {
    return { id, projectId: "canvas-1", type: "canvas_video", status: "succeeded", prompt: "", attempts: 1, createdAt: updatedAt, updatedAt };
}

test("canvas recovery discovers local Dreamina tasks alongside backend tasks", async () => {
    const backend = task("backend-1", "2026-10-06T01:00:00.000Z");
    const local = task("dreamina:local-1", "2026-10-06T02:00:00.000Z");
    let localCalls = 0;
    const dependencies = {
        listBackendPage: async () => ({ tasks: [backend] }),
        listLocalPage: async () => {
            localCalls += 1;
            return { tasks: [local] };
        },
    };

    expect(await listGenerationTasks(30, { projectId: "canvas-1" }, dependencies)).toEqual([backend]);
    expect(localCalls).toBe(0);
    expect(await listGenerationTasks(30, { projectId: "canvas-1", includeLocalDreamina: true }, dependencies)).toEqual([local, backend]);
    expect(localCalls).toBe(1);
});

test("canvas recovery keeps backend tasks if the local Runtime cannot be reached", async () => {
    const backend = task("backend-1", "2026-10-06T01:00:00.000Z");
    const previousWarn = console.warn;
    console.warn = () => undefined;
    try {
        expect(await listGenerationTasks(30, { projectId: "canvas-1", includeLocalDreamina: true }, {
            listBackendPage: async () => ({ tasks: [backend] }),
            listLocalPage: async () => { throw new Error("Runtime unavailable"); },
        })).toEqual([backend]);
    } finally {
        console.warn = previousWarn;
    }
});

test("canvas recovery keeps a discovered local task when the backend is unavailable", async () => {
    const local = task("dreamina:local-1", "2026-10-06T02:00:00.000Z");
    const previousWarn = console.warn;
    console.warn = () => undefined;
    try {
        expect(await listGenerationTasks(30, { projectId: "canvas-1", includeLocalDreamina: true }, {
            listBackendPage: async () => { throw new Error("Backend unavailable"); },
            listLocalPage: async () => ({ tasks: [local] }),
        })).toEqual([local]);
        await expect(listGenerationTasks(30, { projectId: "canvas-1", includeLocalDreamina: true }, {
            listBackendPage: async () => { throw new Error("Backend unavailable"); },
            listLocalPage: async () => ({ tasks: [] }),
        })).rejects.toThrow("Backend unavailable");
    } finally {
        console.warn = previousWarn;
    }
});
