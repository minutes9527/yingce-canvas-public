import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { canRestoreFrameScriptReviewCheckpoint } from "../src/lib/framescript-video-review/review-recovery";
import { createDefaultFrameScriptVideoReviewState } from "../src/lib/framescript-video-review/contracts";
import { createVideoReviewDraft, confirmVideoReview, type VideoBreakdown } from "../src/lib/plugins/video-review";

const draft = createVideoReviewDraft({ kind: "asset", id: "source" }, {
    pluginId: "framescript-video-engine", status: "completed", segments: [],
    sourceFingerprint: "a".repeat(64), durationMs: 1000,
    keyframes: [{ timeMs: 0, score: 1, reasons: ["visual-change"], hardTrigger: false }],
});
const session = { open: true, autoPrepare: false, staleSource: false, activeRequest: false };

describe("video review reopen", () => {
    test("keeps completed canvas results even when the candidate draft is absent", () => {
        const breakdown: VideoBreakdown = {
            schema: "yingce.video-breakdown", version: 1, review: confirmVideoReview(draft, ["frame-0"]),
            analysis: { pluginId: "framescript-video-engine", status: "completed", segments: [], keyframes: [] },
            screenText: [], evidenceStatus: "model-output-unverified",
        };
        expect(canRestoreFrameScriptReviewCheckpoint({ ...createDefaultFrameScriptVideoReviewState(), status: "completed", breakdown }, session)).toBe(false);
    });
    test("reopening candidate review does not restore or overwrite it", () => {
        expect(canRestoreFrameScriptReviewCheckpoint({ ...createDefaultFrameScriptVideoReviewState(), status: "awaiting-review", draft }, session)).toBe(false);
    });
    test("recovers an interrupted request only when no live request owns it", () => {
        const state = { ...createDefaultFrameScriptVideoReviewState(), status: "analyzing" as const, draft };
        expect(canRestoreFrameScriptReviewCheckpoint(state, session)).toBe(true);
        expect(canRestoreFrameScriptReviewCheckpoint(state, { ...session, activeRequest: true })).toBe(false);
    });
    test("closed, explicit restart and changed sources cannot recover an old checkpoint", () => {
        for (const patch of [{ open: false }, { autoPrepare: true }, { staleSource: true }]) {
            expect(canRestoreFrameScriptReviewCheckpoint(createDefaultFrameScriptVideoReviewState(), { ...session, ...patch })).toBe(false);
        }
    });
    test("ordinary plugin settings use the public catalog without calling the admin-only system endpoint", () => {
        const page = readFileSync(new URL("../src/pages/plugins/index.tsx", import.meta.url), "utf8");
        expect(page).not.toContain("getSystemChannels");
        expect(page).toContain("await refreshSystemChannels()");
        expect(page).toContain('if (!channels.length && user?.role === "admin")');
        expect(page).toContain('if (user?.role === "admin") try');
    });
});
