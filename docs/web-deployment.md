# 网页前后端部署

## 架构与产物

浏览器 → 网页前端 → `/api` → Node.js HTTP 服务 → SQLite／私有照片目录。

- `frontend/dist/` 是静态网页，不包含数据库或登录密码。
- `server/index.cjs` 是后端启动入口，复用 `backend/dist/` 的业务服务。
- 前端和后端可以独立构建、更新。推荐使用同一个网站域名，由反向代理将 `/api` 转发到后端。
- SQLite 采用 WAL、事务与统一请求队列，数据位于 `DATA_DIR`；当前只部署一个 API 实例，不能把同一个 SQLite 文件作为多个副本的共享数据库。

## 直接使用 Node.js

要求 Node.js 22.16+。当前开发验证版本是 22.16.0，内置 SQLite 可能打印 ExperimentalWarning；这不是启动失败。

```powershell
npm ci
npm run build
$env:DATA_DIR = 'D:\kin-data'
$env:FRONTEND_ORIGIN = 'http://127.0.0.1:5173'
npm run setup:family
npm start
```

另外一个终端运行 `npm run dev:web` 即可本地开发。`npm run dev` 可以同时启动两者。默认前端 `127.0.0.1:5173`、后端 `127.0.0.1:3001`，开发服务不自动暴露到公网。

初次需要示例资料时显式运行 `npm run seed:demo`；已有数据不会被种子脚本覆盖，生产模式禁止创建演示账号。默认本地数据目录为 `server/data/`，不要把它提交进 Git。

`setup:family` 只用于尚未初始化家庭的新部署，通过终端交互填写管理员手机号、密码和家人录名称。已有家庭时会拒绝重复初始化；更新已有部署不需要再执行。管理员首次登录后完善姓名、城市、生日等个人资料，再从“我的 → 管理”邀请亲戚。

管理员可先添加家人，填写本人将用于登录的手机号及资料，再发送邀请。家人通过同号码注册、确认已有资料并提交申请；管理员核对后沿用原人物，本人即可在“我的”维护资料。无需管理员代设密码。更新版本时服务启动会补充资料确认记录表及字段，保留现有账号、人物和关系；已有缺少手机号的记录需在管理页补充，不会猜测号码或批量合并。

## Docker Compose 上线

先把域名解析到服务器，开放 80/443，安装 Docker 与 Compose。

```powershell
Copy-Item deploy.env.example .env
# 编辑 .env 中 PUBLIC_ORIGIN 与 SITE_ADDRESS
docker compose config
docker compose up -d --build
docker compose ps
docker compose exec api node server/setup.cjs
```

例如 `.env`：

```dotenv
PUBLIC_ORIGIN=https://kin.example.com
SITE_ADDRESS=kin.example.com
NODE_ENV=production
HTTP_PORT=80
HTTPS_PORT=443
```

前端镜像内的 Caddy 提供网页、将 `/api` 转发到 API，并为可公开验证的域名申请及续期 HTTPS 证书。API 不发布主机端口，数据库和照片留在 `kin_data` 持久卷。生产环境会拒绝缺少数据目录、缺少前端来源或使用非 HTTPS 来源的配置。

最后一条命令仅在初次部署时运行，用容器内已有的 Node.js 入口创建管理员及家庭；无需在运行镜像中安装 npm 依赖。不要把管理员密码写入 `.env`、命令参数、镜像或仓库。网站没有开放的初始化／注册入口，部署后不会被第一个陌生访客抢占。

本地测试 Compose 可单独使用以下环境；仅用于本机验证：

```dotenv
PUBLIC_ORIGIN=http://localhost:8080
SITE_ADDRESS=:80
NODE_ENV=development
HTTP_PORT=8080
HTTPS_PORT=8443
```

正式部署不要使用开发环境或演示密码。中国大陆服务器上的网站按实际接入商要求办理备案。

### 分别更新

```powershell
docker compose up -d --build api
docker compose up -d --build frontend
```

更新不会删除持久卷。不要使用 `docker compose down -v`，该参数会删除数据卷。

## 分开托管前端与后端

静态服务器配置 SPA 回退：找不到静态文件时返回 `index.html`。`/api` 必须优先转发，不能返回网页 HTML。

若前端在 `https://kin.example.com`，API 在 `https://api.example.com`：

1. 构建前端前设置 `VITE_API_BASE_URL=https://api.example.com`，不带末尾 `/api`。
2. 后端设置 `FRONTEND_ORIGIN=https://kin.example.com`。
3. 若确有多个前端来源，通过 `ALLOWED_ORIGINS` 配置逗号分隔的精确来源；不能用 `*`。
4. API 使用 HTTPS。浏览器请求必须携带 Cookie，前端已配置 `credentials: include`。

会话使用 SameSite=Lax Cookie，因此推荐同源代理或同站点子域名。前后端放在互不相关的主域名下会受到浏览器第三方 Cookie 限制，当前部署方案不支持以关闭安全限制来规避。

### 后端配置

- `HOST`：默认 `127.0.0.1`；容器设为 `0.0.0.0`。
- `PORT`：默认 `3001`。
- `DATA_DIR`：数据库与照片所在目录；生产必填，容器使用 `/data`。
- `FRONTEND_ORIGIN`：准确的网站来源，包含协议及非默认端口、不带路径。
- `ALLOWED_ORIGINS`：额外允许来源，逗号分隔。
- `TRUST_PROXY_HOPS`：默认 `0`，直接访问 API 时不信任转发 IP。Compose 中只有 Caddy 能访问 API，因此设为 `1`，按客户端 IP 分别限制登录请求。调整代理层数时同步调整此值，并确保 API 无法绕过受信任代理直接访问。
- `NODE_ENV=production`：强制 HTTPS 来源与 Secure 会话 Cookie。

前端 `VITE_*` 配置属于构建时公开配置，不得填写服务端密钥。

## 地图

默认使用随前端构建发布的 Natural Earth 矢量底图和本地城市目录，本地与生产使用同一方案。不需要申请地图密钥或接入公共瓦片服务器；底图文件通过自己的静态网站分发，计入网站的普通存储与流量。中国／世界概览、中国省界、基础城市名称、城市标记、人数聚合和成员名单均可使用，不提供街道路网、导航或市辖边界。数据的许可及重建方式见 [网页底图说明](web-basemap-data.md)。

保持 `VITE_MAP_TILE_URL` 为空即可使用默认底图。固定版本、来源、授权和重建方式见 [网页底图说明](web-basemap-data.md)。不要为了离线使用批量抓取 OpenStreetMap 公共瓦片。

若以后确实需要在线地图，可在构建前配置有相应使用授权的服务，并按服务要求署名：

```dotenv
VITE_MAP_TILE_URL=https://your-provider.example/tiles/{z}/{x}/{y}.png
VITE_MAP_ATTRIBUTION=实际地图服务署名
```

地图标记使用粗略城市中心，不表示精确地址。Natural Earth 底图及 GeoNames 城市源为 WGS84；国内目录上游未标明坐标基准，现有城市坐标仅保留到 0.1 度，具体限制见数据说明。接入其他坐标系的底图前需要核对和适配坐标，不能将这些概览位置用于精确定位。可选在线瓦片加载失败时继续显示本地矢量底图和城市成员名单。地图不读取实时定位和家庭地址；底图可本地加载不等于整个应用支持断网使用，登录和成员资料仍由后端提供。

## 备份与迁移

需要一起备份数据库和照片。最简单的可一致恢复方式是短暂停止 API 后复制完整目录；不要在写入过程中只复制 `kin.sqlite` 而遗漏 WAL 文件或照片。

Compose 示例：

```powershell
docker compose stop api
New-Item -ItemType Directory -Force backups | Out-Null
docker compose cp api:/data ./backups/kin-data
docker compose start api
```

每次备份使用新目录名，避免覆盖上一份备份。迁移时停用新旧 API，把完整数据恢复到新服务的持久卷并保留可写权限，再启动一个 API 实例。首次迁移后检查管理员登录、人数、照片、关系、生日与邀请。

## 登录与上线前待接入项

当前手机号只作为账号标识，密码采用随机盐与 scrypt 保存，会话标识只保存哈希。尚未接短信验证、短信找回密码；已登录用户可以修改密码。未验证的号码不会变成已验证号码，也不会触发按号码接管人物资料。

账号注册为家庭邀请制。管理员生成短期一次性链接或二维码，亲戚打开后注册、完善个人资料并申请加入；管理员批准后才获得家庭成员身份。一份邀请最多注册一个账号，后端事务防止重复和并发注册。已有账号可以使用邀请申请加入；没有邀请不能注册。登录同样检查有效家庭成员或受邀流程资格，历史无资格账号即使密码正确也直接拒绝；从新的有效邀请打开后可使用原账号密码恢复加入流程。受邀账号显示待完善或待审核状态，不进入空家庭首页。公开的创建家人录接口已关闭，不会因隐藏按钮被绕过。

网站另提供家庭名称游客入口，无需创建账号。按照产品所有者明确选择，游客可查看姓名、照片、城市、完整生日、手机号、微信及近况；知道或猜中家庭名称的人即可浏览这些信息，因此家庭名称不是保密手段。游客只能读取对应家庭资料，不能上传、写备注、改资料、发邀请或管理家庭；私人备注仍只对本人可见。

登录默认保存 7 天，选择“这是我的手机，记住登录”后固定保存 90 天；会话到期、退出、被撤销或修改密码后需要重新登录。令牌只通过 HttpOnly Cookie 传输，生产环境使用 Secure Cookie，不能放进链接或 localStorage。“我的”可查看登录设备、退出其他设备；移交管理权等重要操作需在最近 10 分钟内确认密码。服务器升级时旧会话保持原到期时间，不自动变成 90 天。

后续多实例部署需增加共享数据库适配器及共享对象存储，保留现有事务、会话、图片访问和权限校验。不能直接复制 SQLite 到多个实例分别写入。
