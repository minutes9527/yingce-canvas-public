import { describe, expect, test } from "bun:test";
import { formatLocalSavedRemotePending } from "@/services/user-data-sync";
import { ApiError } from "@/services/api/request";

describe("本地已保存时的可操作恢复提示", () => {
    test("连接未确认不伪报云端成功，不再要求用户处理同步", () => {
        const text = formatLocalSavedRemotePending("素材已在本地保存", new Error("网络中断"));
        expect(text).toContain("正在自动同步");
        expect(text).not.toContain("导出");
        expect(text).not.toContain("另存");
        expect(text).not.toContain("已保存到云端");
        expect(text).not.toContain("同步失败");
    });
    test("登录和权限问题有准确下一步，不无限承诺重试可写入", () => {
        expect(formatLocalSavedRemotePending("本地已保存", new ApiError("auth", { status: 401 }))).toContain("重新登录");
        expect(formatLocalSavedRemotePending("本地已保存", new ApiError("forbidden", { status: 403 }))).toContain("没有云端写入权限");
    });

    test("同一字段发生冲突时不承诺原请求会自动恢复", () => {
        const error = new ApiError("节点位置已变化", { status: 409, reason: "canvas_field_conflict" });
        expect(formatLocalSavedRemotePending("素材已在本地保存", error)).toBe("素材已在本地保存，云端画布存在冲突：节点位置已变化。本地修改已保留，请核对该画布的其他标签页。");
    });
});
