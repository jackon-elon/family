# 亲友录 Web API

Node.js 22.16+，仅使用 Node 内建 HTTP、加密与 SQLite；复用 `backend/dist/` 中的业务服务与原有 JPEG 清理器。服务进程独立运行，前端可作为静态文件部署。SQLite 适用于当前单实例小规模部署；数据目录须位于持久磁盘，不能用容器临时文件层或网络共享盘。

当前 Web 产品仅用于自己的家庭。`FamilyRepository` 在业务服务下统一限制为家庭记录：旧同学记录不出现在列表、生日或申请中，旧链接、邀请及人物照片也不可通过 Web API 访问。所有网页账号均禁止新建家庭，公开注册关闭，注册须持有效家庭邀请。已有同学数据保留在数据库中，不进行物理删除，也不改变旧小程序和复用业务服务的能力。账号自己的统一资料仍可正常维护。新的演示数据只创建 7 人家庭。

游客可以输入完整家庭名称浏览共享家庭的资料和关系，**家庭名称不是认证秘密，知道或猜中名称的人即可看到正常家庭资料，包括手机号、微信、完整生日和照片**。这是当前明确选择的产品范围。私人记录和旧同学记录不开放此入口；游客不会成为账号或成员，也不能修改资料或使用管理功能。

## 本地运行

在项目根目录先执行 `npm run build:backend`，然后执行 `node server/index.cjs`。API 默认监听 `http://127.0.0.1:3001`，前端开发源默认 `http://localhost:5173` 和 `http://127.0.0.1:5173`。

正式部署首次使用 `node server/setup.cjs` 在交互终端初始化管理员账号与家人录（需要先编译 backend）。密码隐藏输入，不接受密码命令行参数或管道。初始化只允许空数据库；账号、家庭、创建者资格在同一个 SQLite 事务中提交，已有资料不会覆盖。生产环境同样须配置 `DATA_DIR`、`FRONTEND_ORIGIN` 等变量。随后登录网页，在“我的”补齐姓名、城市、生日。已有家庭资格但尚无本人节点的账号，会优先关联唯一同登录手机号的未绑定人物；没有匹配时补建本人节点，允许稍后连接关系。重号、他人已绑定或历史号码验证门禁会阻止关联；未获成员资格的账号不走此修复路径。

可选执行 `node server/seed.cjs` 初始化虚构演示资料。只对空数据库首次写入，重复运行只读取完成标记，已有账号和密码不会被更改。生产环境禁止运行种子。管理员 `13800000000`、普通成员 `13800000001`，演示密码 `LocalDemo2026!`。请不要把演示数据库用于公开部署。

## 环境变量

- `NODE_ENV=production`：启用 Secure Cookie，强制 HTTPS 来源配置，禁止种子。
- `HOST`：默认 `127.0.0.1`，容器内设置为 `0.0.0.0`。
- `PORT`：默认 `3001`。
- `DATA_DIR`：默认 `server/data`；生产环境必须显式指定持久化绝对路径，例如 `/data`。包含 `kin.sqlite`、WAL/SHM 文件与 `uploads/`。
- `FRONTEND_ORIGIN`：默认 `http://localhost:5173`；生产必须显式指定完整 HTTPS origin，例如 `https://kin.example.com`，不能带路径或末尾 `/`。
- `ALLOWED_ORIGINS`：可选，逗号分隔的额外精确 origin，不支持 `*`；生产每个都必须是 HTTPS。
- `TRUST_PROXY_HOPS`：默认 `0`，不信任转发 IP；固定一层 Caddy 反向代理时设置为 `1`。仅允许 `0` 至 `16` 的整数。启用后从 `X-Forwarded-For` 右侧按指定跳数选取客户端，验证 IP 并统一 IPv6 写法；缺少或格式错误时退回直连地址。

推荐前端域名反向代理 `/api/` 到本服务。也可以使用同站点的 API 子域，但前端请求必须 `credentials: 'include'`；会话使用 SameSite=Lax，不支持完全不同站点间依赖第三方 Cookie。数据库与照片目录绝不能作为静态站点目录提供下载。反向代理应转发原始 `Origin`，不可伪造可信来源。

使用 `TRUST_PROXY_HOPS=1` 时，API 只能在私有容器网络向 Caddy 开放，**不能发布 API 端口，也不能让客户端绕过代理直接访问**。Caddy 必须保持默认的安全 `X-Forwarded-For` 处理；不要直接照抄不可信请求头。若还有 CDN 或其他代理，应按实际固定链路配置跳数和上游可信规则，不能猜测跳数。保持默认 `0` 时所有经代理请求会共用代理 IP 的限速桶。启用受信代理解析后按客户端 IP 独立限速，同时继续保留手机号限速与并行密码运算上限。生产还应由反向代理设置请求速率与上传限制。

## HTTP 协议

成功：`{ "ok": true, "data": ... }`。失败：`{ "ok": false, "error": { "code": "...", "message": "..." } }`。

每个 POST 都需要 `Content-Type: application/json` 与白名单中的 `Origin`（包括命令行测试）。服务器采用严格 Origin 校验防止 CSRF，不另发 CSRF token。CORS 只对允许的精确来源返回凭据许可。

- `GET /api/health` → `{ service: 'kin-api', storage: 'sqlite' }`。
- `POST /api/guest/enter`，body `{ familyName }` → `{ family: { id, name, type: 'family', personCount }, persons, relations, birthdays, serverTime, expiresAt }`；按去除首尾空格后的名称精确匹配共享家庭。同名共享家庭返回 HTTP 409 `FAMILY_NAME_AMBIGUOUS`，未找到返回 HTTP 404 `FAMILY_NOT_FOUND`，不会任意选择第一个。
- `GET /api/guest/me` → `{ family, expiresAt }`；`GET /api/guest/family` → 与游客进入相同的完整只读资料。缺少或过期游客会话返回 HTTP 401 `GUEST_SESSION_EXPIRED`。
- `POST /api/guest/logout`，body `{}` → `{}`，删除游客会话并清游客 Cookie，不影响同时存在的账号登录。
- `GET /api/guest/photos?personId=...&v=...`：仅能读取所选家庭人物当前绑定的头像，URL 由游客资料的 `photoUrl` 提供。不提供无人物绑定的账号头像读取；文件读取后重新核对游客会话、共享家庭和人物照片。
- `GET /api/auth/config` → `{ registration: 'invite-only', canCreateFamily: false, sessionDays: 7, rememberDays: 90 }`。
- `GET /api/auth/me` → `{ user: { id, phone, phoneVerified: false, canCreateFamily: false, access: 'member' | 'invited', invitation? } }`；未登录返回 HTTP 401。受邀但尚未加入时 `invitation` 包含 `{ id, circleId, circleName, status: 'profile-required' | 'pending', expiresAt }`，不包含邀请秘密令牌。
- `POST /api/auth/register`，body `{ phone, password, inviteToken, remember?: boolean }`；没有有效、未占用的家庭邀请则拒绝注册。
- `POST /api/onboarding/preview`，body `{ inviteToken }` → `{ loginPhone, match: { status, confirmed, personId?, personUpdatedAt?, message?, person? }, profileVersion }`。须登录且有有效邀请；`status` 为 `none | unique | conflict | bound | verification-required`。仅预览不占用新邀请；返回匹配人物的允许导入字段，不返回原照片文件标识或授予照片权限。
- `POST /api/onboarding/import`，body `{ inviteToken, personId, personUpdatedAt, profileVersion }` → `{ profile }`。原子复核邀请归属、唯一号码匹配与双方资料版本，显式确认后补充本人资料并记录确认版本。未占用的新邀请在确认时绑定账号。
- `POST /api/auth/login`，body `{ phone, password, remember?: boolean, inviteToken?: string }`。注册和登录返回同上 `user`，并设置 HttpOnly 会话 Cookie。密码须 10–128 位并包含字母和数字。手机号规范化为带国家码格式。没有家庭成员或有效受邀资格的旧账号返回 HTTP 403 `ACCOUNT_NOT_INVITED`，不签发登录会话；旧账号可通过管理员的新邀请，使用原手机号与密码重新进入加入流程，无需重复注册。
- `POST /api/auth/logout`，body `{}` → `{}`，撤销当前账号会话、游客会话并清两类 Cookie；成功登录、注册及修改密码同样清除当前游客会话。
- `POST /api/auth/password`，body `{ currentPassword, newPassword }` → `{ user }`，更新密码、撤销全部旧会话并为当前浏览器发新会话。
- `GET /api/auth/sessions` → `{ sessions: [{ id, isCurrent, deviceName, createdAt, lastSeenAt, expiresAt }] }`；只列本人未到期会话。`id` 是随机公开标识，不能充当登录令牌；不返回 Cookie、令牌哈希或完整 User-Agent。
- `POST /api/auth/sessions/revoke`，body `{ sessionId }` → `{ currentRevoked }`；仅可撤销本人的设备，撤销当前设备时同时清 Cookie。
- `POST /api/auth/sessions/revoke-others`，body `{}` → `{ revokedCount }`；退出本人的其他设备，保留当前浏览器。
- `POST /api/auth/reauthenticate`，body `{ password }` → `{ reauthenticatedUntil }`，确认当前浏览器 10 分钟内可执行敏感操作。
- `POST /api/rpc`，body `{ action, payload }` → 现有 `ApiService` envelope，业务错误保留 HTTP 200；传入的 `actorId` 顶层字段一律拒绝，身份仅来自服务器会话。仅 `invite.preview` 允许匿名。
- `POST /api/photos`，body `{ base64, circleId?, personId? }` → 原业务上传结果。仅支持 1 MB 以内 JPEG，删除 EXIF/XMP/ICC/评论元数据；上传原始图片前前端需转 JPEG。无 circle/person 参数表示自己的统一资料头像。
- RPC `photo.url` 和 `photo.urls` 返回 `/api/photos?...&v=...` 相对 URL。图片通过带 Cookie 的 `GET /api/photos?circleId=...&personId=...` 读取；没有两个参数时读取当前账号头像。每次获取照片重新核对成员/资料权限，响应 `Cache-Control: no-store`；移出后旧 URL 失效，文件路径不能直接公开。

未勾选记住登录时会话有效期 7 天，`remember: true` 时为 90 天，均为绝对期限；打开网页、查询设备或重启服务不会延长。旧 7 天会话只补充随机设备标识和时间元数据，不自动延寿。随机令牌仅在 Cookie 中传递，数据库只存 SHA-256。设备名由 User-Agent 提取的大类组成，仅便于识别，不能作为身份认证。最近使用时间至多每分钟更新一次。密码由带独立随机盐的异步 scrypt 存储；登录、注册、改密码和再确认共享手机号/IP 限速及最多 4 个并行密码运算。普通 JSON 上限 128 KiB，照片请求上限 1500 KiB。

认证采用从首次计数起的 15 分钟固定窗口：规范化后的同一手机号最多 12 次，同一 IP 最多 50 次，成功、失败及无有效邀请的注册尝试均计数；家庭名称查询单独按 IP 最多 30 次。计数保存在 SQLite，清 Cookie、变换号码格式或重启不重置。失败的家庭查询也会提交计数。未配置可信代理时忽略客户端转发 IP；生产代理链必须按上文部署，禁止直连 API。

HTTP 429 的 `Retry-After` 与 JSON `error.retryAfterSeconds` 返回实际剩余秒数，并为独立前后端来源暴露响应头；密码并发繁忙返回 2 秒，游客容量繁忙返回 30 秒，避免把暂时繁忙误报为 15 分钟封锁。网页对应入口显示倒计时，结束后恢复提交，不自动重放请求。认证和游客入口倒计时互不影响，后台限流始终独立生效。应用内限流不能替代公网边缘的抗流量攻击，也不能把可猜的家庭名称变为私密凭证。

游客会话使用独立随机令牌与独立表 `guest_sessions`，数据库只保存令牌 SHA-256。Cookie 为开发环境 `kin_guest`、生产环境 `__Host-kin_guest`，HttpOnly、SameSite=Lax、Path=/，生产附加 Secure；固定 4 小时到期，不因浏览或重启延长。每 IP 每 15 分钟允许 30 次家庭名查询，查询失败同样计数。进入时清理到期行，同一浏览器替换原游客会话，最多保留 1000 个有效游客会话；达到上限时拒绝新增，不会挤掉其他仍有效的访客。

游客响应对家庭、人物及关系逐字段投影，包含家人正常可见的姓名、昵称、性别、生日、城市及城市坐标、联系方式、职业、近况等；头像使用受保护的相对 URL。账号统一资料、当前家庭管理员修正及字段修订按正常成员相同规则合并，成员关联结束后不再读取其新的账号资料。响应不含账号 ID、认领标识、角色、权限、创建者 ID、审核申请、审计记录、私人备注或原始照片文件 ID。游客 Cookie 不用于 `/api/rpc`、账号资料、密码、设备或普通照片接口；携带游客 Cookie 的已登录账号仍只按该账号的实际成员权限操作。

完整游客快照的 `birthdays` 为 `{ events, asOf, refreshAt, error? }`。`asOf` 是服务器北京时间日期，`refreshAt` 是下个北京时间午夜的毫秒时间戳，`serverTime` 是生成快照时的毫秒时间戳。`events` 包含今天至 30 天后的最近一次生日，按日期排序；使用上述当前人物投影，复用公农历换算，不排除任何家人。单条或农历换算失败时返回可用结果及提示，不中断家人资料读取。前端按服务器时间基准在跨日后更新，不依赖设备的时区。

敏感 RPC 包括 `circle.transferOwner` / `circle.acceptOwnerTransfer` / `circle.cancelOwnerTransfer`、`member.setRole` / `member.remove`、`person.unclaim` / `person.delete`。当前浏览器未在最近 10 分钟内验证密码时返回 `REAUTH_REQUIRED`，前端确认后可重试；登录、注册及成功修改密码也计入该窗口，刚输入密码后无需立即重复。普通资料、备注、关系编辑不要求每次确认。再确认只对当前会话有效。每个实际业务事务执行前重新查询会话存在及有效期；照片读取完成后再次查会话和权限，设备撤销后的在途请求不会释放照片或写入资料。

## 邀请与资料关系

账号登录资格每次从数据库核对，不从浏览器声明或过期角色快照推断：现存家庭中的有效成员可以登录，首位初始化管理员和暂未绑定本人资料的成员也包含在内；旧同学成员不算家庭资格。没有家庭成员资格时，必须存在绑定本账号的有效、未使用共享家庭邀请，且申请尚未提交或仍待审核。迁移前已存在的真实待审申请，在对应邀请仍有效且没有绑定他人的情况下同样保留加入资格。邀请过期、撤销、用完、申请被拒绝或失效不再提供登录资格；正式成员不受历史邀请到期影响。

退出或被移出后，同一家庭之前发出的未使用邀请不能恢复权限，须使用结束成员资格之后新发的邀请。旧账号以正确密码和新邀请恢复时，绑定邀请与签发会话在同一事务中完成，并撤销该账号旧设备会话。错误密码不会占用邀请。资料补全和待审核阶段返回 `access: 'invited'`，可维护本人资料、提交和查看本人申请，但不能使用家庭成员读写接口；按名称进入的游客浏览仍是独立入口。无原邀请链接的受邀账号应重新打开家人发来的原链接，不能用公开邀请 ID 重造秘密令牌。

认证请求、实际业务事务和照片文件读取后的权限检查均复核登录资格。移出成员、主动退出、拒绝申请和撤销邀请会在业务事务中删除已失去全部资格的账号会话；查询发现过期资格时也提交撤销旧会话。账号仍有其他家庭资格时保留登录，其具体操作继续由当前家庭成员角色决定。过期旧 Cookie 不会阻止重新登录、退出账号、匿名邀请预览或独立游客入口。索引 `invite_account_account` 与现有按用户及记录主键索引用于查询，没有另设权限位图或可能过时的角色缓存。

注册时的号码是登录名，**尚未通过短信验证**。该阶段不写入 `phoneIdentities`，不调用 `linkVerifiedPhone`，不授予已有人物的编辑权。一个邀请最多绑定一个账号：创建账号、占用邀请及签发会话原子提交，并在密码计算前后复查邀请；已有账号确认导入或首次申请也会占用该邀请。其他账号不能借用已占用的邀请申请或获批。管理员添加家人时须填写有效且家庭内不重复的手机号，无需代设密码。受邀者用相同登录手机号注册后，可确认并带入原资料，完整后提交申请；管理员核对批准才获得成员身份和本人资料编辑权。按家庭名称进入的游客只读浏览是独立入口。新人物须选亲属关系或明确稍后补充。

邀请预览返回 `canRegister` 布尔值，不透露绑定账号信息。邀请用于注册后可以保持 `status: 'active'` 以让原账号继续申请，但 `canRegister: false`；只有审批成功才消耗其加入次数。邀请过期、撤销、已使用或被其他账号占用时拒绝注册。原账号可登录继续查看自己的申请；全体账号调用 `circle.create` 均返回 `FAMILY_CREATION_DISABLED`，首个家庭只通过本地初始化建立。

同手机号唯一匹配时，申请列表返回 `loginPhone` 和 `phoneMatch`，审批界面默认并锁定原人物，后台再次核对本人确认、人物版本及当前手机号。审批保留原人物 ID、关系和可继承的照片，不允许退回“新增人物”制造重复。未匹配时可新增，或人工关联没有手机号的历史资料；不同手机号、多个同号人物、已被他人绑定均不能绕过。已有资料设置独立 `matchPhone` 核对号码时仍须真实已验证手机号，未接短信的账号不能通过此门禁。

确认导入只补空白，不覆盖本人已编辑或明确清空的字段。`invite_profile_imports` 保存人物版本及自动预填的字段值／修订号；待审核时原人物变动，申请人可重新打开邀请确认，未改过的预填字段随更正同步。原手机号变化导致无法匹配时明确提示管理员核对并重新邀请。确认、申请与审批都在同一事务中重验，不使用前端传入的联系方式作为登录身份。短信验证、忘记密码自助找回尚未接入；服务端没有仅凭手机号重置密码的接口。

## 存储、备份和测试

所有业务事务及认证数据库操作共用同一队列；事务失败会回滚，异步操作不会让另一个请求的认证写入混入未提交事务。当前部署是**一个 API 实例、一个 SQLite 数据目录**；不要启动多个进程共用该目录，也不要水平扩展容器副本。

备份请先正常停止服务，再备份整个 `DATA_DIR`（含照片）；恢复时同样停服替换整个目录。不要只复制运行中的 `kin.sqlite` 而遗漏 WAL。目录应只对服务运行账号可读写。

测试：`npm run build:backend` 后执行 `node --test server/tests/*.test.cjs`。HTTP 集成测试使用独立临时目录，不修改本地演示库。
