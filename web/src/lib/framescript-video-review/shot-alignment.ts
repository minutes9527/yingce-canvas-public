/** Order-preserving alignment. A shot receives a contiguous span, or no speech. */
export function alignFrameScriptUnits(units: readonly string[], durations: readonly number[], scores: readonly (readonly number[])[]) {
    if (!units.length || !durations.length || scores.length !== units.length || scores.some(row => row.length !== durations.length || row.some(s => !Number.isFinite(s) || s < 0 || s > 1)) || durations.some(d => !Number.isFinite(d) || d <= 0)) throw new Error("文案匹配数据不完整");
    const n = units.length, m = durations.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(Infinity));
    const previous = Array.from({ length: m + 1 }, () => Array(n + 1).fill(-1));
    dp[0][0] = 0;
    for (let shot = 1; shot <= m; shot++) {
        for (let end = 0; end <= n; end++) {
            let semantic = 0, characters = 0;
            for (let start = end; start >= 0; start--) {
                if (start < end) { semantic += 1 - scores[start][shot - 1]; characters += units[start].replace(/\s/g, "").length; }
                // Estimated speech rate only; surface overflow for human review.
                const seconds = characters / 4;
                const overflow = Math.max(0, seconds - durations[shot - 1]) / durations[shot - 1];
                const cost = dp[shot - 1][start] + semantic + overflow * overflow * 2 + (start === end ? 0.15 : 0);
                if (cost < dp[shot][end]) { dp[shot][end] = cost; previous[shot][end] = start; }
            }
        }
    }
    const result: { unitIds: number[]; dialogue: string; estimatedSeconds: number; warnings: string[] }[] = [];
    let end = n;
    for (let shot = m; shot > 0; shot--) {
        const start = previous[shot][end];
        if (start < 0) throw new Error("无法生成连续的镜头分配");
        const unitIds = Array.from({ length: end - start }, (_, offset) => start + offset);
        const dialogue = units.slice(start, end).join("");
        const estimatedSeconds = dialogue.replace(/\s/g, "").length / 4;
        const warnings: string[] = [];
        if (estimatedSeconds > durations[shot - 1]) warnings.push(`台词预估 ${Math.ceil(estimatedSeconds)} 秒，超过镜头 ${durations[shot - 1]} 秒，建议延长或补镜头`);
        if (unitIds.some(id => scores[id][shot - 1] < 0.45)) warnings.push("画面与文案匹配较弱，建议改编或补镜头");
        result.unshift({ unitIds, dialogue, estimatedSeconds, warnings });
        end = start;
    }
    return result;
}

export function splitFrameScriptNarration(text: string) {
    const units = text.trim().match(/[^。！？!?\n]+[。！？!?]?|\n+/g)?.filter(unit => unit.trim()) || [];
    if (!units.length || units.length > 100) throw new Error("文案需包含 1–100 个完整表达单元");
    return units;
}

export function parseFrameScriptModelJson(content: string): unknown {
    return JSON.parse(content.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
}
