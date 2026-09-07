# 火球术扩展 1.2.4 部署包

仅包含 Owlbear 使用的静态构建，不包含演示版、源码或 node_modules；服务器不需要运行 Node.js。

## 本次更新

保留 1.2.3 的瞄准工具激活修复，将整个悬浮 UI 向左移动 100 CSS 像素：右侧边距 118 像素、顶部边距 18 像素。调整窗口大小或重新打开场景后仍保持偏移。未更改火球视觉或性能预算。

## 更新现有服务器

1. 先备份服务器原有 `/opt/owlbear_fireball/dist/`。
2. 解压部署包，把包内 `dist/` 的内容上传到服务器 `/opt/owlbear_fireball/dist/`。最终路径必须是 `/opt/owlbear_fireball/dist/manifest.json`，不要多套一层 `dist`。
3. 优先上传 `dist/assets/`，再更新 HTML、图标和 manifest。保留旧哈希资源，避免仍打开的旧页面加载失败。保持原有宿主机 dist 目录，在其中更新文件，不要整体改名替换已绑定给 Docker 的目录。
4. 保持现有 Docker Nginx 的绝对路径只读挂载：`/opt/owlbear_fireball/dist:/opt/owlbear_fireball/dist:ro`，以及 `/fireball/` 到该目录的 Nginx 映射。只更新静态文件、挂载和配置都不变时，不需要重建镜像或重启容器。
5. 若使用 CDN，清除 `/fireball/` 下的缓存，包含 manifest、HTML 和资源。公网访问安装链接，确认返回 JSON 且 version 为 `1.2.4`；若仍是旧版本，先排查缓存和容器内文件。
6. 在 Owlbear 中先点“恢复”清理旧状态，再强制刷新房间或重新启用扩展。房间中的其他玩家也应刷新到同一版本。

安装地址不变：

```text
https://www.longtrail.cloud/fireball/manifest.json
```

## 使用与验证边界

打开场景，选中单个角色棋子 → 点击火球术 → 移动鼠标瞄准 → 单击地图释放。Esc 可取消。悬浮 UI 应比 1.2.3 向左移动 100 像素，高度不变。

自动化测试与构建检查不等于真实 Owlbear 房间验收；仍需在实际房间确认移动、释放、多人显示及设备性能。本包未自动上传服务器，也未推送 GitHub。
