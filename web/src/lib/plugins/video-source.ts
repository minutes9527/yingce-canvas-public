import { VideoPluginError } from "./video-plugin";

/** A saved ID alone is insufficient: bytes may be replaced under an existing resource. */
export async function fingerprintVideoSource(blob: Blob, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (blob.size > 256 * 1024 * 1024) throw new VideoPluginError("invalid-input", "浏览器复核流程暂支持 256 MiB 以内视频；大文件需接入 Runtime 流式指纹计算");
    const bytes = await blob.arrayBuffer();
    signal?.throwIfAborted();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    signal?.throwIfAborted();
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
