import { expect, test } from "bun:test";
import { resolveFrameScriptSettingsChannel } from "../src/pages/plugins/framescript-settings-channel";
import type { ModelChannel } from "../src/stores/use-config-store";

const channels = [
    { id: "empty", enabled: true, models: [] },
    { id: "first", enabled: true, models: ["vision-a"] },
    { id: "second", enabled: true, models: ["vision-b"] },
    { id: "disabled", enabled: false, models: ["vision-c"] },
] as ModelChannel[];

test("a new user starts with an available channel rather than empty model options", () => {
    expect(resolveFrameScriptSettingsChannel(channels, {})?.id).toBe("first");
});

test("valid personal channel selections are preserved", () => {
    expect(resolveFrameScriptSettingsChannel(channels, { channelId: "second" })?.id).toBe("second");
});

test("a retired channel is resolved by its saved model before choosing a default", () => {
    expect(resolveFrameScriptSettingsChannel(channels, { channelId: "retired", visionModel: "vision-b" })?.id).toBe("second");
});

test("empty or disabled channels never become the default and no channel is invented", () => {
    expect(resolveFrameScriptSettingsChannel(channels, { channelId: "disabled" })?.id).toBe("first");
    expect(resolveFrameScriptSettingsChannel([channels[0], channels[3]], {})).toBeUndefined();
});
