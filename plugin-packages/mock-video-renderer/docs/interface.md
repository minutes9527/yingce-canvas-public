# Mock Video Renderer 接口

Mock Renderer 接收通用 `Video IR`，生成模拟 `RenderProject` 并返回 `queued` 状态的模拟任务回执。响应仅包含模拟 jobId 与 `simulated: true`。它用于验证 Registry、权限和渲染调用链，不会产生真实视频文件。

<!-- YINGCE_MANIFEST_CONTRACT_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "yingce.plugin/v2",
  "id": "mock-video-renderer",
  "name": "Mock Video Renderer",
  "version": "0.1.0",
  "description": "用于验证 Video IR 到渲染任务合同的测试渲染器，不生成真实视频。",
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>",
  "permissions": [
    "media.read",
    "generation.run"
  ],
  "contributes": {
    "videoPlugins": [
      {
        "id": "mock-video-renderer",
        "label": "Mock Video Renderer",
        "type": "video",
        "stage": "ready",
        "capabilities": [
          "compile",
          "render"
        ]
      }
    ]
  }
}
```
<!-- YINGCE_MANIFEST_CONTRACT_END -->
