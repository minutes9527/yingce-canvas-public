import type { VideoAnalysisKeyframe } from "@/lib/plugins/video-plugin";
import { http, type HttpRequestConfig } from "./request";

type FrameScriptKeyframesResponse = {
    sourceFingerprint: string;
    durationMs: number;
    keyframes: VideoAnalysisKeyframe[];
    detectors: string[];
};

/**
 * Candidate extraction is intentionally resource-ID based. The server checks
 * ownership and opens the saved resource itself; the browser never sends a
 * file path, signed URL, or raw video bytes to this endpoint.
 */
export function extractFrameScriptKeyframes(resourceId: string, input: { samplingIntervalMs?: number; changeThreshold?: number }, config?: HttpRequestConfig) {
    return http.post<FrameScriptKeyframesResponse>(`/resources/${encodeURIComponent(resourceId)}/framescript-keyframes`, input, config);
}

/** The server derives a real MP3 track from an owned video; the client never relabels MP4 bytes as audio. */
export async function extractFrameScriptTranscriptionAudio(resourceId: string, config?: HttpRequestConfig) {
    const response = await http.raw<Blob>({
        method: "post",
        url: `/resources/${encodeURIComponent(resourceId)}/framescript-transcription-audio`,
        responseType: "blob",
        ...config,
    });
    const rawFingerprint = response.headers["x-framescript-source-fingerprint"];
    const fingerprint = Array.isArray(rawFingerprint) ? rawFingerprint[0] : rawFingerprint;
    if (typeof fingerprint !== "string" || !fingerprint) throw new Error("转写音频缺少视频校验信息");
    return { audio: response.data, sourceFingerprint: fingerprint };
}
