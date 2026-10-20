import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DreaminaCliRuntime } from "../src/dreamina-cli-runtime.js";

test("queued tasks wait until cancelled instead of reporting generation failure", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dreamina-queue-test-"));
    const stateFile = path.join(directory, "state.json");
    const ownerId = "test-owner-12345678";
    const now = new Date().toISOString();
    await writeFile(stateFile, JSON.stringify({ version: 1, records: [{ ownerId, idempotencyKey: "old-task-123", requestHash: "a".repeat(64), state: "unknown", updatedAt: now }] }));
    const runtime = new DreaminaCliRuntime({ ownerId, stateFile, maxActiveTasks: 1, ensureReady: async () => {}, durableReloadIntervalMs: 20 });
    try {
        const task = await runtime.enqueue({ operation: "text2image", idempotencyKey: "queued-task-12345678", prompt: "test" });
        expect(task.status).toBe("queued");
        const wait = runtime.waitForTask(task.id, "image");
        const outcome = await Promise.race([wait.then(() => "finished", () => "failed"), new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100))]);
        expect(outcome).toBe("waiting");
        await runtime.cancelTask(task.id);
        await expect(wait).rejects.toMatchObject({ code: "dreamina_cancelled" });
    } finally {
        await runtime.dispose();
        await rm(directory, { recursive: true, force: true });
    }
});
