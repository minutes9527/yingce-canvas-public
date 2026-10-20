import { pluginStorageFor } from "@/lib/plugins/plugin-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import type { PluginHostContext } from "@/lib/plugins/plugin-types";
import { VideoPluginError } from "@/lib/plugins/video-plugin";
import { snapshotReviewSelection, snapshotVideoReview } from "@/lib/plugins/video-review-snapshot";
import { fingerprintVideoSource } from "@/lib/plugins/video-source";
import type { VideoReviewDraft } from "@/lib/plugins/video-review";
import type { VideoResourceRef } from "@/lib/video-engine/video-ir";

type Checkpoint = { schema: "yingce.video-review-checkpoint"; version: 1; writeToken: string; savedAt: string; draft: VideoReviewDraft; selectedIds: string[] };
type RestoredReview = { status: "missing" } | { status: "source-changed"; savedAt: string; writeToken: string } | { status: "restored"; persistence: "local-only"; requiresConfirmation: true; savedAt: string; writeToken: string; draft: VideoReviewDraft; selectedIds: string[] };

const localCheckpointLocks = new Map<string, Promise<void>>();

async function withCheckpointLock<T>(name: string, signal: AbortSignal | undefined, operation: () => Promise<T>) {
    if (typeof navigator !== "undefined" && navigator.locks) {
        return navigator.locks.request(name, { mode: "exclusive", signal }, operation);
    }

    // Web Locks is supported by current browsers and protects separate tabs.
    // Keep a small in-page queue for runtimes without that API so concurrent
    // saves in one page still retain the read/check/write ordering.
    const previous = localCheckpointLocks.get(name) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    localCheckpointLocks.set(name, tail);
    await previous.catch(() => {});
    try {
        signal?.throwIfAborted();
        return await operation();
    } finally {
        release();
        if (localCheckpointLocks.get(name) === tail) localCheckpointLocks.delete(name);
    }
}

/** User-scoped local checkpoint. It is not a render job, cloud backup or confirmation. */
export function createVideoReviewPersistence(context: PluginHostContext) {
    const scope = getActiveUserScope();
    if (!scope || scope === "guest" || !context.permissions.has("media.read") || !context.services?.media?.resolve) throw new VideoPluginError("permission-denied", "复核保存需要已登录用户与媒体读取权限");
    const storage = pluginStorageFor(context.manifest.id);
    const keyFor = (source: VideoResourceRef) => `video-review:v1:${source.kind}:${source.id}`;
    const currentFingerprint = async (source: VideoResourceRef, signal?: AbortSignal) => {
        if (getActiveUserScope() !== scope) throw new VideoPluginError("permission-denied", "账号已变化，请重新打开复核流程");
        const media = await context.services!.media!.resolve(source, signal);
        if (media.kind !== "video") throw new VideoPluginError("invalid-input", "复核记录需要原视频素材");
        return fingerprintVideoSource(media.blob, signal);
    };
    const read = async (source: VideoResourceRef): Promise<Checkpoint | null> => {
        const value = await storage.get<Checkpoint>(keyFor(source));
        if (!value) return null;
        if (value.schema !== "yingce.video-review-checkpoint" || value.version !== 1 || typeof value.writeToken !== "string" || !value.writeToken || !Number.isFinite(Date.parse(value.savedAt))) throw new VideoPluginError("invalid-input", "保存的复核记录损坏或版本不支持，未覆盖");
        const draft = snapshotVideoReview(value.draft);
        if (draft.source.kind !== source.kind || draft.source.id !== source.id) throw new VideoPluginError("invalid-input", "复核记录的原视频不匹配");
        return { ...value, draft, selectedIds: snapshotReviewSelection(draft, value.selectedIds, { allowEmpty: true }) };
    };
    return {
        async save(draft: VideoReviewDraft, selectedIds: readonly string[], expectedWriteToken: string | null, signal?: AbortSignal) {
            const snapshot = snapshotVideoReview(draft); const selection = snapshotReviewSelection(snapshot, selectedIds, { allowEmpty: true });
            const lockName = `yingce:video-review:${scope}:${snapshot.source.kind}:${snapshot.source.id}`;
            return withCheckpointLock(lockName, signal, async () => {
                if (await currentFingerprint(snapshot.source, signal) !== snapshot.sourceFingerprint) throw new VideoPluginError("invalid-input", "原视频已变化，未覆盖保存的复核草稿");
                const existing = await read(snapshot.source);
                if ((existing?.writeToken ?? null) !== expectedWriteToken) throw new VideoPluginError("invalid-input", "复核草稿已在另一页面更新，请重新载入后保存");
                const checkpoint: Checkpoint = { schema: "yingce.video-review-checkpoint", version: 1, writeToken: crypto.randomUUID(), savedAt: new Date().toISOString(), draft: snapshot, selectedIds: selection };
                await storage.set(keyFor(snapshot.source), checkpoint);
                return { persistence: "local-only" as const, writeToken: checkpoint.writeToken, savedAt: checkpoint.savedAt };
            });
        },
        async load(source: VideoResourceRef, signal?: AbortSignal): Promise<RestoredReview> {
            const checkpoint = await read(source); if (!checkpoint) return { status: "missing" };
            if (await currentFingerprint(source, signal) !== checkpoint.draft.sourceFingerprint) return { status: "source-changed", savedAt: checkpoint.savedAt, writeToken: checkpoint.writeToken };
            return { status: "restored", persistence: "local-only", requiresConfirmation: true, savedAt: checkpoint.savedAt, writeToken: checkpoint.writeToken, draft: checkpoint.draft, selectedIds: checkpoint.selectedIds };
        },
    };
}
