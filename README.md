# Owlbear Rodeo 火球术扩展 · 1.4.0

右上角悬浮按钮 → 选取半径 20 英尺的范围 → 圆形炽热火球带连续尾焰飞行 → 猛烈爆裂与冲击波 → 俯瞰体积蘑菇云升起、翻卷、冷却消散 → 可选生成残留 Props → 恢复施法。只构建 Owlbear 所需版本，不附带网页演示入口；不处理伤害、豁免、法术位或地形规则。

**当前是待真实房间验收的候选版。** 已验证实际 Three.js 着色器和自动回归，但这不能证明 Owlbear 的透明模态层不影响地图快捷键、其他扩展或不同设备的帧率。请查阅 [1.2.0 实施记录](docs/release-1.2.0.md)，部署后在测试房间验收。

1.2.2 修复场景未就绪时提前读取视口导致的 `No scene found` 初始化失败：无场景时保持等待，场景就绪后才注册工具和创建右上角按钮；场景关闭时隐藏按钮，再次打开会自动恢复。SDK 连接就绪并不代表场景就绪。详见 [1.2.2 修复记录](docs/release-1.2.2.md)，上一轮见 [1.2.1 诊断记录](docs/release-1.2.1.md)。修复已通过模拟回归，仍需用户在实际房间重载验证。

1.2.3 修正瞄准激活流程：先显式激活火球工具，再激活其瞄准模式，回读确认成功后才显示圆圈；完成或取消也显式恢复原工具。此前只设置模式且测试混淆了工具/模式两种状态，可能出现圆圈在棋子处停住、无法接收地图事件。详见 [1.2.3 修复记录](docs/release-1.2.3.md)。

## 使用

1.2.4 将整个悬浮 UI 向左移动 100 CSS 像素：右侧边距从 18 改为 118 像素，顶部仍为 18 像素；窗口尺寸变化、场景重新打开后保持该位置。火球特效和施法逻辑不变。

1. 在房间中启用扩展，由 GM 首次打开场景，为当前场景初始化同步标识。尚无场景或场景仍在加载时，扩展提示等待，不显示火球按钮；就绪后自动出现。
2. 选中一个角色层的图像棋子作为施法起点。未选择、选择多个、选择地图或已删除的棋子会提示错误，不再偷偷使用视口中心。
3. 点击右上角“火球术”，移动鼠标定位 20 英尺圆形范围，再点击地图释放。
4. 瞄准时按 Esc、再次点击按钮或切换地图工具可取消。
5. 播放期间本地施法锁定；结束后可再次施法。“恢复”会清理本客户端当前特效和瞄准状态。

画质菜单有自动、标准、低配。WebGL 初始化失败自动采用 Canvas 2D 后备。每位玩家独立选择画质；双方均须启用同版扩展才能看到多人广播。刚进入房间不会重播历史施法，网络延迟可能造成开始时间不同。

## 轻量渲染方式

### 1.4.0 · GM 发布、全房间共用残留素材

残留素材现在采用“房间同步 + 浏览器缓存”的混合模式：只有 GM 能在悬浮面板中选择或关闭残留素材。GM 选择的 Props 图片或动画会以小型配置写入 Owlbear 房间元数据；每个客户端监听配置变化，立即覆盖自己的当前模板并写入本地浏览器缓存。刷新或重新进入时先读取本地缓存，再由房间中的最新配置校正。

- 房间尚无该配置时，各浏览器保留原先按房间保存的本地模板，兼容 1.3.x；一旦 GM 发布，所有已启用 1.4.0 的客户端改用同一模板。
- GM 明确点击“关闭”会向房间写入关闭状态，并同步清空各客户端的本地模板；不会删除地图上已经生成的 Props。
- 玩家不能打开素材选择器或修改房间模板，但可以读取并使用 GM 分享的图片 URL、尺寸、DPI、缩放和旋转。图片二进制不会写入元数据。
- 玩家施法后仍由该玩家的客户端在命中点创建共享 `PROP`，所以 GM 必须在 Owlbear 房间权限中允许玩家创建 Props（`PROP_CREATE`）。没有权限时火球动画照常结束，但残留创建失败并显示提示。
- 配置失效或不合法时不会覆盖该浏览器已有的有效缓存；GM 的房间写入失败也不会提前改变任何客户端。
- 素材同步只发生在选择、关闭和房间元数据变化时，不增加动画逐帧通信或 Three.js 渲染负担。

详细行为与验收边界见 [1.4.0 记录](docs/release-1.4.0.md)。

### 1.3.1 爆炸节奏与体积层次

圆形火球命中后，原有尾焰继续耗散 0.32 秒；短促核心闪光、快速撕裂的火焰团、稍后抵达的断续尘浪分层发生。俯瞰蘑菇云的烟团大小、高度和翻卷速度不再均匀，内部热区透过烟隙显露，末期先局部侵蚀再淡出。粒子分为短命高速火星与较重的冷却余烬，不再全部持续发光。

采用现有施法消息的 seed 驱动形态变化，同一次施法在各端使用相同形态参数（不同画质和启动时间仍可能有视觉差异）。不增加网络消息、不扩大选区，也不增加粒子和体积采样上限。没有全屏后处理、声音或地图震动；保留 1.3.0 残留素材逻辑。详见 [1.3.1 修改与验收记录](docs/release-1.3.1.md)。

### 1.3.0 残留素材

这是 1.3.0 的历史行为：在场景就绪、未施法时，每个客户端可分别选择 Fire Sphere 或其他 Props 图片/动画。1.4.0 已由上面的 GM 房间共享模式取代。

- 1.3.0 只在同一浏览器、同一扩展地址、同一房间记住选择，不会自动同步；升级 1.4.0 后，旧选择会作为本地缓存保留，直到 GM 发布或关闭房间配置。
- 正常收到开始、命中、播放结束事件后，由施法客户端在命中点创建一次共享 `PROP`。远端观看者不创建；取消、错误、超时、场景切换或关闭页面不会补播残留。
- 使用素材默认尺寸和旋转，以图片矩形中心对准命中点，不强制放大成 20 英尺半径。透明素材自身留白可能使可见火焰看起来偏移。新增对象可按 Owlbear 原生方式移动、缩放和手动删除（需要相应权限）。
- “关闭”只停用后续残留，不删除已经生成的对象；“恢复”也不会清除已生成的持久道具。当前不提供定时消失功能。
- 创建者必须是 GM，或拥有 `PROP_CREATE` 权限的玩家；权限不足或 SDK 写入失败会提示，动画不重放。没有 GM 代创建机制。
- 浏览器禁止存储时，当前会话仍能使用，界面会提示刷新后重新选择。失效或过期的素材链接需要重新选择；不同客户端实际加载素材仍受链接可访问性影响。
- 新功能只在配置和生成时调用 SDK，不新增每帧通信。循环动画素材会持续占用渲染资源，多次施法后请手动清理不再需要的残留。

实现与验证边界见 [1.3.0 记录](docs/release-1.3.0.md)。

### 动画预算

Owlbear 的可见特效页使用 `performance-fx.ts`，不再每帧更新 SDK Effect。历史演示源码不再进入生产包。

- 圆形 3D 球体使用三维湍流火焰纹理；尾焰是 GPU 合批的柔软翻卷火焰，球头不被拉成长条。
- 命中有高速膨胀、破碎的火焰团，随后推出独立的压力/尘埃冲击波。
- 蘑菇云采用局部体积光线步进：升腾烟柱、展开翻卷的云帽、内部火光及冷却。32 KiB 三维噪声纹理、标准 20 步 / 低配 10 步；不是完整流体物理求解，也不是全屏体积后处理。
- 标准：320 火星、32 段尾焰，最大 1280×720；低配：120、16，最大 960×540。放大地图时进一步限制特效内部像素半径为 300 / 220，不改变实际 20 英尺范围。
- 飞行约 0.9 秒，爆炸和烟云约 3.8 秒；共 4.7 秒。没有全屏 Bloom 或地面裂缝；未选择素材时没有永久残留。
- 隐藏后台只处理 SDK；动画在按次打开的透明可见 `fx.html` 中运行。播放结束关闭特效页，空闲没有特效渲染循环。
- 瞄准圈是 Owlbear 原生本地 Shape，指针更新最多 20Hz；播放时视口投影最多 10Hz，单批查询在途。每帧不写 SDK 场景项目。
- 每客户端最多一个主效果和一个轻量 Canvas 次效果。更多并发只省略视觉并提示，不打断已播放效果；不会影响规则结算。
- 动画页预热与首帧确认、实例隔离、重复事件过滤、场景隔离、来源校验、超时和取消清理。

自动画质根据设备和近期慢帧降档，并在当前客户端保留 60 秒降档记忆，避免每次施法反复升回高档。**尚无真实房间 FPS 保证**；渲染器计时和独立测试页不能当成整个 Owlbear 的性能。

特效层是覆盖地图的独立透明画布，不读取地图深度、墙壁或迷雾；它不是把 Owlbear 改成 3D 地图。快速缩放/平移可能因 10Hz 坐标采样出现轻微跟随延迟。

## 本地开发与测试

需要 Node.js 22.18+（建议 24 LTS，支持测试中直接读取 TypeScript）。

```bash
npm ci
npm run dev
npm test
npm run test:deployment
```

本机 Owlbear 开发安装入口：`http://localhost:5173/fireball/manifest.json`；是否需要浏览器允许本地网络访问取决于浏览器安全策略，远程玩家不能访问你电脑的 localhost。直接打开根页面只显示扩展安装提示，不启动演示。

`test:deployment` 先构建，再验证 manifest、index/button/fx 三个页面、引用资源与 `/fireball/` 子路径。`npm run build` 只构建；`npm run preview` 在 4173 端口预览生产包。

## Linux / Docker Nginx 部署

只上传完整的 `dist/`，服务器不需要常驻 Node.js。安装 URL 保持：

```text
https://www.longtrail.cloud/fireball/manifest.json
```

把文件放进宿主机 `/opt/owlbear_fireball/dist/`。若 Nginx 在 `my-nginx` 容器内，需要 Compose **绝对路径**只读挂载：

```yaml
services:
  nginx:
    # 保留原来的 image、ports、networks 和其他 volumes
    volumes:
      - /opt/owlbear_fireball/dist:/opt/owlbear_fireball/dist:ro
```

挂载变更需要在原 Compose 项目目录重建 nginx 服务，单纯 restart 不会更新挂载：

```bash
docker compose up -d --no-deps nginx
docker exec my-nginx ls -l /opt/owlbear_fireball/dist/manifest.json
docker exec my-nginx ls -l /opt/owlbear_fireball/dist/fx.html
```

在主域名实际接收 CDN 回源的现有 Nginx `server` 中添加规则，保留 Halo 的 `location /`：

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
    add_header Access-Control-Allow-Origin "https://www.owlbear.rodeo" always;
    add_header Cache-Control "no-cache" always;
}
```

这是便于首次验证的缓存策略；确认后可单独给哈希命名的 assets 长缓存，但 HTML/manifest 必须及时重新验证。CDN 也可能强制缓存，更新时清除 `/fireball/` 下缓存（或按服务商规则清除目录），不要只清 manifest 而继续缓存旧 HTML。

不要让 CDN 或 Nginx 给扩展页面加 `X-Frame-Options: DENY/SAMEORIGIN`，也不要用 CSP 的 `frame-ancestors` 禁止 Owlbear 嵌入。使用 CSP 时需显式允许 `https://www.owlbear.rodeo`。`add_header` 继承行为依配置而异，请检查最终响应，不能只看配置文本。

```bash
docker exec my-nginx nginx -t
docker exec my-nginx nginx -s reload
curl -i -H 'Host: www.longtrail.cloud' http://127.0.0.1/fireball/manifest.json
curl -i https://www.longtrail.cloud/fireball/manifest.json
curl -I -H 'Origin: https://www.owlbear.rodeo' https://www.longtrail.cloud/fireball/fx.html
```

预期：manifest 返回 200、JSON 中 version 为 `1.4.0`；fx.html 返回 200 和 HTML 类型，并允许 Owlbear 跨域读取/嵌入。如果公网仍显示 Halo 404，检查 CDN 回源是否到 Nginx 80 而不是绕过它直连 Halo 8090，以及 www 和裸域是否配置一致。

更换 `dist` 时先备份；若整个宿主目录被替换或改名，Docker 目录绑定可能继续指向旧目录，需要重建 nginx 容器再检查容器内版本。保留旧哈希资源直到客户端刷新完成，可避免已打开页面加载到一半出现 404。

## 维护

- `controller.ts`：本客户端状态、场景标识、房间广播、动画页握手。
- `native-targeting.ts`：原生工具、棋子校验、范围圈与取消。
- `residue.ts`：GM 发布房间模板、客户端本地缓存、配置校验、权限检查与一次性创建共享 Props。
- `fx.ts`：可见 iframe 中的播放器和地图坐标投影。
- `performance-fx.ts`：房间 Three.js / Canvas 渲染器与性能预算。
- `cinematic-visuals.ts`、`volumetric-cloud.ts`：圆球、尾焰、爆裂、冲击波和体积烟云。
- `protocol.ts`：消息校验、去重、速率限制。

旧 `demo.ts`、`target.ts`、`effects.ts`、`three-fx.ts` 与旧 Shader 保留为历史参考，不进入 1.2.0 生产入口。不要混用旧 target 页面或 v1 广播协议。`tests/render-fixture.html` 仅用于开发回归，不随 dist 发布。
