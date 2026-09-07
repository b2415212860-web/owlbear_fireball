# 1.2.2 场景就绪时序修复

日期：2026-09-06。范围：本地源码、生产构建和预览服务；未推送 GitHub、未部署公网。

## 原因与修复

用户提供的原始异常为 `{ error: { name: "MissingDataError", message: "No scene found" } }`，出现在“创建右上角按钮”步骤。该步骤先调用 `OBR.viewport.getWidth()`，但旧代码直到按钮创建完毕后才检查场景是否就绪。`OBR.onReady` 只说明 SDK 已连接，不能作为存在可交互场景的条件。

现在先订阅场景变化，并通过 `OBR.scene.isReady()` 确认场景可用，再注册瞄准工具、读取视口和打开按钮。无场景时只提示等待，保留监听；GM 打开场景后自动继续，不需要靠反复启用扩展恢复。

场景关闭或切换时立即使旧请求失效、清理施法状态并关闭按钮。按钮打开/关闭串行执行，每次异步返回都检查场景请求代次，防止迟到的旧场景按钮覆盖或关闭新按钮。无场景时不再周期读取视口。若场景在就绪检查后、后续 SDK 调用前消失，识别特定的 `No scene found` 错误并回到等待，而不是销毁整个控制器；其他错误仍会显示，不被一概吞掉。

错误处理支持 SDK 的嵌套 `error` 和 `cause`，有层数和循环保护，解决提示显示 `[object Object]` 的问题。没有修改 Three.js 视觉或提高渲染预算。

官方接口依据：[Scene 的 isReady / onReadyChange](https://docs.owlbear.rodeo/extensions/apis/scene/)、[Viewport 属于当前场景](https://docs.owlbear.rodeo/extensions/apis/viewport/)。

## 验证

- TypeScript 检查通过；126 项单元/模拟回归通过。
- 新增场景为空时启动、就绪后自动挂载、关闭后停止视口读取、同宽度重新打开、就绪与后续请求间发生 No scene found、迟到视口响应、跨场景按钮打开清理的回归。
- 嵌套 SDK 错误识别、包装 cause、循环对象均有测试。
- 子路径生产构建及 6 项部署资源测试通过，总计 132 项测试通过。本地预览已重新启动，manifest 返回 200、版本 1.2.2，背景入口和控制器资源均返回 200，响应包含 Owlbear CORS 允许头。这些结果不等同于真实 Owlbear 房间验证。

使用同一本地 manifest 链接，强制刷新 Owlbear 房间后只启用本地火球版本，并打开或创建一个场景。需要看到按钮出现，再验证完整施法。旧 1.2.0 zip 不包含本次补丁；当前构建位于项目 dist。
