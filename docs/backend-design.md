# 亲友关系网后端设计（本地版）

版本：0.1；对应需求文档讨论稿 0.5。此文档描述已经实现的本地服务和将来接入微信云开发时的部署边界。已有测试小程序 AppID，尚无云开发环境，因此云端行为尚未实测。

## 1. 架构与边界

小程序只调用一个事件型云函数 `api`，请求格式为 `{action, payload}`。云函数从微信运行时取得 `OPENID`，将其作为账号标识交给 `ApiService`；客户端传来的 `userId`、角色或 `claimedBy` 均不参与鉴权。`ApiService` 依赖 `Repository` 接口，本地测试用 `MemoryRepository`，云端拟用 `CloudBaseRepository`。关键写操作使用数据库事务。人物照片存云存储，人物文档只保留 `photoFileId`；获取临时链接先经 `photo.url` 通过资料可见性检查。

返回值统一为 `{ok:true,data:{...}}` 或 `{ok:false,error:{code,message}}`。服务端错误只返回通用信息，不把数据库异常、令牌摘要和堆栈传给客户端。所有日期均为 Unix 毫秒时间戳。

家庭圈和同学圈都以 `circleId` 分区。每个圈子固定 `type: family | classmate`；同学圈必须有学校、届别和班级，服务端禁止在同学圈建立亲属关系。成员身份由 `circleId + OPENID` 的确定性文档 ID 确定；每个已加入账号在每圈最多认领一张人物卡。圈内查询先检查 active membership，再读取该圈的数据，不接受跨圈 ID 混用。

## 2. 数据模型

- `circles`：圈子类型、名称、`private/shared` 维护模式、圈主、班级信息。
- `members`：圈子、账号、申请时提供的显示姓名、`owner/admin/member` 角色、`active/left/removed` 状态、本人卡 ID。圈主尚无本人卡时暂显示“圈主”；认领人物卡后列表优先显示卡片的最新姓名。
- `persons`：圈内人物卡、基础关系信息、可选资料、可选的城市代表点 `latitude/longitude`、每字段可见范围、内部认领账号、关系连接计数。代表点取整到 0.1 度；手动选点来自小程序原生地图的 GCJ-02 坐标，常见城市使用预设近似中心。不记录实时定位或住址。
- `relations`：仅家庭圈使用。`parent` 为 `from` 父母到 `to` 子女的有向边；`spouse` 和 `sibling` 为无向关系，`olderId` 可标记兄弟姐妹中的较长者。人物 `birthOrder` 是同父母、同性别兄弟姐妹中的排行，用于“大姨／二姨”等称呼；两人长幼优先取 `olderId`。
- `invites`：邀请码哈希、创建人、72 小时到期时间、撤销和一次性使用状态。原始令牌仅在创建响应中给管理员一次。
- `applications`：加入申请、身份核对说明、可选的认领卡、审批状态。
- `claimRequests`：已加入成员认领现有未认领卡的申请。
- `delegations`：已认领人物本人对某位管理员授权的字段列表及撤销时间。
- `suggestions`：成员提交人物、关系或邀请建议，由管理员标记处理结果。
- `audit`：邀请、审批、角色、成员、人物、关系、授权等关键操作记录。

本地 `MemoryRepository.atomic` 串行执行并在失败时丢弃本次变更。CloudBase 适配器以事务保护确定性 ID 的成员文档、人物卡和邀请码文档；同一邀请的两次审批均须在事务里读写同一 `invites/{id}`，只有一个能提交。关系边按圈子、类型和端点生成确定性 ID；建立／删除关系时在同一事务读写两端人物的连接计数，删除人物时读取该计数，避免并发操作产生重复边或悬空关系。CloudBase 文档型数据库事务要求在服务端运行且事务内只使用 `doc(id)` 操作，因此列表查询用事务外的 `where`；决定权限和冲突的文档仍在事务内按 ID 读取。事务冲突会使请求失败，前端可刷新后重试。参考[腾讯云事务文档](https://docs.cloudbase.net/database/transaction)。

## 3. 权限与资料可见性

- **未加入者**：只能凭有效令牌调用 `invite.preview`，看到圈名、类型及班级识别信息；可申请加入，审批前不能读人物、地图、关系或联系方式。
- **成员**：能读本圈经过字段过滤的人物和关系；能编辑自己已认领的资料与可见范围、申请认领现有卡、提交建议、退出圈子。
- **管理员**：能邀请、审批、维护未认领卡的姓名等最少字段、建立和删除关系、处理建议、移除普通成员。管理员身份不能越过他人对联系方式、照片和城市设置的可见范围。
- **圈主**：拥有管理员权限，还能任免管理员、移交圈主、开启共建。圈主不能被移除，退出前须先移交。

人物的姓名、昵称、性别和排行属于建立关系网所需的基础字段。其他可选字段默认仅本人可见；国家／省份／城市及城市代表点共用 `city` 可见性设置，手机号和微信号分别设置，照片单独设置。读取 `person.list/get` 时，未授权字段在 JSON 中直接省略。服务端要求经纬度同时填写或同时清除、处于有效范围且有城市名称；修改地点名称但未重选坐标时清除旧坐标，避免把旧城位置误标到新城。服务端只保证坐标格式和城市级精度，城市名称与选点是否相符仍由填写者确认。未认领卡只能由管理员填写基础字段，不能代填电话或城市。本人退出或被移除后，账号立即失去成员权限，已认领卡解除绑定、清空私人资料并保留姓名与关系节点；有效代维护授权一并撤销。

授权代维护只能由人物卡本人发起，对象必须是本圈活跃管理员，字段需逐项选择；选择 `city` 同时允许维护国家、省份、城市及经纬度，`person.get` 的 `myDelegatedFields` 也会返回这些字段供前端编辑。受托人在 `person.get` 中可读已授权字段的当前值，方便编辑；`person.list` 和无授权成员仍按可见范围过滤。受托人不可修改 `visibility`。授权人可随时撤销；管理员降级、退出或被移除时授权随即失效。授权记录和代维护操作均写入审计。管理员对已认领人物卡的普通修改没有特权。

## 4. 接口契约

以下请求都经 `invoke({action,payload})` 调用，`circleId` 仅作为资源定位参数，不赋予访问权。响应中的 `person` 经过字段过滤；`isSelf`、`isClaimed` 可用于页面显示，`claimedBy`、圈主与成员 OPENID、邀请码哈希永不随圈子或人物接口返回。

### 圈子与成员

- `circle.create`：`{type,name,mode,school?,cohort?,className?}` → `{circle}`，创建者为圈主；同学圈后三项必填。
- `circle.list`：`{}` → `{circles:[...circle,role,memberCount]}`，只列本人活跃圈子。
- `circle.detail`：`{circleId}` → `{circle,role}`。
- `circle.upgrade`：`{circleId,privacyReviewed:true}` → `{circle}`，圈主确认历史资料可见性后由 private 升级 shared。
- `circle.transferOwner`：`{circleId,memberId}` → `{circle,member}`，旧圈主变管理员。
- `member.list`：`{circleId}` → `{members:[{id,name,role,status,personId?,isSelf,...}]}`，仅活跃成员；姓名优先取本人卡最新名称。
- `member.setRole`：`{circleId,memberId,role:'admin'|'member'}` → `{member}`，仅圈主。
- `member.remove`：`{circleId,memberId}` → `{member}`，上级管理员只能移除较低角色。
- `member.leave`：`{circleId}` → `{member}`，圈主不可直接退出。

### 人物与照片

- `person.list`：`{circleId}` → `{persons:[person]}`；地图和列表使用同一响应，因此隐藏城市不会进入地图人数。
- `person.get`：`{circleId,personId}` → `{person}`；本人额外得到 `visibility` 和活跃 `delegations`；受托管理员得到 `myDelegatedFields`。
- `person.create`：`{circleId,name,nickname?,gender?,birthOrder?,claimSelf?}` → `{person}`。管理员可创建未认领卡；任何尚无本人卡的已加入成员都可用 `claimSelf:true` 创建并认领自己的新卡，因此未选择现有卡的新同学也能填写资料。普通成员不能创建他人卡。
- `person.update`：`{circleId,personId,patch:{...},visibility?:{field:'self'|'circle'}}` → `{person}`。本人可编辑并设可见性；管理员对未认领卡仅可改基础字段；受托管理员仅可修改授权字段。
- `person.delete`：`{circleId,personId}` → `{personId}`。只能删除未认领、无关系连接的卡；有关系时返回 `RELATION_CONNECTED` 和关联数量说明。
- `person.claim`：`{circleId,personId}` → `{claimRequest}`，仅提出申请；管理员用 `person.claimList` 查看含 `applicantName` 的待审请求，再用 `person.claimApprove`、`person.claimReject`（后两者 `{circleId,claimRequestId}`）核对后绑定。加入申请也可携带 `claimPersonId`，在加入审批时一并核对。
- `person.unclaim`：`{circleId,personId}` → `{person}`，管理员纠正误认领；解绑账号、清除该卡私人资料、撤销代维护授权并留审计记录。
- `photo.upload`：`{circleId,personId,base64}` → `{person}`。小程序先将 JPEG 压缩到 1 MiB 以内，再以 base64 调用云函数；云函数验证文件签名、大小与人物编辑权限，服务端上传到 `photos/<当前 OPENID>/<UUID>.jpg`，并绑定到人物卡。若绑定时权限已变更，会尝试删除刚上传的文件。`photo.uploadPath` 是云函数内部用于二次鉴权的动作，客户端不需要调用。人物和成员查询不返回其他人的 OPENID。
- `photo.url`：`{circleId,personId}` → `{url}`，先检查本圈成员与照片可见性；拥有有效 `photoFileId` 代维护授权的管理员也可查看该照片。随后签发短时链接。

资料 `patch` 可用字段：`name,nickname,gender,birthOrder,country,province,city,latitude,longitude,status,school,industry,occupation,bio,phone,wechatId,photoFileId`。可设置可见性的字段：`city,status,school,industry,occupation,bio,phone,wechatId,photoFileId`。`country/province/city/latitude/longitude` 一起按 `city` 权限过滤；`latitude/longitude` 不作为单独的代维护授权项。

### 关系、邀请、审批与授权

- `relation.list/create/delete`：分别传 `{circleId}`、`{circleId,from,to,type,olderId?}`、`{circleId,relationId}`；创建删除仅管理员，且仅家庭圈。
- `invite.create`：`{circleId}` → `{invite:{id,token,expiresAt,status}}`，仅共建圈管理员。`token` 是 32 字符 base64url 字符串，可放入小程序码 `scene`；微信卡片和二维码必须承载**同一个 token**，不能各生成一份。
- `invite.preview`：`{token}` → `{circle,expiresAt,status}`，唯一不要求已加入身份的读取接口，不含成员信息。
- `invite.apply`：`{token,name,note?,claimPersonId?}` → `{application}`。申请人最多看到自己的申请响应。
- `invite.list/revoke`：`{circleId}`、`{circleId,inviteId}`，仅管理员；列表不返回原始 token。
- `join.list`：`{circleId}` → `{applications}`；`join.approve/reject`：`{circleId,applicationId}` → `{application}`，仅管理员。批准时再次检查邀请到期／撤销／已用状态，并原子绑定成员及人物卡。多人用一份邀请码申请时，仅一人可获批准；其余申请标记过期。
- `join.mine`：`{}` → `{applications}`，申请人查看自己提交的加入申请和处理状态，不返回别人的申请。
- `delegation.grant`：`{circleId,personId,adminMemberId,fields:[...]}` → `{delegation}`，只有已认领人物本人可授权。
- `delegation.revoke`：`{circleId,delegationId}` → `{delegation}`，只有授权人可撤销。
- `suggestion.create/list/resolve`：创建 `{circleId,type:'person'|'relation'|'invite',personId?,message}`；列表 `{circleId}`；管理员处理 `{circleId,suggestionId,status:'accepted'|'rejected'}`。接受建议只记录处理结果，具体资料或关系仍由管理员调用对应写接口。
- `audit.list`：`{circleId}` → `{events}`，仅管理员，最近 100 条；成员不可查其他人的管理记录。

## 5. 邀请与认领状态

邀请码由随机 24 字节编码为 32 字符 base64url 字符串。服务端以 SHA-256 摘要作邀请文档 ID 和校验值，不存原始 token；链接有效期为创建后 72 小时，管理员可随时撤销。展示、申请和审批分别检查状态；审批以当前服务端时间再检查一次，避免“申请时有效、审批时已过期”绕过。被转发的人只能提交身份说明，管理员核对后再批准。同学圈的“是否同班”由管理员依据学校、届别、班级及申请说明人工核对，服务无法自动证明现实身份。

一张人物卡只能有一个 `claimedBy`。同名、相同手机号都不会自动绑定。圈内已有成员的认领必须独立申请和审批；加入时认领在加入审批事务内完成。并发认领会同时写同一人物文档，至多一方提交成功。

## 6. 云开发安全配置与部署前置

**数据库**：对 `circles,members,persons,relations,invites,applications,claimRequests,delegations,suggestions,audit` 每个集合设置自定义安全规则 [database-deny-client.json](../cloudfunctions/security/database-deny-client.json)，禁止小程序客户端直接读写原始文档。云函数使用环境范围数据库客户端操作数据，再由 `ApiService` 逐请求过滤。默认开放数据库读权限会泄露隐藏字段、邀请摘要及 OPENID，因此不能发布。

**云存储**：设置 [storage-deny-client.json](../cloudfunctions/security/storage-deny-client.json) 为客户端读写均拒绝。照片仅经云函数 `photo.upload` 服务端上传，上传前做成员、本人／授权、JPEG 签名及 1 MiB 大小校验。小程序不能调用 `wx.cloud.uploadFile` 直传，以免未入圈用户占用存储额度。跨成员照片展示通过 `photo.url`，由云函数在权限校验后签发暂设 60 秒有效的临时 URL；已经签发的 URL 在到期前可能仍被持有者访问，因此移除成员后的照片访问不能仅靠前端清缓存声称瞬时撤回。上线前须在真实环境验证私有文件的服务端上传、签发、链接有效期与删除流程。还需配置资源费用告警和孤儿文件清理；被移除成员照片的物理清理尚未实现。请求内传 base64 会增加流量，已用 1 MiB 限制控制单次成本。

**函数**：可参考 [function-api-only.json](../cloudfunctions/security/function-api-only.json)，只开放 `api` 给已登录调用者。**上线硬门槛：`api` 只能由已绑定的小程序通过事件调用，禁用 HTTP、Web、定时器、数据库触发器及其他来源调用同一函数。**身份来源是 `wx.cloud.callFunction` 的 `OPENID`；腾讯云文档指出混合调用来源时 `getWXContext()` 可能因实例复用残留上一位用户身份，函数安全规则 `auth != null` 本身不能证明来源。未来增加其他端时须拆分入口或采用能够验证调用来源的可信上下文身份方案，不能沿用此入口。参考[云函数实例复用说明](https://docs.cloudbase.net/cloud-function/instance)。不要在客户端直连数据库或存储做越权查询。安全规则在真实环境中需要逐项检查生效情况，不能只因本地测试通过就发布。

部署顺序：创建微信小程序账号和云开发环境、绑定 AppID；创建十个数据库集合并逐个配置拒绝客户端访问规则；配置云存储和函数规则；在项目根目录执行 `npm run build:cloud`（编译后端并复制产物到 `cloudfunctions/api/lib`）；**从根目录的 `project.config.json` 打开微信开发者工具项目**，其 `miniprogramRoot` 为 `miniprogram/`、`cloudfunctionRoot` 为 `cloudfunctions/`，然后上传 `api` 云函数，或在有权限的环境用 CloudBase CLI 将 `cloudfunctions/api` 部署为事件型函数 `api`；再用真实测试账号验证权限、邀请和照片。当前 `cloudfunctions/api/package.json` 指定 `wx-server-sdk`，部署时安装云端依赖。不要只打开 `miniprogram/project.config.json`，那样云函数目录不在项目根下。参考[微信小程序调用云函数](https://docs.cloudbase.net/recipes/add-cloud-function-wechat-miniprogram)、[安全规则](https://docs.cloudbase.net/rule/rule-example)。

## 7. 本地验证与未完成事项

在项目根目录运行 `npm run test:backend`，会先编译 TypeScript，然后运行 Node 自带测试。当前 18 项测试包含圈子隔离、跨圈管理员越权、邀请转发后审批前隔离、并发一次使用、到期与撤销、角色调整与圈主移交、成员退出、字段隐私、城市代表点校验与过滤、照片上传与签名、成员移除、代维护授权、认领审批、同学圈本人卡及关联卡删除保护。

本地自动化测试不需要 AppID，测试使用内存仓库和模拟账号 ID。CloudBase SDK 适配器、真实微信 OPENID、数据库安全规则、云存储及实际并发事务仍须在云开发环境就绪后做端到端验证。云端照片压缩和上传也需要真机验证。当前没有实现推送通知、圈子解散与数据导出保留期限；这些事项需在上线前按产品决定补齐。地图选点由前端原生地图完成，后端校验坐标、取整并按城市权限过滤；中文称呼由独立模块计算。
