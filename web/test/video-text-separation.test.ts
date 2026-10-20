import { describe, expect, test } from "bun:test";

import { separateVideoScreenText } from "@/lib/plugins/video-text-separation";

describe("FrameScript visual prompt and on-screen text separation", () => {
    test("moves Chinese lower-screen captions out of the visual description", () => {
        const result = separateVideoScreenText("客厅内摆放着米色沙发。画面下方有字幕：“还在娘家全款买了这套房给我”。");
        expect(result.visual).toBe("客厅内摆放着米色沙发。");
        expect(result.screenText).toBe("还在娘家全款买了这套房给我");
    });

    test("keeps prompts without visible text unchanged", () => {
        const result = separateVideoScreenText("孕妇站在打开车门的黑色汽车旁，阳光明媚。");
        expect(result.visual).toBe("孕妇站在打开车门的黑色汽车旁，阳光明媚。");
        expect(result.screenText).toBeUndefined();
    });
});
