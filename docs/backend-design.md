# 亲友关系网后端设计（本地版）

版本：0.3；对应需求文档讨论稿 0.8。此文档描述本地服务与云函数接线，并标明接入微信云开发后的验证边界。已有测试小程序 AppID，尚无云开发环境，因此云端行为尚未实测。

## 1. 架构与边界

小程序只调用一个事件型云函数 `api`，请求格式为 `{action, payload}`。云函数从微信运行时取得 `OPENID`，将其作为账号标识交给 `ApiService`；客户端传来的 `userId`、角色或 `claimedBy` 均不参与鉴权。`ApiService` 依赖 `Repository` 接口，本地测试用 `MemoryRepository`，云端拟用 `CloudBaseRepository`。关键写操作使用数据库事务。人物照片存云存储，人物文档只保留 `photoFileId`；人物视图仅以 `hasPhoto` 告知可否查看，不向客户端返回原始文件 ID。临时链接经 `photo.url`／`photo.urls` 逐人鉴权后签发。

返回值统一为 `{ok:true,data:{...}}` 或 `{ok:false,error:{code,message}}`。服务端错误只返回通用信息，不把数据库异常、令牌摘要和堆栈传给客户端。所有日期均为 Unix 毫秒时间戳。

家庭圈和同学圈都以 `circleId` 分区。每个圈子固定 `type: family | classmate`；同学圈必须有学校、届别和班级，服务端禁止在同学圈建立亲属关系。成员身份由 `circleId + OPENID` 的确定性文档 ID 确定；每个已加入账号在每圈最多认领一张人物卡。圈内查询先检查 active membership，再读取该圈的数据，不接受跨圈 ID 混用。

## 2. 数据模型

- `circles`：圈子类型、名称、`private/shared` 维护模式、圈主、班级信息。
- `members`：圈子、账号、申请时提供的显示姓名、`owner/admin/member` 角色、`active/left/removed` 状态、本人卡 ID。圈主尚无本人卡时暂显示“圈主”；认领人物卡后列表优先显示卡片的最新姓名。
- `persons`：圈内人物卡、生日历法和月日、城市及可选的城市代表点 `latitude/longitude`、内部认领账号、关系连接计数。已关联人物可有本记录的管理员更正覆盖层，读取时与账号资料合并，但更正不能写入账号资料或其他记录；本人后来修改同字段时，旧更正失效。管理员可为尚未关联账号的完整资料填私有 `matchPhone`，它不同于圈内可见的联系号码 `phone`，绝不由 `person.list/get` 返回。历史资料保留旧 `visibility` 字段以便迁移，读取时不再按它筛选。代表点取整到 0.1 度，不记录实时定位或住址。
- `relations`：仅家庭圈使用。`parent` 为 `from` 父母到 `to` 子女的有向边；`spouse` 和 `sibling` 为无向关系，`olderId` 可标记兄弟姐妹中的较长者。人物 `birthOrder` 是同父母、同性别兄弟姐妹中的排行，用于“大姨／二姨”等称呼；两人长幼优先取 `olderId`。
- `invites`：邀请码哈希、创建人、72 小时到期时间、撤销和一次性使用状态。原始令牌仅在创建响应中给管理员一次。
- `applications`：加入申请时从账号唯一资料提取的姓名、城市与生日快照、身份核对说明、审批状态；申请人不能选择已有卡，管理员在批准时明确选择新卡或已有未关联卡。
- `claimRequests`：已加入成员认领现有未认领卡的申请。
- `delegations`：已认领人物本人对某位管理员授权的字段列表及撤销时间。
- `suggestions`：成员提交人物、关系或邀请建议；关系建议保存结构化的新增／删除／替换边及原边指纹，供管理员预览和原子采纳。
- `audit`：邀请、审批、角色、成员、人物、关系、授权等关键操作记录；关系更正记录删除和创建的边摘要。
- `photoUploadBudgets`：按微信账号记录照片上传尝试的 24 小时滚动配额，仅云函数内部更新，限制连续上传造成的存储费用。
- `phoneMatches`：按圈子与标准化手机号生成确定性 ID，同一圈一个号码最多指向一张尚未关联的人物卡。只允许云函数读写。
- `phoneIdentities`：用户主动授权后，由云函数用微信一次性 `code` 换取并保存的已验证号码及验证时间。90 天后需重新授权才能继续匹配后续新卡；不会把号码当圈内联系方式公开。
- `userProfiles`：按微信账号的确定性 ID 保存唯一的本人资料。本人修改姓名、头像、城市、生日、学校、行业、联系方式等在这里保存；每个家庭／同学人物卡仍独立保留关系节点、`birthOrder` 和本记录的管理员更正。已关联人物卡默认读账号资料，按本记录覆盖层展示有效的管理员更正。管理员预录卡和手机号匹配不得把资料回填到账号主资料。`matchPhone` 与已验证登录号码都不进入这份公开个人资料。
- `personRemarks`：当前用户对当前记录中某位人物的私人备注，独立保存 `userId/circleId/personId/remark`，不并入人物公开资料或账号主资料。读取及修改始终以服务端调用者为准；管理员也不能读取别人的备注，客户端禁止直接读写该集合。

本地 `MemoryRepository.atomic` 串行执行并在失败时丢弃本次变更。CloudBase 适配器以事务保护确定性 ID 的成员文档、人物卡和邀请码文档；同一邀请的两次审批均须在事务里读写同一 `invites/{id}`，只有一个能提交。关系边按圈子、类型和端点生成确定性 ID；关系变更在事务内更新圈子文档和相关人物连接计数，让同圈写入发生冲突时重试或失败，避免两个并发编辑各自依据旧图提交。关系图扫描用于计算变更计划和冲突；CloudBase 事务内的集合列表查询仍受 SDK 限制，云端真实并发行为须实测。CloudBase 文档型数据库事务要求在服务端运行且事务内只使用 `doc(id)` 操作，因此列表查询用事务外的 `where`；决定权限和冲突的文档仍在事务内按 ID 读取。事务冲突会使请求失败，前端可刷新后重试。参考[腾讯云事务文档](https://docs.cloudbase.net/database/transaction)。

## 3. 权限与资料可见性

- **未加入者**：可凭令牌调用 `invite.preview`，看到圈名、类型及班级识别信息；有效令牌可申请加入，也可凭自己的微信身份调用 `join.mine` 查看本人申请状态。审批前不能读人物、地图、关系或联系方式。
- **成员**：能读本圈人物、照片与关系；能编辑自己已认领的资料、申请认领现有卡、提交建议、退出圈子。圈外账号不能读本圈资料。
- **管理员**：能邀请、审批、编辑本记录内任何人物的资料与关系、处理建议、移除普通成员。已关联人物的资料更正仅作用于本记录，不能修改该账号主资料或其他记录。
- **圈主**：拥有管理员权限，还能任免管理员、移交圈主、开启共建。圈主不能被移除，退出前须先移交。

人物卡的 `profileComplete` 由姓名、国家或地区、城市、生日月日和历法决定。管理员和成员新建人物卡时都必须一次提交完整资料；旧空卡仍可供管理员补录并留在关系网，以免切断历史关系；生日事件只纳入完整卡，地图对缺坐标卡另标为待定位。已完整的卡不能通过普通更新清空上述必需字段。入圈申请则必须先填完整资料，不能带空卡入圈。圈内活跃成员读同一份资料和照片；服务端仍逐次检查成员资格，不返回原始照片文件 ID。经纬度须成对且处于有效范围，修改城市但未重选坐标会清除旧坐标。本人退出或被移除后，账号立即失去成员权限，已认领卡解除绑定并清除生日、地点、联系方式和照片，保留姓名与关系节点；有效代维护授权一并撤销。

本人只在“我的资料”编辑 `userProfiles` 一份资料；更改后所有已关联家庭／同学人物卡读取新值。管理员通过 `person.update` 修改已关联卡时写当前人物卡的覆盖层，不写 `userProfiles`；该圈成员看到更正，其他圈和账号资料不变。本人后来修改相同字段时，旧覆盖失效，以本人新值显示。无已关联人物卡也可先填资料、上传头像。预录人物关联时不能自动将管理员填写的字段回填到本人账号资料。退出或移除只清理该记录的人物卡与覆盖层，不删除账号资料或影响其他记录。

历史客户端的逐字段代维护接口仍可读写旧授权记录，但当前管理页不以授权作为管理员编辑本记录人物的前置条件。管理员编辑仍须通过服务端角色检查并记录审计；普通成员不能因此编辑他人。

## 4. 接口契约

以下请求都经 `invoke({action,payload})` 调用，`circleId` 仅作为资源定位参数，不赋予访问权。响应中的 `person` 经过字段过滤；`isSelf`、`isClaimed` 可用于页面显示，`claimedBy`、圈主与成员 OPENID、邀请码哈希永不随圈子或人物接口返回。

### 圈子与成员

- `circle.create`：`{type,name,mode,school?,cohort?,className?,requestId?}` → `{circle}`，创建者为圈主；同学圈后三项必填。客户端为一次创建生成稳定 `requestId`，响应丢失后用同一 ID 重试会返回原圈子，参数不同则报冲突。
- `circle.list`：`{}` → `{circles:[...circle,role,personCount,memberCount]}`，只列本人活跃记录。`personCount` 是已录入的人物资料数（不要求本人登录），供首页展示，与人物列表一致；`memberCount` 是有访问权的账号数，仅供管理逻辑使用。`circle.create/detail` 也返回两种计数。
- `circle.detail`：`{circleId}` → `{circle,role,ownerTransfer}`。仅当前圈主与本次移交接收方可见待办 `{id,targetMemberId,targetName,expiresAt,isTarget,isOwner}`；其他成员得到 `null`，圈子列表与公开预览不返回待办。
- `circle.upgrade`：`{circleId,privacyReviewed:true}` → `{circle}`，圈主确认历史资料可见性后由 private 升级 shared。
- `circle.transferOwner`：`{circleId,memberId}` → `{ownerTransfer}`，仅当前圈主发起 72 小时待接收请求，发起时角色不变；已有未过期请求须先取消。
- `circle.acceptOwnerTransfer`：`{circleId,transferId}` → `{circle,member}`，仅指定的活跃接收成员可确认；同一事务中将其设为新圈主、原圈主变管理员并清除待办。过期、成员资格改变或旧 `transferId` 均拒绝。
- `circle.cancelOwnerTransfer`：`{circleId,transferId}` → `{transferId,status}`，原圈主可撤销，接收方可拒绝；接收方退出或被移除时自动撤销。
- `member.list`：`{circleId}` → `{members:[{id,name,role,status,personId?,isSelf,...}]}`，仅活跃成员；姓名优先取本人卡最新名称。
- `member.setRole`：`{circleId,memberId,role:'admin'|'member'}` → `{member}`，仅圈主。
- `member.remove`：`{circleId,memberId}` → `{member}`，上级管理员只能移除较低角色。
- `member.leave`：`{circleId}` → `{member}`，圈主不可直接退出。

### 人物与照片

上传后绑定失败时，云函数核对 `deleteFile` 返回的目标文件逐项状态；即使删除调用正常返回，只要目标文件未确认成功删除，就不会返还本次上传额度。

- `account.profile.get`：`{}` → `{profile:null|{name?,nickname?,gender?,birthday?,country?,province?,city?,latitude?,longitude?,status?,school?,industry?,occupation?,bio?,phone?,wechatId?,hasPhoto,profileComplete,updatedAt},photoUploadTarget?}`。仅返回当前微信账号；旧已关联卡在首次读取时迁移。`photoUploadTarget` 只是兼容旧照片上传入口的本人卡定位，公开资料不含原始文件 ID。
- `account.profile.update`：`{patch:{...}}` → `{profile}`。首次登录可逐步填写；已完整的账号资料不能清空姓名、城市或生日。`birthOrder` 属于单个家庭关系节点，不在此编辑；非空 `photoFileId` 不可直接提交，照片走 `photo.upload`，传 `photoFileId:null` 可清除头像关联。

- `person.list`：`{circleId}` → `{persons:[person]}`，包含旧空卡；每卡有 `profileComplete` 和 `hasMapLocation`，便于界面说明“待补录／待定位”。圈内字段一致。
- `person.get`：`{circleId,personId}` → `{person}`；本人额外得到活跃 `delegations`，受托管理员得到 `myDelegatedFields`。
- `person.create`：`{circleId,name,country,city,birthday,province?,latitude?,longitude?,nickname?,gender?,birthOrder?,claimSelf?,matchPhone?,initialRelation?,requestId?}` → `{person}`。生日格式为 `{calendar:'solar'|'lunar',month,day,year?,leapMonth?}`，月日必填、年份可省略。管理员和成员新建卡时均须提交国家或地区、城市和生日；缺项报 `PROFILE_INCOMPLETE`。普通成员只能建立本人卡。管理员可在预录他人资料时填 `matchPhone`，中国大陆号码可直接填 11 位，其他地区需加国家区号；`claimSelf` 不能携带此字段。同圈重复号码报 `PHONE_ALREADY_USED`。仅历史已存在的空卡可通过 `person.update` 补录。同一 `requestId` 可安全重试，改参数报冲突。

  家人录已有其他人物时，必须传 `initialRelation:{anchorPersonId,kind,older?}`。`anchorPersonId` 指向本记录已有的任何人物资料，不要求该人登录；`kind` 可选 `newParent`（新人是对方父母）、`newChild`（新人是对方子女）、`spouse`、`sibling`，兄弟姐妹的 `older` 可选 `unknown/new/anchor`。服务端在同一事务内创建人物和关系，关系冲突时二者都不保存。第一位人物可以不填关系。具体称呼根据事实关系边和查看者的本人节点计算，不在创建时写死“伯父”“姨妈”等称呼。
- `person.update`：`{circleId,personId,patch:{...},matchPhone?:string|null}` → `{person}`。本人可编辑自己的账号字段；管理员可直接编辑本录人物，已关联人物的更正写本录覆盖层，不传播到对方账号或其他记录。`matchPhone` 是 `patch` 之外的私有字段，只有管理员能为尚未关联且资料完整的卡设置、更正或清除。旧客户端传入的 `visibility` 被忽略，不再改变圈内可见性。公开接口拒绝绑定非空 `photoFileId`，照片须经 `photo.upload`；照片清除传 `photoFileId:null`。
- `person.matchPhone`：`{circleId,personId}` → `{matchPhone?}`。仅本圈管理员可读取尚未关联卡的私有匹配号码；普通成员和圈外账号不可读。
- `account.verifyPhone`：`{code}` 只由云函数外层路由处理；从微信手机号授权按钮取得一次性 `code`，云函数调用 `cloud.openapi.phonenumber.getPhoneNumber`，再把微信返回的号码传给后端内部 `linkVerifiedPhone`。客户端提供的 `phone`、`verifiedPhone` 或普通 `ApiService.invoke` 同名操作均不能完成关联。响应 `{hasVerifiedPhone,linked:[{circleId,personId}],alreadyLinked:[...],skipped}`，不返回号码。号码相同不能单独创建成员资格。
- `account.sync`：`{}` → 同上；只使用服务端保存且近 90 天内验证过的号码，在打开首页或“我的”时帮助已获准加入本录且尚无本人卡的账号匹配预录人物。未邀请、未申请或未获准加入的账号不能因号码相同而获得访问权，也不能使其账号资料投射到该录。无有效验证时 `hasVerifiedPhone:false`，不改变任何成员资格。
- `birthday.upcoming`：`{circleId?,days?:number}` → `{events:[{personId,personName,circleId,circleName,date,daysUntil,birthdayCalendar,birthdayText}]}`。不传 `circleId` 时汇总本人最多 40 个活跃记录，超过时需按记录查询；服务会重新读取每份成员资格。`days` 默认为 30、范围 0 至 366；`date` 为中国时区对应的下次公历日期。排除当前登录者自己的生日；同一已关联账号出现在多个记录时汇总只显示一次。农历使用项目内置的[香港天文台 1901–2100 年公农历对照表](https://www.hko.gov.hk/tc/gts/time/conversion1_text.htm)换算，前后端共享同一份生成数据；超出官方表范围时报 `LUNAR_CALENDAR_UNAVAILABLE`。闰月生日在无同名闰月年份按普通同月提醒，农历小月的三十按二十九提醒；阳历 2 月 29 日在平年按 2 月 28 日提醒。
- `person.delete`：`{circleId,personId}` → `{personId}`。只能删除未认领、无关系连接的卡；有关系时返回 `RELATION_CONNECTED` 和关联数量说明。
- `person.claim`：`{circleId,personId}` → `{claimRequest}`，用于迁移旧版已入圈但没有本人卡的成员；管理员用 `person.claimList` 查看待审请求，再用 `person.claimApprove`、`person.claimReject` 核对后绑定。新加入审核会直接建卡或明确绑定已有卡；申请人不能传 `claimPersonId`。
- `person.claimMine`：`{circleId}` → `{claimRequests}`，仅返回当前成员在此圈的认领申请及人物名称，供本人查看待审、通过和拒绝状态。
- `person.unclaim`：`{circleId,personId}` → `{person}`，只有高于目标成员角色的管理员可纠正误关联；不能解绑自己的卡。解绑清除该录卡的私人资料与管理员覆盖层、保留关系并留审计记录。
- `photo.upload`：`{base64}` → `{profile}`，无需先加入家庭／同学记录即可上传本人头像；兼容旧入口 `{circleId,personId,base64}` → `{person}`。小程序将选中图片重编码为 1 MiB 以内的 JPEG；云函数进一步校验 JPEG 结构、宽高与像素上限，并剥离 EXIF、XMP、注释等 APP/COM 元数据。鉴权后按微信账号的 24 小时窗口限制最多 20 次上传尝试。账号头像上传到 `photos/<SHA-256(account|OPENID) 前 40 位>/<UUID>.jpg`；本录人物入口沿用圈内路径，绑定时重新核对本人或本录管理员身份。管理员换已关联人物照片只改变本录人物卡，不写本人账号头像。照片文件 ID 和 OPENID 不返回给小程序。
- `photo.url`：`{}` → `{url}` 只签发本人头像短时链接；`{circleId,personId}` → `{url}`，先检查请求者仍是该记录成员且人物有照片。
- `photo.urls`：`{circleId,personIds:[...]}` → `{urls:{personId:url}}`，每次最多 20 人，逐人检查本圈成员身份和照片存在性，再批量签发链接；响应不含文件 ID。

资料 `patch` 可用字段：`name,nickname,gender,birthOrder,birthday,country,province,city,latitude,longitude,status,school,industry,occupation,bio,phone,wechatId`，以及用于清除照片的 `photoFileId:null`；公开接口不接受新照片文件 ID。`latitude/longitude` 不作为单独的代维护授权项。

### 关系、邀请、审批与授权

- `relation.list`：`{circleId}` → `{relations}`，仅家庭圈活跃成员可读。
- `relation.preview`：`{circleId,relationChange:{removeRelationId?,relation?:{from,to,type,olderId?}}}` → `{impact,before?,after?}`。成员可预览结构化建议，管理员可在新增、删除或替换前核对；不落库。`impact` 包含删除／新增的关系 ID 和可能受影响的人物 ID，范围按相关连通部分计算，不是逐人称呼差异清单。
- `relation.create/replace/delete`：分别传 `{circleId,from,to,type,olderId?}`、`{circleId,relationId,relation:{from,to,type,olderId?}}`、`{circleId,relationId}`；只有管理员可修改，且仅家庭圈。新增和替换会校验互斥边、亲子环及确定的代际矛盾；删除可用于清理旧图。修改写入前后关系摘要及操作原因。
- `invite.create`：`{circleId}` → `{invite:{id,token,expiresAt,status}}`，仅共建圈管理员。`token` 是 32 字符 base64url 字符串，可放入小程序码 `scene`；微信卡片和二维码必须承载**同一个 token**，不能各生成一份。
- `invite.code`：云函数外层路由接收 `{circleId,token}`。先以当前 OPENID 调用管理员专用的 `invite.list` 做权限校验，再核实 token 属于此圈且仍有效，最后调用微信小程序码接口，固定落地页为 `pages/apply/index`，以同一 token 作为 `scene`，返回 PNG 的 base64。演示适配器不提供真码；真实调用须在已绑定小程序的 CloudBase 环境验证。
- `invite.preview`：`{token}` → `{circle,expiresAt,status}`，凭有效令牌可在入圈前查看有限圈信息，不含成员信息；`join.mine` 另允许申请人按自己的微信身份查询本人申请。
- `invite.apply`：`{token,note?}` → `{application}`。姓名、城市和生日由服务端当前账号唯一资料读取，缺完整资料报 `PROFILE_INCOMPLETE`；客户端重复提交的 `name/profile` 不会覆盖账号资料。同学记录 `note` 必填，家庭记录可选。申请人不能指定人物卡；同一账号被拒后须用新的管理员邀请才能重提。
- `invite.list/revoke`：`{circleId}`、`{circleId,inviteId}`，仅管理员；列表不返回原始 token。
- `join.list`：`{circleId}` → `{applications}`，管理员可核对申请中的城市、生日和同班说明。`join.approve`：`{circleId,applicationId,targetPersonId?,initialRelation?,targetPersonUpdatedAt?}`。未传 `targetPersonId` 时原子创建完整本人卡；家人录已有其他人物时必须附 `initialRelation: {anchorPersonId,kind,older?}`，`kind` 为 `newParent`、`newChild`、`spouse` 或 `sibling`，`older` 仅用于兄弟姐妹，可为 `unknown`、`new`、`anchor`。关系对象是这份家人录中的已记录人物；新人物、首条关系、成员资格和邀请使用状态在同一事务保存，关系冲突时整次批准回滚。首个人物可以省略关系。传 `targetPersonId` 时只绑定管理员明确指定的本圈未关联卡，保留原有关系，且不得同时传 `initialRelation`；界面先核对旧卡与申请人的姓名、城市和生日，提交时用 `targetPersonUpdatedAt` 防止旧卡变化后继续关联。若旧卡设有核对手机号，还须与申请人当前经微信验证的号码一致。不能将管理员预录的可选字段回填申请人账号资料。跨圈卡、已关联卡、还有待审关联的卡均拒绝。同窗录不接受 `initialRelation`。旧申请缺完整资料时报 `PROFILE_INCOMPLETE`；批准时重新检查邀请有效性。`join.reject`：`{circleId,applicationId}`。一次邀请仅一人可获批准；其余申请标记过期。
- `join.mine`：`{}` → `{applications,hasMore}`，申请人查看最近 20 份自己的申请、圈名／类型及处理状态；`{applicationId}` 精确查询本人某一份申请，供状态页使用；也可传 `{inviteToken}` 按邀请精确查询本人申请，与 applicationId 互斥，不受20条列表限制。失效邀请仍可查本人历史，能否进入另以当前有效成员身份判断。待审申请若对应邀请已失效，响应显示失效状态，不返回别人的申请。
- `delegation.grant`：`{circleId,personId,adminMemberId,fields:[...]}` → `{delegation}`，只有已认领人物本人可授权。
- `delegation.revoke`：`{circleId,delegationId}` → `{delegation}`，只有授权人可撤销。
- `suggestion.create/list/resolve`：创建 `{circleId,type:'person'|'relation'|'invite',personId?,message,relationChange?}`；关系建议必须带结构化 `relationChange`。同一账号在同一圈子最多保留 5 条待审建议，滚动 24 小时最多提交 10 条；服务端在创建事务中写入该成员文档，防止并发提交同时越过限额。管理员处理 `{circleId,suggestionId,status:'accepted'|'handled'|'rejected',resolutionNote}`，处理说明必填，最多 500 字，并随列表和审计返回。关系建议只可 `accepted` 或 `rejected`；采纳时按原边指纹检查是否过期，再于同一事务更新关系、建议状态和审计，冲突时仍为待处理。人物和邀请类文字建议只可 `handled` 或 `rejected`；`handled` 表示管理员已人工处理，**不会自动修改资料或邀请**。旧纯文字关系建议不能直接采纳，可以拒绝并请成员重提具体更正。
- `audit.list`：`{circleId}` → `{events}`，仅管理员，最近 100 条；返回操作者名称、时间、动作与安全的改动摘要，不返回 OPENID。成员不可查其他人的管理记录。

## 5. 邀请与认领状态

邀请码由随机 24 字节编码为 32 字符 base64url 字符串。服务端以 SHA-256 摘要作邀请文档 ID 和校验值，不存原始 token；链接有效期为创建后 72 小时，管理员可随时撤销。展示、申请和审批分别检查状态；审批以当前服务端时间再检查一次，避免“申请时有效、审批时已过期”绕过。被转发的人只能提交身份说明，管理员核对后再批准。同学圈的“是否同班”由管理员依据学校、届别、班级及申请说明人工核对，服务无法自动证明现实身份。

一张人物卡只能有一个 `claimedBy`。同名和公开联系方式 `phone` 均不会触发绑定；管理员私下预录的 `matchPhone` 只能在账号已获该录成员资格后，结合本人经微信验证的号码帮助匹配人物卡。单凭预录号码和登录不得新建成员资格，也不得把账号资料展示给该录管理员；首次加入仍走本人接受邀请和管理员审核。同圈相同匹配号只能预录一张。已有本人卡、人物卡已被他人绑定或成员曾退出／被移除时，匹配会跳过，不会覆盖或恢复成员资格。关联时同一事务绑定已获准成员与人物卡、清除人物卡私有匹配号及其索引、处理该成员已有的待审人物卡关联申请，并记录审计；预录卡字段不能反向回填账号资料。微信手机号可能变更或被运营商回收，服务端身份记录 90 天后须重新授权。新入录审批可在一个事务内授予成员资格并建立或明确绑定现有卡；旧版无本人卡的成员仍可单独提出关联申请。误关联由管理员解绑，清空该录人物卡照片、生日、地点、联系方式和本录覆盖层，关系节点保留；当前没有恢复已清空内容的入口。

## 6. 云开发安全配置与部署前置

**数据库**：对 `circles,members,persons,relations,invites,applications,claimRequests,delegations,suggestions,audit,photoUploadBudgets,phoneMatches,phoneIdentities,userProfiles,personRemarks` 每个集合设置自定义安全规则 [database-deny-client.json](../cloudfunctions/security/database-deny-client.json)，禁止小程序客户端直接读写原始文档。云函数使用环境范围数据库客户端操作数据，再由 `ApiService` 逐请求过滤。默认开放数据库读权限会泄露隐藏字段、手机号、邀请摘要及 OPENID，因此不能发布。

CloudBase [事务限制](https://docs.cloudbase.net/database/transaction)为单次最多 100 个文档操作、30 秒，且事务内仅支持 `doc` 操作。服务将列表所需的关联姓名按圈批量读取，把安全关键的成员、邀请、手机号匹配索引等确定 ID 留在事务内校验；批量撤销授权最多处理 80 条，超过时在写入前报 `DATA_LIMIT`。当前圈列表最多支持一人 80 个圈；仓库查询遇到超过 5000 条匹配记录时明确报 `DATA_LIMIT`，不会悄悄返回不完整数据。更大规模需要分页和批处理设计。正式建库时还应按各 `where` 条件及 `_id` 排序配置索引，尤其是 `phoneMatches.phone` 与 `_id`，参考[CloudBase 索引指南](https://docs.cloudbase.net/database/data-index)。

**云存储**：设置 [storage-deny-client.json](../cloudfunctions/security/storage-deny-client.json) 为客户端读写均拒绝。照片仅经云函数 `photo.upload` 服务端上传，上传前做成员、本人／授权、JPEG 结构及 1 MiB 大小校验、元数据剥离和账号配额检查。小程序不能调用 `wx.cloud.uploadFile` 直传，以免未入圈用户占用存储额度。跨成员照片展示通过 `photo.url` 或每批最多 20 人的 `photo.urls`，由云函数在权限校验后签发暂设 60 秒有效的临时 URL；已经签发的 URL 在到期前可能仍被持有者访问，因此移除成员后的照片访问不能仅靠前端清缓存声称瞬时撤回。上线前须在真实环境验证私有文件的服务端上传、签发、链接有效期与删除流程。还需配置资源费用告警和孤儿文件清理；同一文件可能仍被其他人物卡引用，不能在换照片或移除成员时直接删除旧文件。物理清理需在云端建立引用核对和安全回收流程后实现。请求内传 base64 会增加流量，已用 1 MiB 限制控制单次成本。

**函数**：可参考 [function-api-only.json](../cloudfunctions/security/function-api-only.json)，只开放 `api` 给已登录调用者。**上线硬门槛：`api` 只能由已绑定的小程序通过事件调用，禁用 HTTP、Web、定时器、数据库触发器及其他来源调用同一函数。**身份来源是 `wx.cloud.callFunction` 的 `OPENID`；腾讯云文档指出混合调用来源时 `getWXContext()` 可能因实例复用残留上一位用户身份，函数安全规则 `auth != null` 本身不能证明来源。未来增加其他端时须拆分入口或采用能够验证调用来源的可信上下文身份方案，不能沿用此入口。参考[云函数实例复用说明](https://docs.cloudbase.net/cloud-function/instance)。不要在客户端直连数据库或存储做越权查询。安全规则在真实环境中需要逐项检查生效情况，不能只因本地测试通过就发布。

**小程序码**：`invite.code` 使用云函数内的 `cloud.openapi.wxacode.getUnlimited`；管理员必须持有当前有效邀请的原始 token 才能生成。`scene` 为一次性 token，微信分享卡片与扫码落地页均走 `invite.preview` 和 `invite.apply`，最终由同一条 `join.approve` 消耗邀请。云函数只接受有效 PNG，并对返回大小设上限。可用 `WX_CODE_ENV_VERSION` 指定 `develop`／`trial`／`release`，默认 `release`；联调时需按开发版本设置，且确保小程序已绑定云环境。接口代码与模拟 SDK 测试不等于真实微信开放接口已成功，必须真机扫码验证。

部署顺序：创建微信小程序账号和云开发环境、绑定 AppID；创建十五个数据库集合并逐个配置拒绝客户端访问规则；配置云存储和函数规则；在项目根目录执行 `npm run build:cloud`（编译后端并复制产物到 `cloudfunctions/api/lib`）；**从根目录的 `project.config.json` 打开微信开发者工具项目**，其 `miniprogramRoot` 为 `miniprogram/`、`cloudfunctionRoot` 为 `cloudfunctions/`，然后上传 `api` 云函数，或在有权限的环境用 CloudBase CLI 将 `cloudfunctions/api` 部署为事件型函数 `api`；再用真实测试账号验证权限、邀请、照片和手机号关联。`cloudfunctions/api/config.json` 授权云调用 `phonenumber.getPhoneNumber` 和 `wxacode.getUnlimited`；按[腾讯云手机号能力说明](https://docs.cloudbase.net/lowcode/components/wedaUI/src/docs/compsdocs/wxOpen/Phone)，实际手机号能力依赖小程序主体、认证与真机环境，当前本地测试不能证明该能力已开通。当前 `cloudfunctions/api/package.json` 指定 `wx-server-sdk`，部署时安装云端依赖。不要只打开 `miniprogram/project.config.json`，那样云函数目录不在项目根下。参考[微信小程序调用云函数](https://docs.cloudbase.net/recipes/add-cloud-function-wechat-miniprogram)、[安全规则](https://docs.cloudbase.net/rule/rule-example)。

## 7. 本地验证与未完成事项

在项目根目录运行 `npm run test:backend`，会先编译 TypeScript，然后运行 Node 自带测试。测试包含圈子隔离、跨圈管理员越权、邀请转发后审批前隔离、并发一次使用、到期与撤销、新建卡和申请资料完整性、历史空卡补录、待审认领与新建本人卡冲突、角色调整与圈主移交、成员退出、圈内统一可见及跨圈隔离、城市代表点校验与过滤、照片上传与签名、成员移除、代维护授权、关系预览／替换／冲突、结构化建议的原子采纳和审计，以及小程序码路由的模拟 SDK 校验。

本地自动化测试不需要 AppID，测试使用内存仓库和模拟账号 ID。CloudBase SDK、真实微信 OPENID、数据库安全规则、云存储、小程序码、手机号云调用及实际并发事务仍须在云环境就绪后端到端验证。农历生日用内置香港天文台对照表，不依赖运行时 ICU；已对 2026 和 2027 春节、2025 闰六月回归测试。当前没有实现主动通知、操作撤销或恢复、记录解散与数据导出保留期限、复杂再婚／收养／继亲关系类型和重复人物卡合并。地图城市坐标仍需与选择器目录核对；中文称呼由独立模块计算。


## 个人备注与浏览入口

`person.remark.get` 接收 `circleId/personId`，返回 `{remark:string}`；`person.remark.update` 另接收 `remark`（最多 200 字），空字符串表示清除。调用者须是本录当前成员，人物须属于本录。备注身份取自服务端，拒绝额外身份字段，不接受客户端替别人填写。备注不出现在人物列表、账号资料或管理员日志中。前端只对他人显示“我的备注”，不会改变公开昵称、关系或称呼计算。

管理员修改他人的资料、照片、关系和删除人物统一从“我的 → 我管理的记录”进入。浏览页只提供联系、个人备注和本人资料编辑；页面入口与服务端权限同时检查，普通成员直达他人编辑页也会被拒绝。


## 个人备注名与延后关系（2026-10-03）

`person.remark.list({circleId})` 返回 `{remarks: Record<personId,string>}`，一次查询本用户本录备注，校验成员代次与人物创建代次，不泄露其他用户备注。

`person.create` 与 `join.approve` 新增家庭人物支持显式 `deferRelation:true`。与 `initialRelation`、审批关联已有 `targetPersonId` 互斥，同窗录拒绝；未选延后仍要求关系。人物必要资料和权限校验不变，不生成关系边，幂等指纹包含标记。


## 账号生命周期与 100 人容量回归（2026-10-03）

- 云端入会 joinedAt 必须大于旧 joinedAt 和 endedAt，避免同毫秒或时钟回拨使退出前私人备注复活。
- 本地演示审批重复邀请时重查当前成员，同账号同录其他待审申请一并失效；撤销和到期精确边界一致。移除/退出拒绝旧关联申请，所有自动匹配和认领只更新当前加入中的成员记录。
- `UnitOfWork.findByIds` 仅按明确 ID 批量查询，每批 20 个，禁止全表扫描账号资料。人物、成员、近期生日、待审申请列表避免每人事务 get，100 个关联账号、100 个待审申请都不触发 100 文档事务预算。
- 账号资料批读后重读当前人物/成员绑定；仅创建代次及 claimedBy 不变且成员仍 active 并对应此人物时合成账号资料。审批列表重读当前 pending 申请。避免退出或拒绝后更新的个人资料被拼入旧列表。
- 返回前使用新的短事务复核调用者成员资格，待审列表再复核管理员权限。写入和实际审批仍使用事务读取，不以批量只读结果决定写权限。

本地预算模拟覆盖四个列表、100 人关系修改和审批，且覆盖查询中途撤权、管理员降级及被查询者退出/申请被拒的交错执行。真实云数据库的延迟、索引与并发吞吐需单独联调。


## 管理简化后的兼容语义（2026-10-03）

`person.unclaim` 仅为底层纠错接口保留，日常前端不暴露。创建者交接不等同于新增管理员；过期请求及目标已退出、被移出或重新加入后的旧请求不会显示或阻塞新交接。

历史纯文字关系建议（无具体 relationChange 操作）允许填写处理说明后 `handled`，不自动改图，也不允许 `accepted`。包含具体删边或新增关系的建议继续要求实际应用或拒绝，即使目标边已不存在也不能作为纯文字结案。
