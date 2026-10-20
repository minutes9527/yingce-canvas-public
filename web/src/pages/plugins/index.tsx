import { CollectionToolbar } from "@/components/layout/collection-toolbar";
import { App, Button, Input, Modal, Typography } from "antd";
import { Switch } from "@/components/ui/base/switch";
import { AudioLines, CalendarDays, CheckCircle2, Clock3, CreditCard, ExternalLink, Film, FolderOpen, Image as ImageIcon, MessageSquareText, PlugZap, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { EmptyState } from "@/components/ui/product/empty-state";
import { PageHeader } from "@/components/layout/workspace-page";
import { listRegisteredPlugins } from "@/lib/plugins/plugin-registry";
import "@/lib/plugins/builtin";
import { EAGLE_PLUGIN_ID } from "@/lib/plugins/builtin/eagle";
import { DEFAULT_FRAMESCRIPT_PROMPT_MODEL, DEFAULT_FRAMESCRIPT_TRANSCRIPTION_MODEL, DEFAULT_FRAMESCRIPT_VISION_MODEL, FRAMESCRIPT_VIDEO_ENGINE_ID } from "@/lib/plugins/builtin/framescript-video-engine";
import { PROMPT_OPTIMIZER_PLUGIN_ID } from "@/lib/plugins/builtin/prompt-optimizer";
import { RUNNINGHUB_PLUGIN_ID } from "@/lib/plugins/builtin/workflows";
import { isOfficialApplicationPluginId } from "@/lib/plugins/official-applications";
import type { PluginManifest, PluginManifestV2, RegisteredPlugin } from "@/lib/plugins/plugin-types";
import { getEagleLibrary, type EagleFolder } from "@/services/api/eagle";
import { listAdminChannels } from "@/services/api/auth";
import { fetchPlugins, setUserPluginEnabled, type BackendPlugin, type PluginState } from "@/services/api/plugins";
import { refreshSystemChannels } from "@/lib/user-session";
import { modelOptionName, type ModelChannel } from "@/stores/use-config-store";
import { useAppearanceStore } from "@/stores/use-appearance-store";
import { usePluginStore } from "@/stores/use-plugin-store";
import { useUserStore } from "@/stores/use-user-store";

import { PluginDetailsModal } from "./plugin-documentation-modals";
import { resolveFrameScriptSettingsChannel } from "./framescript-settings-channel";
import "./plugins.css";
import { Select } from "@/components/ui/base/select";

const categoryLabels: Record<string, string> = {
    provider: "模型渠道",
    "payment-provider": "支付协议",
    "canvas-node": "画布节点",
    workflow: "工作流",
    transform: "媒体转换",
    "asset-source": "素材来源",
    "ai-capability": "AI 能力",
    "usage-observer": "用量观察",
    agent: "智能体",
    "import-export": "导入导出",
};

const surfaceLabels: Record<string, string> = {
    node: "画布节点",
    fullscreen: "全屏工作台",
    hybrid: "混合接入",
    "asset-source": "素材库",
};

const permissionLabels: Record<string, string> = {
    "canvas.read": "读取画布",
    "canvas.write": "修改画布",
    "asset.read": "读取素材",
    "asset.search": "搜索素材",
    "asset.import": "导入素材",
    "asset.upload": "上传素材",
    "generation.run": "调用生成",
    "ai.text": "调用已配置的文本/视觉理解模型",
    "media.read": "读取输入媒体",
    "external.open": "打开外部详情",
};

const pluginDateFormatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" });

// The modal container clips overflow; render Select menus outside it on narrow viewports.
const getPluginSettingsPopupContainer = (): HTMLElement => document.body;

const protocolSectionMeta = [
    { key: "text", label: "文本协议", description: "对话、推理与流式响应", icon: MessageSquareText },
    { key: "image", label: "图片协议", description: "生成、编辑与参考图", icon: ImageIcon },
    { key: "video", label: "视频协议", description: "创建任务、轮询与媒体结果", icon: Film },
    { key: "audio", label: "音频协议", description: "语音与异步音频任务", icon: AudioLines },
    { key: "payment", label: "支付协议", description: "支付、查单、关单与对账", icon: CreditCard },
] as const;

export default function PluginsPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const brandName = useAppearanceStore((state) => state.appearance.brandName);
    const user = useUserStore((state) => state.user);
    const features = useUserStore((state) => state.features);
    const installations = usePluginStore((state) => state.installations);
    const ensurePlugin = usePluginStore((state) => state.ensurePlugin);
    const setEnabled = usePluginStore((state) => state.setEnabled);
    const setRuntimeStatuses = usePluginStore((state) => state.setRuntimeStatuses);
    const setPluginStates = usePluginStore((state) => state.setPluginStates);
    const pluginStates = usePluginStore((state) => state.pluginStates);
    const updateConfig = usePluginStore((state) => state.updateConfig);
    const builtinPlugins = useMemo(() => listRegisteredPlugins(), []);
    const [backendPlugins, setBackendPlugins] = useState<BackendPlugin[]>([]);
    const [frameScriptAdminChannels, setFrameScriptAdminChannels] = useState<ModelChannel[]>([]);
    const [frameScriptChannelsLoading, setFrameScriptChannelsLoading] = useState(false);
    const [frameScriptChannelsError, setFrameScriptChannelsError] = useState("");
    const [frameScriptChannelsRefresh, setFrameScriptChannelsRefresh] = useState(0);
    const [frameScriptChannelId, setFrameScriptChannelId] = useState("");
    const [frameScriptTranscriptionChannelId, setFrameScriptTranscriptionChannelId] = useState("");
    const [frameScriptVisionModel, setFrameScriptVisionModel] = useState("");
    const [frameScriptPromptModel, setFrameScriptPromptModel] = useState("");
    const [frameScriptTranscriptionModel, setFrameScriptTranscriptionModel] = useState("");
    const [frameScriptChangeThreshold, setFrameScriptChangeThreshold] = useState(0.32);
    const [frameScriptSamplingIntervalMs, setFrameScriptSamplingIntervalMs] = useState(400);
    const [backendPluginsLoading, setBackendPluginsLoading] = useState(false);
    const [settingsPluginId, setSettingsPluginId] = useState<string | null>(null);
    const [detailsPluginId, setDetailsPluginId] = useState<string | null>(null);
    const [detailsRestoreFocus, setDetailsRestoreFocus] = useState(false);
    const [search, setSearch] = useState("");
    const [categoryFilter, setCategoryFilter] = useState("all");
    const [statusFilter, setStatusFilter] = useState<"all" | "enabled" | "disabled">("all");
    const [trustFilter, setTrustFilter] = useState<"all" | "trusted">("all");
    const [eagleBaseUrl, setEagleBaseUrl] = useState("http://localhost:41595");
    const [eagleAutoUploadGenerated, setEagleAutoUploadGenerated] = useState(true);
    const [eagleGeneratedFolderId, setEagleGeneratedFolderId] = useState("");
    const [eagleFolders, setEagleFolders] = useState<EagleFolder[]>([]);
    const [eagleFoldersLoading, setEagleFoldersLoading] = useState(false);
    const [eagleFoldersError, setEagleFoldersError] = useState("");

    useEffect(() => {
        for (const plugin of builtinPlugins) ensurePlugin(plugin.manifest);
    }, [builtinPlugins, ensurePlugin]);

    const reloadBackendPlugins = async () => {
        setBackendPluginsLoading(true);
        try {
            const result = await fetchPlugins();
            setBackendPlugins(result.plugins);
            setPluginStates(result.states);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取插件中心失败");
            setBackendPlugins([]);
        } finally {
            setBackendPluginsLoading(false);
        }
    };

    useEffect(() => {
        void reloadBackendPlugins();
    }, [user?.id]);

    const remotePlugins = useMemo(() => backendPlugins.map(toRegisteredPlugin), [backendPlugins]);
    const registeredPlugins = useMemo(() => {
        const byId = new Map(builtinPlugins.map((plugin) => [plugin.manifest.id, plugin]));
        for (const plugin of remotePlugins) {
            const builtin = byId.get(plugin.manifest.id);
            // Older server-side FrameScript packages did not include the
            // configuration contract. Keep the bundled fields in that one
            // compatibility case so users can repair the channel binding
            // instead of receiving an empty settings dialog. A server manifest
            // that does declare fields remains authoritative.
            const missingFrameScriptConfiguration = plugin.manifest.id === FRAMESCRIPT_VIDEO_ENGINE_ID
                && !plugin.manifest.configuration?.fields?.length
                && Boolean(builtin?.manifest.configuration?.fields?.length);
            byId.set(plugin.manifest.id, missingFrameScriptConfiguration
                ? { ...plugin, manifest: { ...plugin.manifest, configuration: builtin!.manifest.configuration } }
                : plugin);
        }
        return [...byId.values()];
    }, [builtinPlugins, remotePlugins]);
    const backendPluginById = useMemo(() => new Map(backendPlugins.map((plugin) => [plugin.manifest.id, plugin])), [backendPlugins]);

    const eagle = installations.find((item) => item.manifest.id === EAGLE_PLUGIN_ID);

    useEffect(() => {
        const configured = eagle?.config.baseUrl;
        if (typeof configured === "string" && configured.trim()) setEagleBaseUrl(configured);
        const autoUpload = eagle?.config.autoUploadGenerated;
        setEagleAutoUploadGenerated(autoUpload !== false && autoUpload !== "false");
        const folderId = eagle?.config.generatedFolderId;
        setEagleGeneratedFolderId(typeof folderId === "string" ? folderId : "");
    }, [eagle?.config.baseUrl, eagle?.config.autoUploadGenerated, eagle?.config.generatedFolderId]);

    const filteredPlugins = useMemo(() => {
        const normalizedSearch = search.trim().toLocaleLowerCase();
        return registeredPlugins.filter((plugin) => {
            const state = pluginStates[plugin.manifest.id];
            const isApplicationPlugin = backendPluginById.get(plugin.manifest.id)?.management.kind === "application" || isOfficialApplicationPluginId(plugin.manifest.id);
            if (user?.role !== "admin" && !features.systemPluginsVisibleToUsers && !isApplicationPlugin) return false;
            const installation = installations.find((item) => item.manifest.id === plugin.manifest.id);
            const enabled = state?.effectiveEnabled ?? Boolean(installation?.enabled);
            const manifest = plugin.manifest;
            const contributionKinds = contributionKindsFor(manifest);
            const searchableText = [manifest.name, manifest.description, manifest.author, manifest.id, ...contributionKinds.map((kind) => categoryLabels[kind] || kind)].filter(Boolean).join(" ").toLocaleLowerCase();
            if (normalizedSearch && !searchableText.includes(normalizedSearch)) return false;
            if (categoryFilter !== "all" && !pluginMatchesCategory(manifest, categoryFilter)) return false;
            if (trustFilter === "trusted" && !manifest.trusted) return false;
            if (statusFilter === "enabled" && !enabled) return false;
            if (statusFilter === "disabled" && enabled) return false;
            return true;
        });
    }, [backendPluginById, categoryFilter, features.systemPluginsVisibleToUsers, installations, pluginStates, registeredPlugins, search, statusFilter, trustFilter, user?.role]);

    const pluginSections = useMemo(
        () =>
            [
                ...protocolSectionMeta.map((section) => ({ ...section, plugins: filteredPlugins.filter((plugin) => pluginMatchesCategory(plugin.manifest, section.key)) })),
                { key: "other", label: "应用插件", description: "画布、素材与工作流扩展", icon: PlugZap, plugins: filteredPlugins.filter((plugin) => pluginMatchesCategory(plugin.manifest, "other")) },
            ].filter((section) => categoryFilter === "all" || section.key === categoryFilter),
        [categoryFilter, filteredPlugins],
    );

    const scrollContainerRef = useRef<HTMLDivElement>(null);

    const selectCategory = (key: string) => {
        setCategoryFilter(key);
        if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = 0;
        }
    };

    const categoryCounts = useMemo(() => {
        const visiblePlugins = registeredPlugins.filter((plugin) => user?.role === "admin" || features.systemPluginsVisibleToUsers || isOfficialApplicationPluginId(plugin.manifest.id));
        const counts: Record<string, number> = { all: visiblePlugins.length, text: 0, image: 0, video: 0, audio: 0, payment: 0, other: 0 };
        for (const plugin of visiblePlugins) {
            for (const section of protocolSectionMeta) {
                if (pluginMatchesCategory(plugin.manifest, section.key)) counts[section.key] += 1;
            }
            if (pluginMatchesCategory(plugin.manifest, "other")) counts.other += 1;
        }
        return counts;
    }, [features.systemPluginsVisibleToUsers, registeredPlugins, user?.role]);

    const settingsPlugin = settingsPluginId ? registeredPlugins.find((plugin) => plugin.manifest.id === settingsPluginId) : undefined;
    const settingsInstallation = settingsPlugin ? installations.find((item) => item.manifest.id === settingsPlugin.manifest.id) : undefined;
    const settingsEnabled = settingsPlugin ? (pluginStates[settingsPlugin.manifest.id]?.effectiveEnabled ?? Boolean(settingsInstallation?.enabled)) : false;
    const detailsPlugin = detailsPluginId ? registeredPlugins.find((plugin) => plugin.manifest.id === detailsPluginId) : undefined;

    const frameScriptChannels = useMemo(
        () => frameScriptAdminChannels.filter((channel) => channel.enabled !== false),
        [frameScriptAdminChannels],
    );
    const selectedFrameScriptChannel = useMemo(
        () => frameScriptChannels.find((channel) => channel.id === frameScriptChannelId),
        [frameScriptChannelId, frameScriptChannels],
    );
    const frameScriptModelOptions = useMemo(() => {
        const models = selectedFrameScriptChannel?.models || [];
        return [...new Set(models.map((model) => modelOptionName(model).trim()).filter(Boolean))].map((model) => ({ value: model, label: model }));
    }, [selectedFrameScriptChannel]);
    const selectedFrameScriptTranscriptionChannel = useMemo(
        () => frameScriptChannels.find((channel) => channel.id === (frameScriptTranscriptionChannelId || frameScriptChannelId)),
        [frameScriptChannelId, frameScriptChannels, frameScriptTranscriptionChannelId],
    );
    const frameScriptTranscriptionModelOptions = useMemo(() => {
        const models = selectedFrameScriptTranscriptionChannel?.models || [];
        return [...new Set(models.map((model) => modelOptionName(model).trim()).filter(Boolean))].map((model) => ({ value: model, label: model }));
    }, [selectedFrameScriptTranscriptionChannel]);

    useEffect(() => {
        if (settingsPlugin?.manifest.id !== FRAMESCRIPT_VIDEO_ENGINE_ID) return;
        setFrameScriptChannelsLoading(true);
        setFrameScriptChannelsError("");
        setFrameScriptAdminChannels([]);
        let live = true;
        // 普通用户仅使用创作端脱敏目录；完整后台渠道只向管理员回退。
        void (async () => {
            const channels: ModelChannel[] = [];
            try {
                channels.push(...(await refreshSystemChannels()).filter((channel) => channel.scope === "system"));
                // 未定价模型只允许管理员查看，普通用户不能绕过可用性过滤。
                if (!channels.length && user?.role === "admin") {
                    const fallback = await listAdminChannels({ page: 1, pageSize: 100 });
                    channels.push(...(fallback.channels || []));
                }
            } catch (error) {
                if (live) setFrameScriptChannelsError(error instanceof Error ? error.message : "读取可用模型目录失败");
                if (user?.role === "admin") try {
                    const result = await listAdminChannels({ page: 1, pageSize: 100 });
                    channels.push(...(result.channels || []));
                } catch {
                    // 目录读取失败时不使用浏览器旧缓存冒充当前可用渠道。
                }
            }
            if (!live) return;
            setFrameScriptAdminChannels([...new Map(channels.map((channel) => [channel.id, channel])).values()]);
            if (channels.length) {
                setFrameScriptChannelsError("");
            }
            setFrameScriptChannelsLoading(false);
        })();
        return () => { live = false; };
    }, [settingsPlugin?.manifest.id, user?.role, frameScriptChannelsRefresh]);

    useEffect(() => {
        if (settingsPlugin?.manifest.id !== FRAMESCRIPT_VIDEO_ENGINE_ID) return;
        const config = settingsInstallation?.config || {};
        const configuredChannelId = typeof config.channelId === "string" ? config.channelId : "";
        const configuredTranscriptionChannelId = typeof config.transcriptionChannelId === "string" ? config.transcriptionChannelId : "";
        const inferredChannel = resolveFrameScriptSettingsChannel(frameScriptChannels, config);
        const channelModels = inferredChannel?.models.map((model) => modelOptionName(model).trim()).filter(Boolean) || [];
        const transcriptionChannel = frameScriptChannels.find((channel) => channel.id === configuredTranscriptionChannelId) || inferredChannel;
        const transcriptionModels = transcriptionChannel?.models.map((model) => modelOptionName(model).trim()).filter(Boolean) || [];
        const pickModel = (value: unknown, fallback: string) => typeof value === "string" && channelModels.includes(value.trim()) ? value.trim() : channelModels[0] || fallback;
        const pickTranscriptionModel = (value: unknown) => typeof value === "string" && transcriptionModels.includes(value.trim()) ? value.trim() : transcriptionModels[0] || DEFAULT_FRAMESCRIPT_TRANSCRIPTION_MODEL;
        setFrameScriptChannelId(inferredChannel?.id || configuredChannelId);
        setFrameScriptTranscriptionChannelId(configuredTranscriptionChannelId && transcriptionChannel?.id === configuredTranscriptionChannelId ? configuredTranscriptionChannelId : "");
        setFrameScriptVisionModel(inferredChannel ? pickModel(config.visionModel, DEFAULT_FRAMESCRIPT_VISION_MODEL) : "");
        setFrameScriptPromptModel(inferredChannel ? pickModel(config.promptModel, DEFAULT_FRAMESCRIPT_PROMPT_MODEL) : "");
        setFrameScriptTranscriptionModel(transcriptionChannel ? pickTranscriptionModel(config.transcriptionModel) : "");
        setFrameScriptChangeThreshold(typeof config.changeThreshold === "number" ? config.changeThreshold : Number(config.changeThreshold) || 0.32);
        setFrameScriptSamplingIntervalMs(typeof config.samplingIntervalMs === "number" ? config.samplingIntervalMs : Number(config.samplingIntervalMs) || 400);
    }, [frameScriptChannels, settingsInstallation?.config, settingsInstallation?.updatedAt, settingsPlugin?.manifest.id, settingsPluginId]);

    const hasPluginConfiguration = (plugin: RegisteredPlugin) => Boolean(plugin.manifest.configuration?.fields?.length);
    const canConfigurePlugin = (plugin: RegisteredPlugin) => Boolean(pluginStates[plugin.manifest.id]?.canConfigure) && (hasPluginConfiguration(plugin) || plugin.manifest.id === RUNNINGHUB_PLUGIN_ID);

    const isPluginEnabled = (plugin: RegisteredPlugin, installation = installations.find((item) => item.manifest.id === plugin.manifest.id)) => pluginStates[plugin.manifest.id]?.effectiveEnabled ?? Boolean(installation?.enabled);

    const togglePlugin = async (plugin: RegisteredPlugin, enabled: boolean) => {
        try {
            const next = await setUserPluginEnabled(plugin.manifest.id, enabled);
            setEnabled(plugin.manifest.id, enabled);
            setPluginStates({ ...usePluginStore.getState().pluginStates, [next.pluginId]: next });
            if (next.pluginId === RUNNINGHUB_PLUGIN_ID) {
                setRuntimeStatuses({ ...usePluginStore.getState().runtimeStatuses, [next.pluginId]: next.effectiveEnabled ? "enabled" : "disabled" });
            }
            message.success(`${plugin.manifest.name}${enabled ? "已启用" : "已停用"}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新插件状态失败");
        }
    };

    const loadEagleFolders = async (url = eagleBaseUrl) => {
        setEagleFoldersLoading(true);
        setEagleFoldersError("");
        try {
            const result = await getEagleLibrary(url.trim().replace(/\/$/, ""));
            setEagleFolders(result.library.folders || []);
        } catch (reason) {
            setEagleFoldersError(reason instanceof Error ? reason.message : "读取 Eagle 文件夹失败");
            setEagleFolders([]);
        } finally {
            setEagleFoldersLoading(false);
        }
    };

    const saveEagleConfig = () => {
        const baseUrl = eagleBaseUrl.trim().replace(/\/$/, "");
        if (!/^https?:\/\//i.test(baseUrl)) {
            message.error("Eagle 地址必须以 http:// 或 https:// 开头");
            return;
        }
        updateConfig(EAGLE_PLUGIN_ID, { baseUrl, autoUploadGenerated: eagleAutoUploadGenerated, generatedFolderId: eagleGeneratedFolderId });
        message.success("Eagle 插件配置已保存");
    };

    const saveFrameScriptConfig = () => {
        if (!frameScriptChannelId) {
            message.error("请先选择 FrameScript 使用的系统渠道");
            return;
        }
        if (!frameScriptVisionModel || !frameScriptPromptModel || !frameScriptTranscriptionModel) {
            message.error("请为画面分析、提示词和语音转写分别选择模型");
            return;
        }
        updateConfig(FRAMESCRIPT_VIDEO_ENGINE_ID, {
            channelId: frameScriptChannelId,
            transcriptionChannelId: frameScriptTranscriptionChannelId,
            visionModel: frameScriptVisionModel,
            promptModel: frameScriptPromptModel,
            transcriptionModel: frameScriptTranscriptionModel,
            changeThreshold: frameScriptChangeThreshold,
            samplingIntervalMs: frameScriptSamplingIntervalMs,
        });
        message.success("FrameScript 系统渠道与模型已保存");
    };

    return (
        <main className="app-workspace-page plugins-page flex h-full min-h-0 flex-col text-foreground">
            <div ref={scrollContainerRef} className="app-workspace-scroll min-h-0 flex-1 overflow-y-auto">
                <div className="plugins-page-layout">
                    <aside className="plugins-sidebar" aria-label="插件分类">
                        <div className="plugins-sidebar-heading">
                            <PageHeader title="插件中心" description="连接模型、素材与工作流，拓展你的创作工具。" />
                        </div>
                        <nav className="plugins-sidebar-nav">
                            <button type="button" className={`plugins-sidebar-item${categoryFilter === "all" ? " is-active" : ""}`} aria-current={categoryFilter === "all" ? "page" : undefined} onClick={() => selectCategory("all")}>
                                <span className="plugins-sidebar-item-label">
                                    <PlugZap className="size-4" />
                                    全部插件
                                </span>
                                <span>{categoryCounts.all}</span>
                            </button>
                            {protocolSectionMeta.map((section) => {
                                const SectionIcon = section.icon;
                                return (
                                    <button
                                        key={section.key}
                                        type="button"
                                        className={`plugins-sidebar-item${categoryFilter === section.key ? " is-active" : ""}`}
                                        aria-current={categoryFilter === section.key ? "page" : undefined}
                                        onClick={() => selectCategory(section.key)}
                                    >
                                        <span className="plugins-sidebar-item-label">
                                            <SectionIcon className="size-4" />
                                            {section.label}
                                        </span>
                                        <span>{categoryCounts[section.key] || 0}</span>
                                    </button>
                                );
                            })}
                            <button type="button" className={`plugins-sidebar-item${categoryFilter === "other" ? " is-active" : ""}`} aria-current={categoryFilter === "other" ? "page" : undefined} onClick={() => selectCategory("other")}>
                                <span className="plugins-sidebar-item-label">
                                    <PlugZap className="size-4" />
                                    应用插件
                                </span>
                                <span>{categoryCounts.other}</span>
                            </button>
                        </nav>
                    </aside>
                    <div className="plugins-page-content">
                        <CollectionToolbar label="插件筛选" trailing={<div className="plugins-toolbar-actions">
                                <Button icon={<RefreshCw className="size-4" />} loading={backendPluginsLoading} onClick={() => void reloadBackendPlugins()}>
                                    刷新插件
                                </Button>
                                {user?.role === "admin" ? (
                                    <Button type="primary" onClick={() => navigate("/admin/plugins")}>
                                        管理员插件管理
                                    </Button>
                                ) : null}
                            </div>}>
                            <Input
                                className="plugins-search"
                                prefix={<Search className="size-4 text-foreground/38" aria-hidden="true" />}
                                value={search}
                                allowClear
                                placeholder="搜索插件名称、描述或作者"
                                onChange={(event) => setSearch(event.target.value)}
                            />
                            <Select
                                className="plugins-filter"
                                value={statusFilter}
                                options={[
                                    { value: "all", label: "全部状态" },
                                    { value: "enabled", label: "已启用" },
                                    { value: "disabled", label: "已停用" },
                                ]}
                                onChange={(value) => setStatusFilter(value as "all" | "enabled" | "disabled")}
                                aria-label="按状态筛选"
                            />
                            <Select
                                className="plugins-filter"
                                value={trustFilter}
                                options={[
                                    { value: "all", label: "全部来源" },
                                    { value: "trusted", label: "可信插件" },
                                ]}
                                onChange={(value) => setTrustFilter(value as "all" | "trusted")}
                                aria-label="按来源筛选"
                            />
                        </CollectionToolbar>

                        {filteredPlugins.length ? (
                            <div className="plugins-sections">
                                {pluginSections.map((section) => {
                                    const SectionIcon = section.icon;
                                    return (
                                        <section
                                            key={section.key}
                                            id={`plugin-section-${section.key}`}
                                            className="plugin-section"
                                            data-category={section.key === "image" ? "creative" : section.key === "video" ? "drama" : section.key === "audio" ? "social" : section.key === "payment" ? "ecommerce" : undefined}
                                        >
                                            <header className="plugin-section-heading">
                                                <span className="plugin-section-icon">
                                                    <SectionIcon className="size-4" />
                                                </span>
                                                <div>
                                                    <h2>{section.label}</h2>
                                                    <p>{section.description}</p>
                                                </div>
                                                <span className="plugin-section-count">{section.plugins.length}</span>
                                            </header>
                                            {section.plugins.length ? (
                                                <div className="plugins-grid">
                                                    {section.plugins.map((plugin) => {
                                                        const installation = installations.find((item) => item.manifest.id === plugin.manifest.id);
                                                        const remote = backendPluginById.get(plugin.manifest.id);
                                                        const enabled = isPluginEnabled(plugin, installation);
                                                        const trusted = Boolean(plugin.manifest.trusted);
                                                        const state = pluginStates[plugin.manifest.id];
                                                        const sourceLabel = pluginSourceLabel(plugin, state);
                                                        const canConfigure = canConfigurePlugin(plugin);
                                                        return (
                                                            <section key={plugin.manifest.id} className={`product-collection-card plugin-card library-card-surface${trusted ? " is-trusted" : ""}`}>
                                                                <button
                                                                    type="button"
                                                                    className="plugin-card-main"
                                                                    aria-label={`查看${plugin.manifest.name}文档`}
                                                                    onClick={(event) => {
                                                                        const openedByKeyboard = event.detail === 0;
                                                                        setDetailsRestoreFocus(openedByKeyboard);
                                                                        setDetailsPluginId(plugin.manifest.id);
                                                                        if (!openedByKeyboard) event.currentTarget.blur();
                                                                    }}
                                                                >
                                                                    <div className="plugin-card-heading">
                                                                        <span className={`plugin-icon-tile${trusted ? " is-trusted" : ""}`} aria-hidden="true">
                                                                            <SectionIcon className="size-5" />
                                                                        </span>
                                                                        <div className="min-w-0 flex-1">
                                                                            <div className="plugin-card-title-row">
                                                                                <h3>{plugin.manifest.name}</h3>
                                                                                <span className="plugin-version">v{plugin.manifest.version}</span>
                                                                            </div>
                                                                            <div className="plugin-card-labels">
                                                                                <span className={`plugin-source-label${sourceLabel === "系统插件" ? " is-system" : ""}`}>{sourceLabel}</span>
                                                                                {trusted ? (
                                                                                    <span className="plugin-trust-label">
                                                                                        <ShieldCheck className="size-3.5" />
                                                                                        可信插件
                                                                                    </span>
                                                                                ) : null}
                                                                                <span className="plugin-category-label">
                                                                                    {contributionKindsFor(plugin.manifest)
                                                                                        .map((kind) => categoryLabels[kind] ?? kind)
                                                                                        .join(" · ")}
                                                                                </span>
                                                                            </div>
                                                                        </div>
                                                                    </div>

                                                                    <p className="plugin-card-description">{plugin.manifest.description}</p>

                                                                    <div className="plugin-card-meta">
                                                                        <span>
                                                                            <CalendarDays className="size-3.5" />
                                                                            发布 {formatPluginDate(plugin.manifest.publishedAt)}
                                                                        </span>
                                                                        <span>
                                                                            <Clock3 className="size-3.5" />
                                                                            更新 {formatPluginDate(plugin.manifest.updatedAt)}
                                                                        </span>
                                                                    </div>

                                                                    <div className="plugin-card-tags">
                                                                        {(plugin.manifest.surfaces || []).map((surface) => (
                                                                            <span key={surface}>{surfaceLabels[surface] ?? surface}</span>
                                                                        ))}
                                                                        {providerCapabilitiesFor(plugin.manifest).map((capability) => (
                                                                            <span key={capability}>{capabilityLabel(capability)}</span>
                                                                        ))}
                                                                        {plugin.manifest.contributes.providers?.some((provider) => provider.poll) ? <span>异步轮询</span> : null}
                                                                        <span>{plugin.manifest.permissions.length} 项能力</span>
                                                                    </div>
                                                                </button>

                                                                <div className="plugin-card-actions">
                                                                    <span role="status" className={`settings-channel-status ${enabled ? "is-ready" : ""}`}>
                                                                        <i aria-hidden="true" />
                                                                        {!state?.platformAvailable && state?.blockedReason ? state.blockedReason : enabled ? "已启用" : "已停用"}
                                                                    </span>
                                                                    <Switch
                                                                        className="plugin-state-switch"
                                                                        disabled={!state?.canToggle}
                                                                        checked={enabled}
                                                                        aria-label={`${plugin.manifest.name}，当前${enabled ? "已启用，点击停用" : "已停用，点击启用"}`}
                                                                        title={state?.blockedReason}
                                                                        onChange={(checked) => void togglePlugin(plugin, checked)}
                                                                    />
                                                                    {canConfigure ? (
                                                                        <Button
                                                                            className="plugin-settings-button"
                                                                            icon={<Settings2 className="size-4" />}
                                                                            aria-expanded={settingsPluginId === plugin.manifest.id}
                                                                            aria-haspopup="dialog"
                                                                            onClick={() => setSettingsPluginId(plugin.manifest.id)}
                                                                        >
                                                                            设置
                                                                        </Button>
                                                                    ) : null}
                                                                </div>

                                                                {installation?.lastError || remote?.error ? (
                                                                    <Typography.Text type="danger" className="plugin-error" role="alert">
                                                                        {installation?.lastError || remote?.error}
                                                                    </Typography.Text>
                                                                ) : null}
                                                            </section>
                                                        );
                                                    })}
                                                </div>
                                            ) : (
                                                <div className="plugin-section-empty-hint">
                                                    <span>暂无该类型的插件</span>
                                                </div>
                                            )}
                                        </section>
                                    );
                                })}
                            </div>
                        ) : (
                            <EmptyState
                                className="min-h-[260px] rounded-[var(--plugins-card-radius)] bg-foreground/[0.03]"
                                icon={SlidersHorizontal}
                                title="没有匹配的插件"
                                description="试试清空搜索词，或放宽筛选条件。"
                                action={
                                    <Button
                                        onClick={() => {
                                            setSearch("");
                                            setCategoryFilter("all");
                                            setStatusFilter("all");
                                            setTrustFilter("all");
                                        }}
                                    >
                                        清除筛选
                                    </Button>
                                }
                            />
                        )}

                        <Modal
                            className="workspace-modal workspace-modal-wide plugin-settings-modal"
                            title={settingsPlugin ? `${settingsPlugin.manifest.name} 设置` : null}
                            open={Boolean(settingsPlugin)}
                            centered
                            footer={null}
                            destroyOnHidden
                            onCancel={() => setSettingsPluginId(null)}
                            styles={{ body: { maxHeight: "min(72vh, 760px)", overflowY: "auto", overscrollBehavior: "contain" } }}
                        >
                            {settingsPlugin ? (
                                <div className="plugin-settings-panel plugin-settings-modal-panel">
                                    <div className="plugin-settings-heading">
                                        <div>
                                            <p>只展示这个插件实际支持的配置项。</p>
                                        </div>
                                        {settingsPlugin.manifest.trusted ? (
                                            <span className="plugin-trust-label">
                                                <ShieldCheck className="size-3.5" />
                                                可信插件
                                            </span>
                                        ) : (
                                            <span className="plugin-category-label">第三方插件</span>
                                        )}
                                    </div>

                                    {settingsPlugin.manifest.id === EAGLE_PLUGIN_ID ? (
                                        <>
                                            <div className="plugin-settings-fields">
                                                <div className="min-w-0">
                                                    <label htmlFor="eagle-base-url">Eagle 本地 API 地址</label>
                                                    <Input id="eagle-base-url" aria-label="Eagle 本地 API 地址" value={eagleBaseUrl} onChange={(event) => setEagleBaseUrl(event.target.value)} placeholder="http://localhost:41595" />
                                                    <p>Eagle 必须在本机运行；{brandName}通过插件直接读取和写入 Eagle 原始文件。</p>
                                                </div>
                                                <div className="min-w-0">
                                                    <div className="plugin-setting-label-row">
                                                        <label htmlFor="eagle-auto-upload-generated">自动归档生成结果</label>
                                                        <Switch id="eagle-auto-upload-generated" checked={eagleAutoUploadGenerated} onChange={setEagleAutoUploadGenerated} aria-label="自动归档生成结果到 Eagle" />
                                                    </div>
                                                    <p>图片、视频和音频生成成功后，自动写入 Eagle；{brandName}本地素材仍会保留。</p>
                                                </div>
                                                <div className="min-w-0">
                                                    <div className="plugin-setting-label-row">
                                                        <label htmlFor="eagle-generated-folder">生成结果写入文件夹</label>
                                                        <Button type="link" size="small" loading={eagleFoldersLoading} onClick={() => void loadEagleFolders()}>
                                                            读取文件夹
                                                        </Button>
                                                    </div>
                                                    <Select
                                                        id="eagle-generated-folder"
                                                        aria-label="生成结果写入文件夹"
                                                        showSearch
                                                        allowClear
                                                        value={eagleGeneratedFolderId || undefined}
                                                        placeholder="Eagle 根目录"
                                                        optionFilterProp="label"
                                                        options={[{ value: "__root__", label: "Eagle 根目录" }, ...eagleFolderOptions(eagleFolders)]}
                                                        onChange={(value) => setEagleGeneratedFolderId(value === "__root__" || !value ? "" : value)}
                                                    />
                                                    <p>{eagleFoldersError || "默认写入 Eagle 根目录；选择文件夹后按 Eagle 原始目录归档。"}</p>
                                                </div>
                                            </div>
                                            <div className="plugin-settings-actions">
                                                <Button type="primary" icon={<CheckCircle2 className="size-4" />} onClick={saveEagleConfig}>
                                                    保存配置
                                                </Button>
                                                <Button icon={<FolderOpen className="size-4" />} disabled={!settingsEnabled} onClick={() => navigate("/plugins/eagle")}>
                                                    打开 Eagle 素材库
                                                </Button>
                                                <Button icon={<ExternalLink className="size-4" />} href="https://api.eagle.cool/" target="_blank">
                                                    查看 API
                                                </Button>
                                            </div>
                                        </>
                                    ) : settingsPlugin.manifest.id === FRAMESCRIPT_VIDEO_ENGINE_ID ? (
                                        <>
                                            <div className="plugin-settings-fields">
                                                <div className="min-w-0">
                                                    <label htmlFor="framescript-channel">关联系统渠道</label>
                                                    {frameScriptChannelsError ? <p role="alert">{frameScriptChannelsError}</p> : null}
                                                    {!frameScriptChannelsLoading && !frameScriptChannels.length ? <p role="status">没有可用的系统渠道或模型，请联系管理员核对模型是否启用及定价配置。</p> : null}
                                                    <Button size="small" type="link" loading={frameScriptChannelsLoading} onClick={() => setFrameScriptChannelsRefresh((value) => value + 1)}>重新读取模型目录</Button>
                                                    <Select
                                                        id="framescript-channel"
                                                        aria-label="FrameScript 关联系统渠道"
                                                        className="w-full"
                                                        getPopupContainer={getPluginSettingsPopupContainer}
                                                        popupClassName="plugin-settings-select-popup"
                                                        loading={frameScriptChannelsLoading}
                                                        value={frameScriptChannelId || undefined}
                                                        placeholder="选择已启用的系统渠道"
                                                        options={frameScriptChannels.map((channel) => ({ value: channel.id, label: channel.name || channel.id }))}
                                                        onChange={(channelId) => {
                                                            const channel = frameScriptChannels.find((item) => item.id === channelId);
                                                            const models = channel?.models.map((model) => modelOptionName(model).trim()).filter(Boolean) || [];
                                                            const transcriptionFollowsMain = !frameScriptTranscriptionChannelId || frameScriptTranscriptionChannelId === frameScriptChannelId;
                                                            setFrameScriptChannelId(channelId);
                                                            setFrameScriptVisionModel(models.includes(frameScriptVisionModel) ? frameScriptVisionModel : models[0] || "");
                                                            setFrameScriptPromptModel(models.includes(frameScriptPromptModel) ? frameScriptPromptModel : models[0] || "");
                                                            if (transcriptionFollowsMain) {
                                                                setFrameScriptTranscriptionChannelId("");
                                                                setFrameScriptTranscriptionModel(models.includes(frameScriptTranscriptionModel) ? frameScriptTranscriptionModel : models[0] || "");
                                                            }
                                                        }}
                                                    />
                                                    <p>画面分析与提示词请求经此渠道执行；密钥继续只保存在系统渠道中。</p>
                                                </div>
                                                <div className="min-w-0">
                                                    <label htmlFor="framescript-vision-model">画面分析模型</label>
                                                    <Select id="framescript-vision-model" aria-label="FrameScript 画面分析模型" className="w-full" getPopupContainer={getPluginSettingsPopupContainer} popupClassName="plugin-settings-select-popup" value={frameScriptVisionModel || undefined} placeholder="选择视觉模型" notFoundContent="所选渠道没有可用模型，请先选择系统渠道或重新读取目录" options={frameScriptModelOptions} onChange={setFrameScriptVisionModel} />
                                                </div>
                                                <div className="min-w-0">
                                                    <label htmlFor="framescript-prompt-model">图片提示词模型</label>
                                                    <Select id="framescript-prompt-model" aria-label="FrameScript 图片提示词模型" className="w-full" getPopupContainer={getPluginSettingsPopupContainer} popupClassName="plugin-settings-select-popup" value={frameScriptPromptModel || undefined} placeholder="选择文本或视觉模型" notFoundContent="所选渠道没有可用模型，请先选择系统渠道或重新读取目录" options={frameScriptModelOptions} onChange={setFrameScriptPromptModel} />
                                                </div>
                                                <div className="min-w-0">
                                                    <label htmlFor="framescript-transcription-channel">转写系统渠道（可选）</label>
                                                    <Select
                                                        id="framescript-transcription-channel"
                                                        aria-label="FrameScript 转写系统渠道"
                                                        className="w-full"
                                                        getPopupContainer={getPluginSettingsPopupContainer}
                                                        popupClassName="plugin-settings-select-popup"
                                                        allowClear
                                                        value={frameScriptTranscriptionChannelId || undefined}
                                                        placeholder="默认沿用关联系统渠道"
                                                        options={frameScriptChannels.map((channel) => ({ value: channel.id, label: channel.name || channel.id }))}
                                                        onChange={(channelId) => {
                                                            const selectedId = typeof channelId === "string" ? channelId : "";
                                                            const channel = frameScriptChannels.find((item) => item.id === (selectedId || frameScriptChannelId));
                                                            const models = channel?.models.map((model) => modelOptionName(model).trim()).filter(Boolean) || [];
                                                            setFrameScriptTranscriptionChannelId(selectedId);
                                                            setFrameScriptTranscriptionModel(models.includes(frameScriptTranscriptionModel) ? frameScriptTranscriptionModel : models[0] || "");
                                                        }}
                                                    />
                                                    <p>可单独选择支持 OpenAI 兼容 <code>/audio/transcriptions</code> 的系统渠道；留空时沿用上方渠道。</p>
                                                </div>
                                                <div className="min-w-0">
                                                    <label htmlFor="framescript-transcription-model">语音转写模型</label>
                                                    <Select id="framescript-transcription-model" aria-label="FrameScript 语音转写模型" className="w-full" getPopupContainer={getPluginSettingsPopupContainer} popupClassName="plugin-settings-select-popup" value={frameScriptTranscriptionModel || undefined} placeholder="选择支持转写的模型" options={frameScriptTranscriptionModelOptions} onChange={setFrameScriptTranscriptionModel} />
                                                </div>
                                                <div className="min-w-0">
                                                    <label htmlFor="framescript-threshold">候选帧变化阈值</label>
                                                    <Input id="framescript-threshold" aria-label="候选帧变化阈值" type="number" min="0.01" max="1" step="0.01" value={frameScriptChangeThreshold} onChange={(event) => setFrameScriptChangeThreshold(Math.min(1, Math.max(0.01, Number(event.target.value) || 0.32)))} />
                                                </div>
                                                <div className="min-w-0">
                                                    <label htmlFor="framescript-interval">扫描间隔（毫秒）</label>
                                                    <Input id="framescript-interval" aria-label="扫描间隔（毫秒）" type="number" min="100" max="2000" step="50" value={frameScriptSamplingIntervalMs} onChange={(event) => setFrameScriptSamplingIntervalMs(Math.min(2000, Math.max(100, Number(event.target.value) || 400)))} />
                                                </div>
                                            </div>
                                            <div className="plugin-settings-actions">
                                                <Button type="primary" icon={<CheckCircle2 className="size-4" />} onClick={saveFrameScriptConfig}>
                                                    保存 FrameScript 配置
                                                </Button>
                                            </div>
                                        </>
                                    ) : settingsPlugin.manifest.id === PROMPT_OPTIMIZER_PLUGIN_ID ? (
                                        <div className="rounded-[var(--r-md)] border border-border/60 bg-muted/25 px-3 py-3 text-[var(--fs-body)] leading-6 text-foreground/70">
                                            <p>在创作页或图片、视频节点的提示词编辑器中使用“优化”按钮，即可让当前文本模型整理提示词。</p>
                                            <p className="mt-2 text-[var(--fs-micro)] text-foreground/50">插件不会自动覆盖原提示词，只有点击“采用”后才会回填到当前输入框。</p>
                                        </div>
                                    ) : settingsPlugin.manifest.id === RUNNINGHUB_PLUGIN_ID ? (
                                        <div className="plugin-settings-empty">
                                            <p>RunningHub 的 API Key、Workflow / App 和字段映射在宿主设置页维护。</p>
                                            <Button
                                                type="primary"
                                                icon={<ExternalLink className="size-4" />}
                                                onClick={() => {
                                                    setSettingsPluginId(null);
                                                    navigate("/settings?section=runninghub");
                                                }}
                                            >
                                                打开工作流设置
                                            </Button>
                                        </div>
                                    ) : (
                                        <div className="plugin-settings-empty">
                                            {`贡献能力：${
                                                contributionKindsFor(settingsPlugin.manifest)
                                                    .map((kind) => categoryLabels[kind] || kind)
                                                    .join("、") || "未声明"
                                            }。当前接入位置和权限会根据插件清单自动生效。`}
                                        </div>
                                    )}

                                    <div className="plugin-permissions">
                                        <div>
                                            <span>接入位置</span>
                                            {(settingsPlugin.manifest.surfaces || []).map((surface) => surfaceLabels[surface] ?? surface).join("、") || "由贡献点决定"}
                                        </div>
                                        <div>
                                            <span>插件能力</span>
                                            {settingsPlugin.manifest.permissions.map((permission) => permissionLabels[permission] ?? permission).join("、")}
                                        </div>
                                    </div>
                                </div>
                            ) : null}
                        </Modal>
                        <PluginDetailsModal plugin={detailsPlugin} restoreFocus={detailsRestoreFocus} onClose={() => setDetailsPluginId(null)} />
                    </div>
                </div>
            </div>
        </main>
    );
}

function formatPluginDate(value?: string) {
    if (!value) return "未记录";
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? pluginDateFormatter.format(timestamp) : "未记录";
}

function toRegisteredPlugin(plugin: BackendPlugin): RegisteredPlugin {
    return { manifest: plugin.manifest, source: plugin.source };
}

function pluginSourceLabel(plugin: RegisteredPlugin, state?: PluginState) {
    if (plugin.source === "uploaded") return "自定义插件";
    if (plugin.source === "system") return "系统插件";
    if (state?.canToggle || isOfficialApplicationPluginId(plugin.manifest.id)) return "官方插件";
    return "系统插件";
}

function contributionKindsFor(manifest: PluginManifest | PluginManifestV2): string[] {
    const contributions = manifest.contributes;
    const kinds: string[] = [];
    if (contributions.providers?.length) kinds.push("provider");
    if (contributions.paymentProviders?.length) kinds.push("payment-provider");
    if (contributions.workflows?.length) kinds.push("workflow");
    if (contributions.canvasNodes?.length) kinds.push("canvas-node");
    if (contributions.transforms?.length) kinds.push("transform");
    if (contributions.assetSources?.length) kinds.push("asset-source");
    if (contributions.aiCapabilities?.length) kinds.push("ai-capability");
    if (contributions.usageObservers?.length) kinds.push("usage-observer");
    if (contributions.agents?.length) kinds.push("agent");
    if (contributions.importExport?.length) kinds.push("import-export");
    return kinds;
}

function providerCapabilitiesFor(manifest: PluginManifest | PluginManifestV2) {
    return [...new Set((manifest.contributes.providers || []).flatMap((provider) => provider.capabilities))];
}

function pluginMatchesCategory(manifest: PluginManifest | PluginManifestV2, category: string) {
    const providerCapabilities = providerCapabilitiesFor(manifest);
    const isPaymentProtocol = Boolean(manifest.contributes.paymentProviders?.length);
    if (category === "payment") return isPaymentProtocol;
    if (category === "other") return !isPaymentProtocol && providerCapabilities.length === 0;
    return providerCapabilities.includes(category as "text" | "image" | "video" | "audio");
}

function capabilityLabel(value: string) {
    return ({ text: "文本", image: "图片", video: "视频", audio: "音频" } as Record<string, string>)[value] || value;
}

function eagleFolderOptions(folders: EagleFolder[]) {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const pathFor = (folder: EagleFolder) => {
        const path: string[] = [];
        const seen = new Set<string>();
        let current: EagleFolder | undefined = folder;
        while (current && !seen.has(current.id)) {
            seen.add(current.id);
            path.unshift(current.name);
            current = current.parentId ? byId.get(current.parentId) : undefined;
        }
        return path.join(" / ");
    };
    return folders.map((folder) => ({ value: folder.id, label: pathFor(folder) })).sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
}
