# 亲友关系网微信小程序

基于[需求文档](./亲友关系网小程序需求文档.md)实现的本地演示版。家庭圈和同学圈分开管理；家庭关系图按辈分分层，同辈排在同一行、本人高亮，点击人物显示从本人出发的称呼与路径。两个圈子都可在微信原生地图的中国／世界视图和列表中查看成员公开的城市。已有测试小程序 AppID，尚无云开发环境 ID，默认运行演示数据。

## 本地验证

需要 Node.js 22。项目根目录执行：

```powershell
npm install
npm test
npm run build:cloud
```

`npm test` 运行 56 项亲属规则、关系图布局、后端权限、邀请与前端演示测试，以及 TypeScript 和页面配置检查。`build:cloud` 编译云端服务并将产物放入 `cloudfunctions/api/lib`。执行结果及未验证部分见[测试报告](./docs/test-report.md)。

安装微信开发者工具后，以**项目根目录**（本目录）导入 `project.config.json`。其中 `appid` 为占位值 `touristappid`；在 2.02.2609231 版开发者工具中，直接导入会报“不存在此 AppID”。本地已在被 Git 忽略的 `project.private.config.json` 配置测试 AppID；在其他电脑使用时可用自己的 AppID 创建同名文件：

```json
{"appid":"wx你的测试号"}
```

再次导入项目即可，不需要修改已提交的 `project.config.json`。演示数据保存在本地缓存，不需要云开发环境。云函数目录在项目根的 `cloudfunctions/`，因此不要只导入 `miniprogram/` 子目录。

新版关系图、原生地图和城市选点的开发者工具模拟器截图与操作记录见[测试报告](./docs/test-report.md#微信开发者工具模拟器实测)；真机复核仍待进行。

## 目录

- `miniprogram/`：原生小程序页面、演示数据和云函数调用适配器。
- `backend/`：TypeScript 后端服务、内存仓库、CloudBase 仓库适配器及测试。
- `cloudfunctions/api/`：微信云开发事件函数入口与构建产物。
- `packages/kinship/`：独立亲属称呼引擎及规则测试。
- `docs/`：[总体架构](./docs/architecture.md)、前端／后端设计和[测试计划](./docs/test-plan.md)。

亲属称呼源文件在 `packages/kinship/src/index.ts`；`npm run sync:kinship` 将其复制到小程序可打包的 `miniprogram/vendor/kinship.ts`。修改称呼规则后应运行同步及测试。

## 接入真实微信环境

账号主体需提供 CloudBase 环境 ID，再按[后端设计文档](./docs/backend-design.md)创建集合、配置**拒绝客户端直接读写**的规则并部署云函数。小程序只通过云函数读写私人资料；照片也由服务端验证权限后上传。云函数 `api` 必须仅供该微信小程序事件调用，不能与 Web／HTTP 等来源共用。接入后还需用多个真实微信账号做邀请、权限、照片和真机地图验收。

本地自动化测试通过不等于微信审核或云端安全验证通过。二维码目前是页面中明确标注的预留位，还需接入小程序码生成并扫码验收。城市可从常见城市列表选择，也可填写名称后在原生地图上手动标记城市中心；服务端只保留取整到 0.1 度的城市代表点，且按城市可见范围过滤。正式发布所需的账号、备案、隐私指引和提审由小程序主体在微信平台完成。
