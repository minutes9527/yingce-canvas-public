import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Tag } from "antd";
import { Plus, RotateCcw, WandSparkles, X } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import { ModelPicker } from "@/components/model-picker";
import type { AiConfig } from "@/stores/use-config-store";
import { defaultImageParamsForModel } from "@/lib/model-selection";

export type CanvasImageBackgroundExtractionPayload = {
    prompt: string;
    regions?: Array<[number, number, number, number]>;
    generationConfig?: Partial<Pick<AiConfig, "model" | "imageModel" | "size" | "quality">>;
};

const DEFAULT_PROMPT = "移除原帧中的人物，补全人物遮挡的车身、道路和街景。尽量直接复用原帧已有的汽车、建筑、树木、天空、街道与光影，保持视角和构图，不要生成新人物。";

export function CanvasNodeBackgroundExtractionDialog({
    dataUrl,
    open,
    config,
    onClose,
    onConfirm,
}: {
    dataUrl: string;
    open: boolean;
    config: AiConfig;
    onClose: () => void;
    onConfirm: (payload: CanvasImageBackgroundExtractionPayload) => void;
}) {
    const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
    const [generationConfig, setGenerationConfig] = useState<AiConfig>(config);
    const [regions, setRegions] = useState<Array<[number, number, number, number]>>([]);
    const [drawing, setDrawing] = useState<{ x: number; y: number } | null>(null);
    const [draft, setDraft] = useState<[number, number, number, number] | null>(null);
    const imageFrameRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        setPrompt(DEFAULT_PROMPT);
        setGenerationConfig(config);
        setRegions([]);
        setDrawing(null);
        setDraft(null);
    }, [config, dataUrl, open]);

    const point = (event: ReactPointerEvent<HTMLDivElement>) => {
        const rect = imageFrameRef.current?.getBoundingClientRect();
        if (!rect) return null;
        return {
            x: Math.max(0, Math.min(1000, ((event.clientX - rect.left) / Math.max(1, rect.width)) * 1000)),
            y: Math.max(0, Math.min(1000, ((event.clientY - rect.top) / Math.max(1, rect.height)) * 1000)),
        };
    };

    const startBox = (event: ReactPointerEvent<HTMLDivElement>) => {
        const next = point(event);
        if (!next) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrawing(next);
        setDraft([next.x, next.y, next.x, next.y]);
    };

    const moveBox = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!drawing) return;
        const next = point(event);
        if (!next) return;
        setDraft([Math.min(drawing.x, next.x), Math.min(drawing.y, next.y), Math.max(drawing.x, next.x), Math.max(drawing.y, next.y)]);
    };

    const finishBox = () => {
        if (!draft) return;
        const [x1, y1, x2, y2] = draft;
        if (x2 - x1 >= 2 && y2 - y1 >= 2) setRegions((current) => [...current, [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)]]);
        setDrawing(null);
        setDraft(null);
    };

    const selectedPrompt = prompt.trim();

    return (
        <AppModal open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} centered destroyOnHidden width={900} title="提取完整背景">
            <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_320px]">
                <div className="grid min-h-[340px] place-items-center overflow-hidden rounded-xl bg-black/5 p-3 dark:bg-white/[0.04]">
                    <div ref={imageFrameRef} className="relative inline-block max-h-[60vh] max-w-full select-none" onPointerDown={startBox} onPointerMove={moveBox} onPointerUp={finishBox} onPointerCancel={finishBox}>
                        <img src={dataUrl} alt="待拆分图片" className="block max-h-[60vh] max-w-full object-contain" draggable={false} />
                        <div className="pointer-events-none absolute inset-0">
                            {regions.map((region, index) => <RegionBox key={`${region.join("-")}-${index}`} region={region} label={index + 1} />)}
                            {draft ? <RegionBox region={draft} label={regions.length + 1} draft /> : null}
                        </div>
                    </div>
                </div>
                <div className="flex flex-col gap-4">
                    <div>
                        <h3 className="text-lg font-semibold">移除人物，保留原帧背景</h3>
                        <p className="mt-1 text-sm opacity-60">可框选需要去掉的人物。车和街景尽量沿用原帧；被遮挡的部分参考上游分析补全。生成一张背景图，结果仍需检查。</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Tag color={regions.length ? "blue" : "default"}>{regions.length ? `已框选 ${regions.length} 个区域` : "未框选，自动识别人物"}</Tag>
                        {regions.length ? <Button size="small" icon={<RotateCcw className="size-3.5" />} onClick={() => setRegions([])}>清除选区</Button> : <span className="text-xs opacity-55"><Plus className="mr-1 inline size-3" />在左侧图片上拖动添加选区</span>}
                    </div>
                    <Input.TextArea rows={7} value={prompt} placeholder="例如：移除人物，补全原本被挡住的车身和道路，保留街景" onChange={(event) => setPrompt(event.target.value)} />
                    <div className="space-y-2">
                        <div className="text-sm font-medium opacity-75">图片编辑模型</div>
                        <ModelPicker
                            config={generationConfig}
                            value={generationConfig.imageModel || generationConfig.model}
                            capability="image"
                            fullWidth
                            showSelectedPrice={false}
                            onChange={(model) => setGenerationConfig((current) => ({ ...current, model, imageModel: model, ...defaultImageParamsForModel(current, model) }))}
                        />
                    </div>
                    <div className="mt-auto flex justify-end gap-2">
                        <Button icon={<X className="size-4" />} onClick={onClose}>取消</Button>
                        <Button type="primary" icon={<WandSparkles className="size-4" />} disabled={!selectedPrompt} onClick={() => onConfirm({ prompt: selectedPrompt, regions, generationConfig: { model: generationConfig.model, imageModel: generationConfig.imageModel, size: generationConfig.size, quality: generationConfig.quality } })}>
                            生成背景
                        </Button>
                    </div>
                </div>
            </div>
        </AppModal>
    );
}

function RegionBox({ region, label, draft = false }: { region: [number, number, number, number]; label: number; draft?: boolean }) {
    const [x1, y1, x2, y2] = region;
    return <div className={`absolute rounded-sm border-2 ${draft ? "border-dashed border-blue-500 bg-blue-500/10" : "border-solid border-amber-400 bg-amber-400/10"}`} style={{ left: `${x1 / 10}%`, top: `${y1 / 10}%`, width: `${(x2 - x1) / 10}%`, height: `${(y2 - y1) / 10}%` }}><span className="absolute -left-0.5 -top-0.5 grid size-5 -translate-y-1/2 -translate-x-1/2 place-items-center rounded-full bg-amber-400 text-[11px] font-semibold text-black shadow">{label}</span></div>;
}
