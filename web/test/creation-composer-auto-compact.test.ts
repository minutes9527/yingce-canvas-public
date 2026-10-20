import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("creation composer layout", () => {
    const page = readFileSync(resolve(import.meta.dir, "../src/pages/create/index.tsx"), "utf8");
    const composer = readFileSync(resolve(import.meta.dir, "../src/pages/create/creation-workspace.tsx"), "utf8");
    const styles = readFileSync(resolve(import.meta.dir, "../src/styles/globals.css"), "utf8");

    test("keeps the launchpad in flow and offers a shortcut after it scrolls away", () => {
        expect(page).toContain("const [launchpadCondensed, setLaunchpadCondensed] = useState(false)");
        expect(page).toContain("setLaunchpadCondensed(true)");
        expect(page).toContain("setLaunchpadCondensed(false)");
        expect(page).toContain("onScroll={handleThreadScroll}");
        expect(page).toContain('className="creation-floating-prompt"');
        expect(page).toContain('className="creation-launchpad"');
    });

    test("keeps the thread composer compact without hiding its controls", () => {
        expect(page).toContain('<CreationComposer {...composerProps} variant="thread" />');
        expect(composer).toContain("creation-chat-composer is-${props.variant}");
        expect(composer).toContain("<VoiceRecordingButton");
        expect(composer).toContain("<ModePicker");
        expect(composer).toContain("<ModelPicker");
        expect(composer).toContain("<GenerationSettingsMenu");
        expect(composer).toContain("creation-reference-add-button");
        expect(styles).toContain(".app-user-workspace .creation-chat-composer.is-thread .creation-chat-writing-surface");
        expect(styles).toContain("min-height: 40px !important");
    });
});
