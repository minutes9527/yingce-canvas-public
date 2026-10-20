import { useState } from "react";
import { Popover } from "antd";
import { ChevronDown, Sparkles } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { dreaminaVideoModeOptions, type DreaminaVideoMode } from "@/lib/dreamina-video-modes";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { AiConfig } from "@/stores/use-config-store";

export function CanvasDreaminaVideoModePicker({ config, value, onChange }: { config: AiConfig; value: DreaminaVideoMode; onChange: (value: DreaminaVideoMode) => void }) {
    const operations = modelCapabilityConfigFor(config, config.model).video?.operations || [];
    const options = dreaminaVideoModeOptions.filter((option) => option.available).map((option) => ({ ...option, supported: option.value === "all_reference"
        ? operations.includes("text_to_video") || operations.includes("reference_to_video")
        : option.value === "first_last_frames" ? operations.includes("image_to_video")
        : operations.includes("multi_frame_to_video") }));
    return <CanvasVideoModePicker value={value} options={options} onChange={onChange} />;
}

export function CanvasVideoModePicker<T extends string>({ value, options, onChange }: { value: T; options: ReadonlyArray<{ value: T; label: string; description: string; supported: boolean }>; onChange: (value: T) => void }) {
    const [open, setOpen] = useState(false);
    const theme = canvasThemes[useActiveTheme()];
    const current = options.find((option) => option.value === value);
    const content = (
        <div className="w-56 max-w-[calc(100vw-24px)] space-y-0.5" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
            {options.map((option) => {
                return (
                    <button
                        key={option.value}
                        type="button"
                        disabled={!option.supported}
                        aria-current={option.value === value ? "true" : undefined}
                        className="block w-full rounded-md px-2.5 py-2 text-left transition-colors enabled:hover:bg-[var(--canvas-composer-control-hover)] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline focus-visible:outline-2"
                        style={option.value === value ? { background: theme.accent.primarySoft } : undefined}
                        onClick={() => {
                            onChange(option.value);
                            setOpen(false);
                        }}
                    >
                        <span className="block text-[var(--fs-tiny)] font-medium" style={{ color: theme.node.text }}>{option.label}</span>
                        <span className="mt-0.5 block text-[var(--fs-micro)] leading-4" style={{ color: theme.node.muted }}>{option.description}</span>
                    </button>
                );
            })}
        </div>
    );

    return (
        <Popover
            open={open}
            onOpenChange={setOpen}
            trigger="click"
            placement="topLeft"
            arrow={false}
            content={content}
            classNames={{ container: "canvas-composer-popover-surface", content: "canvas-composer-popover-content" }}
        >
            <button
                type="button"
                data-canvas-no-zoom
                aria-label={`即梦视频模式：${current?.label || "全能参考"}`}
                aria-expanded={open}
                className="inline-flex h-7 w-[130px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[var(--fs-tiny)] transition-colors focus-visible:outline focus-visible:outline-2"
                style={{ background: theme.node.fill, color: theme.node.text }}
            >
                <Sparkles className="size-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">{current?.label || "全能参考"}</span>
                <ChevronDown className="size-3 shrink-0" />
            </button>
        </Popover>
    );
}
