import { modelOptionName, type ModelChannel } from "@/stores/use-config-store";

export function resolveFrameScriptSettingsChannel(channels: ModelChannel[], config: Record<string, unknown>): ModelChannel | undefined {
    const available = channels.filter((channel) => channel.enabled !== false && channel.models.length > 0);
    const configuredModels = [config.visionModel, config.promptModel, config.transcriptionModel]
        .filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    return available.find((channel) => channel.id === config.channelId)
        || available.find((channel) => configuredModels.some((model) => channel.models.some((item) => modelOptionName(item) === model.trim())))
        || available.find((channel) => channel.modelCosts?.some((model) => model.capability === "text" && channel.models.includes(model.model)))
        || available[0];
}
