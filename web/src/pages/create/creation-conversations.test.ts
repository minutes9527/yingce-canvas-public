import assert from "node:assert/strict";
import test from "node:test";

// Node 原生 TypeScript 测试运行器要求保留扩展名，项目编译器不允许该写法。
// @ts-expect-error -- Node 原生 TypeScript 测试运行器需要保留扩展名。
import { reconcileCreationTaskMessages } from "./creation-conversations.ts";
import type { CreationConversation } from "./creation-types";

const runtime = {} as Parameters<typeof reconcileCreationTaskMessages>[0];

function failedConversation(): CreationConversation {
    return {
        id: "conversation-1",
        title: "测试",
        updatedAt: "2026-10-14T11:00:00.000Z",
        messages: [{ id: "message-1", role: "assistant", content: "生成失败", mode: "video", status: "error", error: "网络异常。", createdAt: "2026-10-14T11:00:00.000Z", taskIds: ["task-1"] }],
    };
}

test("页面先报网络异常而后台任务成功时，恢复视频结果", () => {
    const task = {
        id: "task-1",
        status: "succeeded",
        type: "video",
        updatedAt: "2026-10-14T11:01:00.000Z",
        creationResultUrls: ["/api/resources/result/file"],
        creationResultStorageKeys: ["resource:result"],
    } as Parameters<typeof reconcileCreationTaskMessages>[2][number];
    const result = reconcileCreationTaskMessages(runtime, [failedConversation()], [task]);
    assert.equal(result[0].messages[0].status, "done");
    assert.equal(result[0].messages[0].error, undefined);
    assert.deepEqual(result[0].messages[0].resultUrls, ["/api/resources/result/file"]);
});

test("后台任务确实失败时保留原失败消息", () => {
    const conversation = failedConversation();
    const task = { id: "task-1", status: "failed", type: "video", updatedAt: "2026-10-14T11:01:00.000Z" } as Parameters<typeof reconcileCreationTaskMessages>[2][number];
    assert.equal(reconcileCreationTaskMessages(runtime, [conversation], [task])[0], conversation);
});
