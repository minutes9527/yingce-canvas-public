const IMAGE_ASPECTS = ["21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"] as const;
const VIDEO_ASPECTS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;

export function normalizeLocalDreaminaAspect(value: unknown, mode: "image" | "video") {
    if (typeof value !== "string") return undefined;
    const match = /^\s*(\d{1,5})\s*[:x×]\s*(\d{1,5})\s*$/i.exec(value);
    if (!match) return undefined;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;

    const target = width / height;
    const aspects = mode === "image" ? IMAGE_ASPECTS : VIDEO_ASPECTS;
    return aspects.reduce((nearest, candidate) => {
        const [candidateWidth, candidateHeight] = candidate.split(":").map(Number);
        const [nearestWidth, nearestHeight] = nearest.split(":").map(Number);
        return Math.abs(candidateWidth / candidateHeight - target) < Math.abs(nearestWidth / nearestHeight - target) ? candidate : nearest;
    });
}

export function normalizeLocalDreaminaImageResolution(value: unknown, model: string) {
    const requested = typeof value === "string" ? value.trim().toLowerCase() : "";
    const modelName = model.replace(/^local:dreamina-cli:/, "");
    const legacyModel = modelName === "3.0" || modelName === "3.1";
    if (requested === "4k" || requested === "high") return legacyModel ? "2k" : "4k";
    if (requested === "1k" || requested === "low") return legacyModel ? "1k" : "2k";
    return "2k";
}
