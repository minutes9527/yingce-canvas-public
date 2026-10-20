import { App, Button, InputNumber } from "antd";
import { useEffect, useMemo, useState } from "react";

import { AppModal } from "@/components/ui/product/app-modal";
import { Select } from "@/components/ui/base/select";
import { listAdminChannels } from "@/services/api/auth";
import { fetchAdminFrameScriptConfig, saveAdminFrameScriptConfig, type FrameScriptConfig } from "@/services/api/plugins";
import type { ModelChannel } from "@/stores/use-config-store";

const emptyConfig: FrameScriptConfig = {
    channelId: "", transcriptionChannelId: "", visionModel: "", promptModel: "", transcriptionModel: "",
    changeThreshold: 0.32, samplingIntervalMs: 400,
};

const modelLabel = (model: { model: string; displayName?: string }) =>
    model.displayName && model.displayName !== model.model ? `${model.displayName} · ${model.model}` : model.model;

export function FrameScriptConfigModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const [config, setConfig] = useState<FrameScriptConfig>(emptyConfig);
    const [channels, setChannels] = useState<ModelChannel[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        let active = true;
        setLoading(true);
        void (async () => {
            try {
                const [saved, first] = await Promise.all([fetchAdminFrameScriptConfig(), listAdminChannels({ page: 1, pageSize: 100 })]);
                const all = [...first.channels];
                for (let page = 2; all.length < first.total; page += 1) {
                    const next = await listAdminChannels({ page, pageSize: 100 });
                    all.push(...next.channels);
                    if (!next.channels.length) break;
                }
                if (active) { setConfig(saved || emptyConfig); setChannels(all.filter((item) => item.enabled)); }
            } catch (error) {
                if (active) message.error(error instanceof Error ? error.message : "读取视频拆解配置失败");
            } finally { if (active) setLoading(false); }
        })();
        return () => { active = false; };
    }, [open, message]);

    const main = channels.find((channel) => channel.id === config.channelId);
    const transcription = channels.find((channel) => channel.id === (config.transcriptionChannelId || config.channelId));
    const visionOptions = useMemo(() => (main?.modelCosts || []).filter((model) => model.capability === "text" && (
        (model.capabilityConfig?.text?.references?.maxImages ?? 0) > 0 || /-vl|vision|omni/i.test(model.model)
    )).map((model) => ({ value: model.model, label: modelLabel(model) })), [main]);
    const transcriptionOptions = useMemo(() => (transcription?.modelCosts || []).filter((model) =>
        model.protocol === "openai-audio" || /asr|whisper|transcri|^qwen3\.5-omni-/i.test(model.model)
    ).map((model) => ({ value: model.model, label: modelLabel(model) })), [transcription]);
    const channelOptions = channels.map((channel) => ({ value: channel.id, label: channel.name }));
    const set = (patch: Partial<FrameScriptConfig>) => setConfig((current) => ({ ...current, ...patch }));
    const save = async () => {
        setSaving(true);
        try {
            const saved = await saveAdminFrameScriptConfig(config);
            setConfig(saved);
            message.success("视频拆解配置已保存，可在插件管理中开放给用户");
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存视频拆解配置失败");
        } finally { setSaving(false); }
    };

    return <AppModal title="视频拆解 · 管理员配置" open={open} onCancel={onClose} footer={<><Button onClick={onClose}>取消</Button><Button type="primary" loading={saving} onClick={() => void save()}>保存配置</Button></>}>
        <div className="grid gap-4 py-2">
            <p className="text-sm text-foreground/60">所有用户共用此配置。渠道密钥仍由系统渠道管理，模型调用按发起用户计费。</p>
            <label className="grid gap-1"><span>画面分析与提示词渠道</span><Select aria-label="画面分析与提示词渠道" loading={loading} value={config.channelId || undefined} options={channelOptions} onChange={(channelId: string) => set({ channelId, visionModel: "", promptModel: "", ...(!config.transcriptionChannelId ? { transcriptionModel: "" } : {}) })} /></label>
            <label className="grid gap-1"><span>画面分析模型</span><Select aria-label="画面分析模型" value={config.visionModel || undefined} options={visionOptions} onChange={(visionModel: string) => set({ visionModel })} /></label>
            <label className="grid gap-1"><span>图片提示词模型</span><Select aria-label="图片提示词模型" value={config.promptModel || undefined} options={visionOptions} onChange={(promptModel: string) => set({ promptModel })} /></label>
            <label className="grid gap-1"><span>转写渠道（可选）</span><Select aria-label="转写渠道" allowClear value={config.transcriptionChannelId || undefined} options={channelOptions} onChange={(transcriptionChannelId?: string) => set({ transcriptionChannelId: transcriptionChannelId || "", transcriptionModel: "" })} /></label>
            <label className="grid gap-1"><span>语音转写模型</span><Select aria-label="语音转写模型" value={config.transcriptionModel || undefined} options={transcriptionOptions} onChange={(transcriptionModel: string) => set({ transcriptionModel })} /></label>
            <div className="grid grid-cols-2 gap-4">
                <label className="grid gap-1"><span>候选帧变化阈值</span><InputNumber className="w-full" min={0.01} max={1} step={0.01} value={config.changeThreshold} onChange={(changeThreshold) => set({ changeThreshold: changeThreshold ?? 0.32 })} /></label>
                <label className="grid gap-1"><span>扫描间隔（毫秒）</span><InputNumber className="w-full" min={100} max={2000} step={100} value={config.samplingIntervalMs} onChange={(samplingIntervalMs) => set({ samplingIntervalMs: samplingIntervalMs ?? 400 })} /></label>
            </div>
            <p className="text-xs text-foreground/50">仅列出已启用且定价的匹配模型。保存时再次校验渠道、输入能力和价格档。</p>
        </div>
    </AppModal>;
}
