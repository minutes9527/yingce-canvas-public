import { getRegisteredPlugin, listRegisteredPlugins } from "@/lib/plugins/plugin-registry";
import type { PluginHostContext, RegisteredPlugin } from "@/lib/plugins/plugin-types";
import { VIDEO_ANALYSIS_OPERATIONS, VIDEO_PLUGIN_PERMISSIONS, VideoPluginError, type RenderProject, type VideoCapability, type VideoInput, type VideoPluginOptions } from "@/lib/plugins/video-plugin";
import type { VideoIR } from "@/lib/video-engine/video-ir";

export type VideoProvider = { pluginId: string; contributionId: string };
export type VideoPluginAccess = { enabled: boolean; context: PluginHostContext };

/**
 * The sole execution path for video plugins. It uses the existing registry and
 * rechecks installation and permissions per operation instead of caching grants.
 */
export class VideoPipeline {
    constructor(private readonly resolveAccess: (plugin: RegisteredPlugin) => VideoPluginAccess | undefined) {}

    listProviders(capability?: VideoCapability) {
        return listRegisteredPlugins().flatMap((plugin) => (plugin.manifest.contributes.videoPlugins ?? [])
            .filter((item) => !capability || item.capabilities.includes(capability))
            .map((item) => ({ pluginId: plugin.manifest.id, contributionId: item.id, name: item.label, type: item.type, capabilities: item.capabilities, stage: item.stage })));
    }

    async analyze(provider: VideoProvider, input: VideoInput, options?: VideoPluginOptions) {
        if (!input.operations.length || input.operations.some((operation) => !VIDEO_ANALYSIS_OPERATIONS.includes(operation))) {
            throw new VideoPluginError("invalid-input", "分析操作无效");
        }
        if (!input.media || !["asset", "resource"].includes(input.media.kind) || !/^[\w-]{1,200}$/.test(input.media.id)) {
            throw new VideoPluginError("invalid-input", "分析需要有效的已保存素材");
        }
        const plugin = this.resolve(provider, input.operations[0], options);
        if (!plugin.analyze || input.operations.some((operation) => !plugin.capabilities.includes(operation))) {
            throw new VideoPluginError("runtime-unavailable", "该插件未绑定所需分析入口");
        }
        const result = await plugin.analyze(input, options);
        options?.signal?.throwIfAborted();
        if (result.pluginId !== provider.contributionId) throw new VideoPluginError("engine-mismatch", "分析结果与所选插件不匹配");
        return result;
    }

    async compile(provider: VideoProvider, videoIR: VideoIR, options?: VideoPluginOptions) {
        const plugin = this.resolve(provider, "compile", options);
        if (!plugin.compile) throw new VideoPluginError("runtime-unavailable", "该插件未绑定编译入口");
        const project = await plugin.compile(videoIR, options);
        if (project.engineId !== provider.contributionId) throw new VideoPluginError("engine-mismatch", "编译产物与所选引擎不匹配");
        return project;
    }

    async render(provider: VideoProvider, project: RenderProject, options?: VideoPluginOptions) {
        if (project.engineId !== provider.contributionId) throw new VideoPluginError("engine-mismatch", "编译产物与所选引擎不匹配");
        const plugin = this.resolve(provider, "render", options);
        if (!plugin.render) throw new VideoPluginError("runtime-unavailable", "该插件未绑定渲染入口");
        return plugin.render(project, options);
    }

    private resolve(provider: VideoProvider, capability: VideoCapability, options?: VideoPluginOptions) {
        options?.signal?.throwIfAborted();
        const registered = getRegisteredPlugin(provider.pluginId);
        const contribution = registered?.manifest.contributes.videoPlugins?.find((item) => item.id === provider.contributionId);
        if (!registered || !contribution) throw new VideoPluginError("not-registered", "视频插件未注册");
        if (!contribution.capabilities.includes(capability)) throw new VideoPluginError("type-mismatch", "视频插件未声明此能力（预留能力不可执行）");
        const access = this.resolveAccess(registered);
        if (!access?.enabled) throw new VideoPluginError("disabled", "视频插件未启用");
        if (access.context.manifest.id !== registered.manifest.id || !VIDEO_PLUGIN_PERMISSIONS[capability].every((permission) =>
            (registered.manifest.permissions as readonly string[]).includes(permission) && access.context.permissions.has(permission))) {
            throw new VideoPluginError("permission-denied", "视频插件缺少操作所需权限");
        }
        if (!registered.createVideoPlugin) throw new VideoPluginError("runtime-unavailable", "视频插件尚未绑定执行入口");
        const instance = registered.createVideoPlugin(access.context, provider.contributionId);
        if (instance.id !== provider.contributionId || instance.type !== "video" ||
            instance.capabilities.length !== contribution.capabilities.length ||
            !instance.capabilities.every((item) => contribution.capabilities.includes(item))) {
            throw new VideoPluginError("engine-mismatch", "视频插件执行入口与声明不匹配");
        }
        const availability = instance.getAvailability();
        if (!availability.available) throw new VideoPluginError("runtime-unavailable", availability.reason);
        return instance;
    }
}
