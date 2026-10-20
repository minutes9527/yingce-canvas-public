import { expect, test } from "bun:test";

import { normalizeLocalDreaminaAspect, normalizeLocalDreaminaImageResolution } from "../src/services/local-dreamina-parameters";

test("keeps supported Dreamina ratios unchanged", () => {
    expect(normalizeLocalDreaminaAspect("1:1", "image")).toBe("1:1");
    expect(normalizeLocalDreaminaAspect("9:16", "video")).toBe("9:16");
});

test("converts upstream pixel presets back to Dreamina ratios", () => {
    expect(normalizeLocalDreaminaAspect("1024x1024", "image")).toBe("1:1");
    expect(normalizeLocalDreaminaAspect("1824x1024", "image")).toBe("16:9");
    expect(normalizeLocalDreaminaAspect("1024x1824", "image")).toBe("9:16");
    expect(normalizeLocalDreaminaAspect("2048x878", "image")).toBe("21:9");
});

test("omits invalid or automatic sizes instead of sending an invalid Dreamina aspect", () => {
    expect(normalizeLocalDreaminaAspect("auto", "image")).toBeUndefined();
    expect(normalizeLocalDreaminaAspect("", "video")).toBeUndefined();
});

test("maps automatic image quality to a CLI resolution accepted by every Dreamina image model", () => {
    expect(normalizeLocalDreaminaImageResolution("auto", "local:dreamina-cli:4.5")).toBe("2k");
    expect(normalizeLocalDreaminaImageResolution("4k", "local:dreamina-cli:3.0")).toBe("2k");
    expect(normalizeLocalDreaminaImageResolution("1k", "local:dreamina-cli:4.7")).toBe("2k");
    expect(normalizeLocalDreaminaImageResolution("high", "local:dreamina-cli:5.0Pro")).toBe("4k");
});
