# Owlbear Rodeo 火球术扩展

在 Owlbear Rodeo 场景右上角显示一个常驻的“火球术”悬浮按钮。点击按钮后进入透明瞄准层，半径 20 英尺的圆形范围会跟随鼠标；再次点击地图即可释放火球，并为房间内所有已启用本扩展的玩家播放飞行与爆炸特效。

## 使用方式

需要 Node.js 22.6 或更新版本。

1. 运行 `npm install` 和 `npm run dev`。
2. 在 Owlbear Rodeo 的扩展管理页面添加：`http://localhost:5173/fireball/manifest.json`。
3. 创建或进入房间时启用本扩展。
4. 选中一个棋子作为火球的发射起点；若没有选中棋子，会使用当前视口中心。
5. 点击右上角“火球术”，移动 20 英尺范围圈，再点击地图释放。按 `Esc` 或右上角按钮可取消。

独立网页演示地址为 `http://localhost:5173/fireball/`。网页演示使用 Three.js；在 Owlbear 中仍使用场景 Effect 特效，两者不会因部署而自动变成同一套渲染实现。

## 构建与部署

```bash
npm run test
npm run test:deployment
```

`test:deployment` 会先构建，再检查 manifest、三个入口页面、按钮/瞄准地址和资源依赖的子路径。只需构建时运行 `npm run build`。

本项目部署在域名的 `/fireball/` 路径下，安装地址为 `https://你的域名/fireball/manifest.json`。例如：`https://longtrail.cloud/fireball/manifest.json`。项目不占用主域名首页，资源和扩展页面也都使用 `/fireball/` 前缀。

将构建生成的整个 `dist/` 目录上传到服务器项目目录，例如 `/opt/owlbear_fireball/dist/`。服务器只需托管构建文件，不需要运行 Node.js，也不要公开 `src/`、`.git/` 或 `node_modules/`。

在负责主域名请求的现有 Nginx `server` 块内新增以下规则，保留原网站的 `location /`：

```nginx
location = /fireball {
    absolute_redirect off;
    return 301 /fireball/;
}

location ^~ /fireball/ {
    alias /opt/owlbear_fireball/dist/;
    index index.html;
    autoindex off;
    absolute_redirect off;
}
```

`alias` 是 Nginx 进程实际可见的目录。如果 Nginx 运行在 Docker 中，需要将宿主机的构建目录只读挂载到容器内对应位置。若主域名由 CDN 提供 HTTPS 并通过 HTTP 回源，应把规则加入实际接收回源请求的 `server`，不必另外新建同域名的 HTTPS 站点。

Nginx 需要有文件读取权限和正确的 MIME 类型配置；CentOS 开启 SELinux 时还需正确的文件标签。`/fireball/` 页面应允许 Owlbear 嵌入，不要继承主站禁止嵌入的响应头。更新部署后如仍出现旧内容，请刷新 CDN 中 `/fireball/` 下的缓存。

生产构建的本地预览：运行 `npm run preview`，然后访问 `http://localhost:4173/fireball/`。

## 范围换算

扩展读取场景的网格 DPI、每格距离和单位。英尺、英寸、码、英里、米、厘米和千米场景都会换算为真实的 20 英尺半径；未知单位会按英尺处理。

特效通过 Owlbear Rodeo 广播事件同步，实际画面使用每位玩家本地的临时 Effect 项目渲染，不会在场景中留下永久项目。
