/**
 * Separates text visible inside a source frame from the visual description.
 * The latter is safe to send to image generation; the former is rendered as a
 * dedicated caption field so it cannot be accidentally baked into the image.
 */
export function separateVideoScreenText(value: string | undefined): { visual: string; screenText?: string } {
    let visual = (value || "").trim();
    const texts: string[] = [];
    const patterns = [
        /(?:画面(?:下方|上方|中央)?)(?:中)?(?:有|显示|出现|为)?(?:字幕|文字)(?:显示)?\s*[:：]?\s*[“"「]?([^”"」。\n]+)[”"」]?/gu,
        /(?:on[- ]screen text|subtitles?)\s*[:：]?\s*[“"「]?([^”"」.\n]+)[”"」]?/giu,
    ];
    for (const pattern of patterns) {
        visual = visual.replace(pattern, (_match, text: string) => {
            const normalized = text.trim().replace(/[，,。；;]+$/u, "");
            if (normalized) texts.push(normalized);
            return "";
        });
    }
    visual = visual
        .replace(/\s{2,}/gu, " ")
        .replace(/。{2,}/gu, "。")
        .replace(/\.{2,}/gu, ".")
        .replace(/([，,：:])\s*[。.]?\s*$/u, "")
        .replace(/\s+([，。！？；：、])/gu, "$1")
        .trim();
    return { visual, screenText: texts.length ? Array.from(new Set(texts)).join("；") : undefined };
}
