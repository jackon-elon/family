# 亲友关系网后端设计（本地版）

版本：0.2；对应需求文档讨论稿 0.6。此文档描述本地服务与云函数接线，并标明接入微信云开发后的验证边界。已有测试小程序 AppID，尚无云开发环境，因此云端行为尚未实测。

## 1. 架构与边界

小程序只调用一个事件型云函数 `api`，请求格式为 `{action, payload}`。云函数从微信运行时取得 `OPENID`，将其作为账号标识交给 `ApiService`；客户端传来的 `userId`、角色或 `claimedBy` 均不参与鉴权。`ApiService` 依赖 `Repository` 接口，本地测试用 `MemoryRepository`，云端拟用 `CloudBaseRepository`。关键写操作使用数据库事务。人物照片存云存储，人物文档只保留 `photoFileId`；人物视图仅以 `hasPhoto` 告知可否查看，不向客户端返回原始文件 ID。临时链接经 `photo.url`／`photo.urls` 逐人鉴权后签发。

返回值统一为 `{ok:true,data:{...}}` 或 `{ok:false,error:{code,message}}`。服务端错误只返回通用信息，不把数据库异常、令牌摘要和堆栈传给客户端。所有日期均为 Unix 毫秒时间戳。

家庭圈和同学圈都以 `circleId` 分区。每个圈子固定 `type: family | classmate`；同学圈必须有学校、届别和班级，服务端禁止在同学圈建立亲属关系。成员身份由 `circleId + OPENID` 的确定性文档 ID 确定；每个已加入账号在每圈最多认领一张人物卡。圈内查询先检查 active membership，再读取该圈的数据，不接受跨圈 ID 混用。

## 2. 数据模型

- `circles`：圈子类型、名称、`private/shared` 维护模式、圈主、班级信息。
- `members`：圈子、账号、申请时提供的显示姓名、`owner/admin/member` 角色、`active/left/removed` 状态、本人卡 ID。圈主尚无本人卡时暂显示“圈主”；认领人物卡后列表优先显示卡片的最新姓名。
- `persons`：圈内人物卡、基础关系信息、可选资料、可选的城市代表点 `latitude/longitude`、每字段可见范围、内部认领账号、关系连接计数。代表点取整到 0.1 度；手动选点来自小程序原生地图的 GCJ-02 坐标，常见城市使用预设近似中心。不记录实时定位或住址。
- `relations`：仅家庭圈使用。`parent` 为 `from` 父母到 `to` 子女的有向边；`spouse` 和 `sibling` 为无向关系，`olderId` 可标记兄弟姐妹中的较长者。人物 `birthOrder` 是同父母、同性别兄弟姐妹中的排行，用于“大姨／二姨”等称呼；两人长幼优先取 `olderId`。
- `invites`：邀请码哈希、创建人、72 小时到期时间、撤销和一次性使用状态。原始令牌仅在创建响应中给管理员一次。
- `applications`：加入申请、身份核对说明、审批状态；申请阶段不选人物卡。
- `claimRequests`：已加入成员认领现有未认领卡的申请。
- `delegations`：已认领人物本人对某位管理员授权的字段列表及撤销时间。
- `suggestions`：成员提交人物、关系或邀请建议；关系建议保存结构化的新增／删除／替换边及原边指纹，供管理员预览和原子采纳。
- `audit`：邀请、审批、角色、成员、人物、关系、授权等关键操作记录；关系更正记录删除和创建的边摘要。
- `photoUploadBudgets`：按微信账号记录照片上传尝试的 24 小时滚动配额，仅云函数内部更新，限制连续上传造成的存储费用。

本地 `MemoryRepository.atomic` 串行执行并在失败时丢弃本次变更。CloudBase 适配器以事务保护确定性 ID 的成员文档、人物卡和邀请码文档；同一邀请的两次审批均须在事务里读写同一 `invites/{id}`，只有一个能提交。关系边按圈子、类型和端点生成确定性 ID；关系变更在事务内更新圈子文档和相关人物连接计数，让同圈写入发生冲突时重试或失败，避免两个并发编辑各自依据旧图提交。关系图扫描用于计算变更计划和冲突；CloudBase 事务内的集合列表查询仍受 SDK 限制，云端真实并发行为须实测。CloudBase 文档型数据库事务要求在服务端运行且事务内只使用 `doc(id)` 操作，因此列表查询用事务外的 `where`；决定权限和冲突的文档仍在事务内按 ID 读取。事务冲突会使请求失败，前端可刷新后重试。参考[腾讯云事务文档](https://docs.cloudbase.net/database/transaction)。

## 3. 权限与资料可见性

- **未加入者**：可凭令牌调用 `invite.preview`，看到圈名、类型及班级识别信息；有效令牌可申请加入，也可凭自己的微信身份调用 `join.mine` 查看本人申请状态。审批前不能读人物、地图、关系或联系方式。
- **成员**：能读本圈经过字段过滤的人物和关系；能编辑自己已认领的资料与可见范围、申请认领现有卡、提交建议、退出圈子。
- **管理员**：能邀请、审批、维护未认领卡的姓名等最少字段、建立和删除关系、处理建议、移除普通成员。管理员身份不能越过他人对联系方式、照片和城市设置的可见范围。
- **圈主**：拥有管理员权限，还能任免管理员、移交圈主、开启共建。圈主不能被移除，退出前须先移交。

人物的姓名、昵称、性别和排行属于建立关系网所需的基础字段。其他可选字段默认仅本人可见；国家／省份／城市及城市代表点共用 `city` 可见性设置，手机号和微信号分别设置，照片单独设置。读取 `person.list/get` 时，未授权字段在 JSON 中直接省略。服务端要求经纬度同时填写或同时清除、处于有效范围且有城市名称；修改地点名称但未重选坐标时清除旧坐标，避免把旧城位置误标到新城。服务端只保证坐标格式和城市级精度，城市名称与选点是否相符仍由填写者确认。未认领卡只能由管理员填写基础字段，不能代填电话或城市。本人退出或被移除后，账号立即失去成员权限，已认领卡解除绑定、清空私人资料并保留姓名与关系节点；有效代维护授权一并撤销。

授权代维护只能由人物卡本人发起，对象必须是本圈活跃管理员，字段需逐项选择；选择 `city` 同时允许维护国家、省份、城市及经纬度，`person.get` 的 `myDelegatedFields` 也会返回这些字段供前端编辑。受托人在 `person.get` 中可读已授权字段的当前值，方便编辑；`person.list` 和无授权成员仍按可见范围过滤。受托人不可修改 `visibility`。授权人可随时撤销；管理员降级、退出或被移除时授权随即失效。授权记录和代维护操作均写入审计。管理员对已认领人物卡的普通修改没有特权。

## 4. 接口契约

以下请求都经 `invoke({action,payload})` 调用，`circleId` 仅作为资源定位参数，不赋予访问权。响应中的 `person` 经过字段过滤；`isSelf`、`isClaimed` 可用于页面显示，`claimedBy`、圈主与成员 OPENID、邀请码哈希永不随圈子或人物接口返回。

### 圈子与成员

- `circle.create`：`{type,name,mode,school?,cohort?,className?,requestId?}` → `{circle}`，创建者为圈主；同学圈后三项必填。客户端为一次创建生成稳定 `requestId`，响应丢失后用同一 ID 重试会返回原圈子，参数不同则报冲突。
- `circle.list`：`{}` → `{circles:[...circle,role,memberCount]}`，只列本人活跃圈子。
- `circle.detail`：`{circleId}` → `{circle,role}`。
- `circle.upgrade`：`{circleId,privacyReviewed:true}` → `{circle}`，圈主确认历史资料可见性后由 private 升级 shared。
- `circle.transferOwner`：`{circleId,memberId}` → `{circle,member}`，旧圈主变管理员。
- `member.list`：`{circleId}` → `{members:[{id,name,role,status,personId?,isSelf,...}]}`，仅活跃成员；姓名优先取本人卡最新名称。
- `member.setRole`：`{circleId,memberId,role:'admin'|'member'}` → `{member}`，仅圈主。
- `member.remove`：`{circleId,memberId}` → `{member}`，上级管理员只能移除较低角色。
- `member.leave`：`{circleId}` → `{member}`，圈主不可直接退出。

### 人物与照片

上传后绑定失败时，云函数核对 `deleteFile` 返回的目标文件逐项状态；即使删除调用正常返回，只要目标文件未确认成功删除，就不会返还本次上传额度。

- `person.list`：`{circleId}` → `{persons:[person]}`；地图和列表使用同一响应，因此隐藏城市不会进入地图人数。
- `person.get`：`{circleId,personId}` → `{person}`；本人额外得到 `visibility` 和活跃 `delegations`；受托管理员得到 `myDelegatedFields`。
- `person.create`：`{circleId,name,nickname?,gender?,birthOrder?,claimSelf?,requestId?}` → `{person}`。管理员可创建未认领卡；尚无本人卡、也无待审认领申请的已加入成员可用 `claimSelf:true` 创建并认领自己的新卡。普通成员不能创建他人卡。同一 `requestId` 可安全重试原创建请求，参数不同或原认领状态已改变时返回明确冲突。
- `person.update`：`{circleId,personId,patch:{...},visibility?:{field:'self'|'circle'}}` → `{person}`。本人可编辑并设可见性；管理员对未认领卡仅可改基础字段；受托管理员仅可修改授权字段。公开接口拒绝绑定非空 `photoFileId`，照片须经 `photo.upload`；本人可传 `photoFileId:null` 清除现有照片关联。
- `person.delete`：`{circleId,personId}` → `{personId}`。只能删除未认领、无关系连接的卡；有关系时返回 `RELATION_CONNECTED` 和关联数量说明。
- `person.claim`：`{circleId,personId}` → `{claimRequest}`，仅已加入且尚无本人卡的成员可提出申请；管理员用 `person.claimList` 查看含 `applicantName` 的待审请求，再用 `person.claimApprove`、`person.claimReject`（后两者 `{circleId,claimRequestId}`）核对后绑定。加入申请不能携带 `claimPersonId`，加入审批也不绑定人物卡。
- `person.claimMine`：`{circleId}` → `{claimRequests}`，仅返回当前成员在此圈的认领申请及人物名称，供本人查看待审、通过和拒绝状态。
- `person.unclaim`：`{circleId,personId}` → `{person}`，管理员纠正误认领；解绑账号、清除该卡私人资料、撤销代维护授权并留审计记录。
- `photo.upload`：`{circleId,personId,base64,visibility?}` → `{person}`。小程序将选中图片重编码为 1 MiB 以内的 JPEG；云函数进一步校验 JPEG 结构、宽高与像素上限，并剥离 EXIF、XMP、注释等 APP/COM 元数据，防止照片原文件泄露精确定位与拍摄信息。鉴权后按微信账号的 24 小时配额窗口限制最多 20 次上传尝试，超过时返回 `PHOTO_UPLOAD_LIMIT`；仅内部上传入口扣减配额。服务端上传到 `photos/<SHA-256(circleId|OPENID) 前 40 位>/<UUID>.jpg`。本人上传时，新照片与所选可见范围在内部事务中绑定；旧客户端未传可见范围则默认仅自己可见。受托管理员不能更改可见范围。绑定时重新核对成员和授权，若权限已变更，会尝试删除刚上传的文件；确认删除成功后退回此次配额。上传路径申请和照片绑定均为云函数内部方法，旧 `photo.uploadPath` 已从公开动作移除。人物视图和照片路径均不暴露原始 OPENID。
- `photo.url`：`{circleId,personId}` → `{url}`，先检查本圈成员与照片可见性；拥有有效 `photoFileId` 代维护授权的管理员也可查看该照片。鉴权事务提交后再签发短时链接。
- `photo.urls`：`{circleId,personIds:[...]}` → `{urls:{personId:url}}`，每次最多 20 人，逐人执行相同的可见性检查，再批量签发链接；无权或无照片的人不会出现在结果中，响应不含文件 ID。

资料 `patch` 可用字段：`name,nickname,gender,birthOrder,country,province,city,latitude,longitude,status,school,industry,occupation,bio,phone,wechatId`，以及用于清除照片的 `photoFileId:null`；公开接口不接受新照片文件 ID。可设置可见性的字段：`city,status,school,industry,occupation,bio,phone,wechatId,photoFileId`。`country/province/city/latitude/longitude` 一起按 `city` 权限过滤；`latitude/longitude` 不作为单独的代维护授权项。

### 关系、邀请、审批与授权

- `relation.list`：`{circleId}` → `{relations}`，仅家庭圈活跃成员可读。
- `relation.preview`：`{circleId,relationChange:{removeRelationId?,relation?:{from,to,type,olderId?}}}` → `{impact,before?,after?}`。成员可预览结构化建议，管理员可在新增、删除或替换前核对；不落库。`impact` 包含删除／新增的关系 ID 和可能受影响的人物 ID，范围按相关连通部分计算，不是逐人称呼差异清单。
- `relation.create/replace/delete`：分别传 `{circleId,from,to,type,olderId?}`、`{circleId,relationId,relation:{from,to,type,olderId?}}`、`{circleId,relationId}`；只有管理员可修改，且仅家庭圈。新增和替换会校验互斥边、亲子环及确定的代际矛盾；删除可用于清理旧图。修改写入前后关系摘要及操作原因。
- `invite.create`：`{circleId}` → `{invite:{id,token,expiresAt,status}}`，仅共建圈管理员。`token` 是 32 字符 base64url 字符串，可放入小程序码 `scene`；微信卡片和二维码必须承载**同一个 token**，不能各生成一份。
- `invite.code`：云函数外层路由接收 `{circleId,token}`。先以当前 OPENID 调用管理员专用的 `invite.list` 做权限校验，再核实 token 属于此圈且仍有效，最后调用微信小程序码接口，固定落地页为 `pages/apply/index`，以同一 token 作为 `scene`，返回 PNG 的 base64。演示适配器不提供真码；真实调用须在已绑定小程序的 CloudBase 环境验证。
- `invite.preview`：`{token}` → `{circle,expiresAt,status}`，凭有效令牌可在入圈前查看有限圈信息，不含成员信息；`join.mine` 另允许申请人按自己的微信身份查询本人申请。
- `invite.apply`：`{token,name,note?}` → `{application}`。同学圈 `note` 必填，家庭圈可选；旧客户端若传 `claimPersonId`，服务端拒绝。申请人最多看到自己的申请响应。
- `invite.list/revoke`：`{circleId}`、`{circleId,inviteId}`，仅管理员；列表不返回原始 token。
- `join.list`：`{circleId}` → `{applications}`；`join.approve/reject`：`{circleId,applicationId}` → `{application}`，仅管理员。批准时再次检查邀请到期／撤销／已用状态，并原子建立成员资格，但不创建或认领人物卡。多人用一份邀请码申请时，仅一人可获批准；其余申请标记过期。
- `join.mine`：`{}` → `{applications,hasMore}`，申请人查看最近 20 份自己的申请、圈名／类型及处理状态；`{applicationId}` 精确查询本人某一份申请，供状态页使用。待审申请若对应邀请已失效，响应显示失效状态，不返回别人的申请。
- `delegation.grant`：`{circleId,personId,adminMemberId,fields:[...]}` → `{delegation}`，只有已认领人物本人可授权。
- `delegation.revoke`：`{circleId,delegationId}` → `{delegation}`，只有授权人可撤销。
- `suggestion.create/list/resolve`：创建 `{circleId,type:'person'|'relation'|'invite',personId?,message,relationChange?}`；关系建议必须带结构化 `relationChange`。管理员处理 `{circleId,suggestionId,status:'accepted'|'rejected'}`。采纳关系建议时按原边指纹检查是否过期，再于同一事务更新关系、建议状态和审计；冲突时仍为待处理。人物和邀请类建议不能只点击「已采纳」而不做实际操作；旧纯文字关系建议也不能直接采纳，可以拒绝并请成员重提具体更正。
- `audit.list`：`{circleId}` → `{events}`，仅管理员，最近 100 条；返回操作者名称、时间、动作与安全的改动摘要，不返回 OPENID。成员不可查其他人的管理记录。

## 5. 邀请与认领状态

邀请码由随机 24 字节编码为 32 字符 base64url 字符串。服务端以 SHA-256 摘要作邀请文档 ID 和校验值，不存原始 token；链接有效期为创建后 72 小时，管理员可随时撤销。展示、申请和审批分别检查状态；审批以当前服务端时间再检查一次，避免“申请时有效、审批时已过期”绕过。被转发的人只能提交身份说明，管理员核对后再批准。同学圈的“是否同班”由管理员依据学校、届别、班级及申请说明人工核对，服务无法自动证明现实身份。

一张人物卡只能有一个 `claimedBy`。同名、相同手机号都不会自动绑定。加入审核只授予圈内成员资格；成员进入圈子后核对已有卡，独立申请并经管理员审批认领，或在确认无卡时新建本人卡。成员有待审认领时，服务端拒绝其新建本人卡；并发认领、新建的相互冲突须由事务阻止。一张人物卡的并发认领会同时写同一人物文档，至多一方提交成功。误认领由管理员解绑，清空照片、地点、联系方式等私人字段并撤销代维护授权，关系节点保留；当前没有恢复已清空内容的入口。

## 6. 云开发安全配置与部署前置

**数据库**：对 `circles,members,persons,relations,invites,applications,claimRequests,delegations,suggestions,audit,photoUploadBudgets` 每个集合设置自定义安全规则 [database-deny-client.json](../cloudfunctions/security/database-deny-client.json)，禁止小程序客户端直接读写原始文档。云函数使用环境范围数据库客户端操作数据，再由 `ApiService` 逐请求过滤。默认开放数据库读权限会泄露隐藏字段、邀请摘要及 OPENID，因此不能发布。

CloudBase [事务限制](https://docs.cloudbase.net/database/transaction)为单次最多 100 个文档操作、30 秒，且事务内仅支持 `doc` 操作。服务将列表所需的关联姓名按圈批量读取，把安全关键的成员、邀请等确定 ID 留在事务内校验；批量撤销授权最多处理 80 条，超过时在写入前报 `DATA_LIMIT`。当前圈列表最多支持一人 80 个圈；仓库查询遇到超过 5000 条匹配记录时明确报 `DATA_LIMIT`，不会悄悄返回不完整数据。更大规模需要分页和批处理设计。正式建库时还应按各 `where` 条件及 `_id` 排序配置索引，参考[CloudBase 索引指南](https://docs.cloudbase.net/database/data-index)。

**云存储**：设置 [storage-deny-client.json](../cloudfunctions/security/storage-deny-client.json) 为客户端读写均拒绝。照片仅经云函数 `photo.upload` 服务端上传，上传前做成员、本人／授权、JPEG 结构及 1 MiB 大小校验、元数据剥离和账号配额检查。小程序不能调用 `wx.cloud.uploadFile` 直传，以免未入圈用户占用存储额度。跨成员照片展示通过 `photo.url` 或每批最多 20 人的 `photo.urls`，由云函数在权限校验后签发暂设 60 秒有效的临时 URL；已经签发的 URL 在到期前可能仍被持有者访问，因此移除成员后的照片访问不能仅靠前端清缓存声称瞬时撤回。上线前须在真实环境验证私有文件的服务端上传、签发、链接有效期与删除流程。还需配置资源费用告警和孤儿文件清理；同一文件可能仍被其他人物卡引用，不能在换照片或移除成员时直接删除旧文件。物理清理需在云端建立引用核对和安全回收流程后实现。请求内传 base64 会增加流量，已用 1 MiB 限制控制单次成本。

**函数**：可参考 [function-api-only.json](../cloudfunctions/security/function-api-only.json)，只开放 `api` 给已登录调用者。**上线硬门槛：`api` 只能由已绑定的小程序通过事件调用，禁用 HTTP、Web、定时器、数据库触发器及其他来源调用同一函数。**身份来源是 `wx.cloud.callFunction` 的 `OPENID`；腾讯云文档指出混合调用来源时 `getWXContext()` 可能因实例复用残留上一位用户身份，函数安全规则 `auth != null` 本身不能证明来源。未来增加其他端时须拆分入口或采用能够验证调用来源的可信上下文身份方案，不能沿用此入口。参考[云函数实例复用说明](https://docs.cloudbase.net/cloud-function/instance)。不要在客户端直连数据库或存储做越权查询。安全规则在真实环境中需要逐项检查生效情况，不能只因本地测试通过就发布。

**小程序码**：`invite.code` 使用云函数内的 `cloud.openapi.wxacode.getUnlimited`；管理员必须持有当前有效邀请的原始 token 才能生成。`scene` 为一次性 token，微信分享卡片与扫码落地页均走 `invite.preview` 和 `invite.apply`，最终由同一条 `join.approve` 消耗邀请。云函数只接受有效 PNG，并对返回大小设上限。可用 `WX_CODE_ENV_VERSION` 指定 `develop`／`trial`／`release`，默认 `release`；联调时需按开发版本设置，且确保小程序已绑定云环境。接口代码与模拟 SDK 测试不等于真实微信开放接口已成功，必须真机扫码验证。

部署顺序：创建微信小程序账号和云开发环境、绑定 AppID；创建十一个数据库集合并逐个配置拒绝客户端访问规则；配置云存储和函数规则；在项目根目录执行 `npm run build:cloud`（编译后端并复制产物到 `cloudfunctions/api/lib`）；**从根目录的 `project.config.json` 打开微信开发者工具项目**，其 `miniprogramRoot` 为 `miniprogram/`、`cloudfunctionRoot` 为 `cloudfunctions/`，然后上传 `api` 云函数，或在有权限的环境用 CloudBase CLI 将 `cloudfunctions/api` 部署为事件型函数 `api`；再用真实测试账号验证权限、邀请和照片。当前 `cloudfunctions/api/package.json` 指定 `wx-server-sdk`，部署时安装云端依赖。不要只打开 `miniprogram/project.config.json`，那样云函数目录不在项目根下。参考[微信小程序调用云函数](https://docs.cloudbase.net/recipes/add-cloud-function-wechat-miniprogram)、[安全规则](https://docs.cloudbase.net/rule/rule-example)。

## 7. 本地验证与未完成事项

在项目根目录运行 `npm run test:backend`，会先编译 TypeScript，然后运行 Node 自带测试。测试包含圈子隔离、跨圈管理员越权、邀请转发后审批前隔离、并发一次使用、到期与撤销、加入后独立认领、待审认领与新建本人卡冲突、角色调整与圈主移交、成员退出、字段隐私、城市代表点校验与过滤、照片上传与签名、成员移除、代维护授权、关系预览／替换／冲突、结构化建议的原子采纳和审计，以及小程序码路由的模拟 SDK 校验。

本地自动化测试不需要 AppID，测试使用内存仓库和模拟账号 ID。CloudBase SDK 适配器、真实微信 OPENID、数据库安全规则、云存储、真实小程序码及实际并发事务仍须在云开发环境就绪后做端到端验证。云端照片压缩和上传也需要真机验证。当前没有实现主动通知、操作撤销或恢复、圈子解散与数据导出保留期限、复杂再婚／收养／继亲关系类型和重复人物卡合并；这些事项需按产品上线范围决定补齐。地图选点由前端原生地图完成，后端校验坐标、取整并按城市权限过滤；中文称呼由独立模块计算。
