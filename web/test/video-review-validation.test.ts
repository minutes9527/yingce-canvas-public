import { describe, expect, test } from "bun:test";
import { VideoPluginError, type AnalysisResult } from "@/lib/plugins/video-plugin";
import { assertVideoReview, confirmVideoReview, createVideoReviewDraft, type ConfirmedVideoReview, type VideoReviewDraft } from "@/lib/plugins/video-review";
import { snapshotReviewSelection, snapshotVideoReview } from "@/lib/plugins/video-review-snapshot";

const source = { kind: "asset" as const, id: "video-fixture" };
const prepared: AnalysisResult = {
    pluginId: "framescript-video-engine",
    status: "completed",
    segments: [],
    sourceFingerprint: "a".repeat(64),
    durationMs: 10_000,
    keyframes: [0, 4000].map((timeMs) => ({ timeMs, score: 0.5, reasons: ["visual-change"], hardTrigger: false })),
};

describe("video review validation at public boundaries", () => {
    test.each([
        ["empty source ID", { source: { ...source, id: "" } }],
        ["missing source ID", { source: { kind: "asset" } }],
        ["numeric source ID", { source: { ...source, id: 123 } }],
        ["empty fingerprint", { sourceFingerprint: "" }],
        ["zero revision", { revision: 0 }],
        ["fractional revision", { revision: 1.5 }],
        ["wrong schema", { schema: "other" }],
        ["unsupported version", { version: 2 }],
        ["wrong state", { state: "confirmed" }],
        ["null frames", { frames: null }],
        ["null frame", { frames: [null] }],
    ])("rejects %s during confirmation and revalidation", (_label, patch) => {
        // Persisted JSON is not guaranteed to satisfy the TypeScript contract.
        const draft = { ...createVideoReviewDraft(source, prepared), ...patch } as unknown as VideoReviewDraft;
        const review = {
            state: "confirmed",
            source: draft.source,
            sourceFingerprint: draft.sourceFingerprint,
            revision: draft.revision,
            frames: prepared.keyframes!.map((frame) => ({ ...frame, id: `frame-${frame.timeMs}` })),
        } as ConfirmedVideoReview;
        expect(() => confirmVideoReview(draft, ["frame-0"])).toThrow(VideoPluginError);
        expect(() => assertVideoReview(draft, review)).toThrow(VideoPluginError);
    });

    test("validates the source when creating a draft", () => {
        expect(() => createVideoReviewDraft({ ...source, id: "" }, prepared)).toThrow(VideoPluginError);
    });

    test("rejects exchanged IDs even when timestamps remain sorted", () => {
        const draft = createVideoReviewDraft(source, prepared);
        const review = confirmVideoReview(draft, ["frame-0", "frame-4000"]);
        const swapped = {
            ...review,
            frames: [
                { ...review.frames[0], id: "frame-4000" },
                { ...review.frames[1], id: "frame-0" },
            ],
        };
        expect(() => assertVideoReview(draft, swapped)).toThrow(VideoPluginError);
    });

    test("rejects changed timestamps and shot associations", () => {
        const draft = createVideoReviewDraft(source, prepared);
        const review = confirmVideoReview(draft, ["frame-0"]);
        for (const patch of [{ timeMs: 100 }, { shotId: "other-shot" }]) {
            expect(() => assertVideoReview(draft, { ...review, frames: [{ ...review.frames[0], ...patch }] })).toThrow(VideoPluginError);
        }
    });

    test("rejects malformed, duplicate, empty and foreign selections", () => {
        const draft = createVideoReviewDraft(source, prepared);
        for (const selection of [null, "frame-0", [], new Array(1), ["missing"], ["frame-0", "frame-0"], [0]]) {
            expect(() => confirmVideoReview(draft, selection as unknown as string[])).toThrow(VideoPluginError);
        }
        const review = confirmVideoReview(draft, ["frame-0"]);
        for (const frames of [null, [], [null], [review.frames[0], review.frames[0]]]) {
            expect(() => assertVideoReview(draft, { ...review, frames } as ConfirmedVideoReview)).toThrow(VideoPluginError);
        }
    });

    test("accepts detached JSON snapshots and preserves source/revision checks", () => {
        const draft = createVideoReviewDraft(source, prepared);
        const review = confirmVideoReview(draft, ["frame-4000", "frame-0"]);
        expect(review.frames.map((frame) => frame.timeMs)).toEqual([0, 4000]);
        expect(review.frames[0]).not.toBe(draft.frames[0]);
        expect(() => assertVideoReview(draft, JSON.parse(JSON.stringify(review)))).not.toThrow();
        expect(() => assertVideoReview(draft, { ...review, source: { ...source, id: "other-video" } })).toThrow(VideoPluginError);
        expect(() => assertVideoReview(draft, { ...review, revision: 2 })).toThrow(VideoPluginError);
    });

    test("persists only declared detector fields and rejects edited detector output", () => {
        const draft = createVideoReviewDraft(source, {
            ...prepared,
            keyframes: [{
                timeMs: 0, score: 0.8, confidence: 0.8, motionDirection: "right", reasons: ["opening"], hardTrigger: true,
                scoreBreakdown: { adjacentDifference: 0, retainedDifference: 0, visualChange: 0, corroboration: 0, composite: 0, sceneCut: 0, transition: 0, exposureChange: 0, motion: 0 },
            }],
        });
        (draft.frames[0].scoreBreakdown as Record<string, unknown>).unexpected = { blob: new Blob(["not portable"]) };
        const snapshot = snapshotVideoReview(draft);
        expect(snapshot.frames[0].scoreBreakdown).not.toHaveProperty("unexpected");
        expect(snapshot.frames[0].motionDirection).toBe("right");

        const review = confirmVideoReview(draft, ["frame-0"]);
        review.frames[0].score = 0.1;
        expect(() => assertVideoReview(draft, review)).toThrow(VideoPluginError);
    });

    test("keeps bounded server JPEG previews and rejects malformed preview data", () => {
        const draft = createVideoReviewDraft(source, {
            ...prepared,
            keyframes: [{ ...prepared.keyframes![0], previewDataUrl: "data:image/jpeg;base64,AA==" }],
        });
        expect(draft.frames[0].previewDataUrl).toBe("data:image/jpeg;base64,AA==");
        const malformed = structuredClone(draft);
        malformed.frames[0].previewDataUrl = "data:image/png;base64,AA==";
        expect(() => confirmVideoReview(malformed, ["frame-0"])).toThrow(VideoPluginError);
    });

    test("accepts resource-backed previews after canvas sync without allowing external URLs", () => {
        const draft = createVideoReviewDraft(source, prepared);
        draft.frames[0].previewDataUrl = "/api/resources/1fc6b46cfc3aeeace59a78f10a24ed3c/file";
        const review = confirmVideoReview(draft, ["frame-0"]);
        expect(() => assertVideoReview(draft, review)).not.toThrow();
        draft.frames[0].previewDataUrl = "https://example.com/frame.jpg";
        expect(() => confirmVideoReview(draft, ["frame-0"])).toThrow(VideoPluginError);
    });

    test("allows an empty local checkpoint selection before manual confirmation", () => {
        const draft = createVideoReviewDraft(source, prepared);
        expect(snapshotReviewSelection(draft, [], { allowEmpty: true })).toEqual([]);
        expect(() => snapshotReviewSelection(draft, [])).toThrow(VideoPluginError);
    });
});
