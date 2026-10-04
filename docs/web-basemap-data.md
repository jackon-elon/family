# 网页概览地图数据

## 用途与显示范围

网页版默认使用随网站一起部署的真实地理矢量数据，供“中国 / 世界”范围的城市位置概览使用。世界概览来自 Natural Earth 的 **1:50,000,000（50m）** 数据集；中国省域细节来自 **1:10,000,000（10m）admin-1** 数据集，并加入现有城市目录的基础城市名称。它们是来源明确的地理数据，不是手绘大陆形状或模拟位置。

这里的 `50m` 表示比例尺 1:5,000 万，`10m` 表示 1:1,000 万，**不是 50 米或 10 米精度**。界面最大缩放级别为 9，省界和城市名称帮助辨认家人在哪座城市；数据不包含道路、建筑、导航或全国地级市界。此版本是“省界＋城市地名”，不能称为“全国市级行政边界图”。上游的国家、地区分类、边界及中文名称按源数据保留，未进行逐项权威校核，不能当作行政边界的权威声明。

Natural Earth 几何坐标为 **WGS84 经度、纬度（EPSG:4326）**，GeoJSON 每个位置按 `[longitude, latitude]` 保存。Leaflet 负责投影这些经纬度，不对底图再施加 GCJ-02 或 BD-09 偏移。国家标签坐标采用上游 `LABEL_X` / `LABEL_Y`，省级标签采用 admin-1 的 `longitude` / `latitude`。

城市位置复用 `frontend/src/shared/city-catalog.ts`：海外 GeoNames 源明确采用 WGS84；国内原始 `china-cities` 源只说明经纬度，未明确声明坐标基准，不能将其包装为逐点核验过的 WGS84 测量值。整个目录已保留一位小数（纬度方向约 11 km），这里按现有人物城市定位相同的粗略经纬度展示，不做未经证实的坐标转换；这远不足以定位住址。底图几何保存 4 位小数也不代表它达到对应小数位的测量精度。

## 来源与许可

使用 Natural Earth 维护仓库的固定提交：

`ca96624a56bd078437bca8184e78163e5039ad19`

上游文件：

- [ne_50m_admin_0_countries.geojson](https://raw.githubusercontent.com/nvkelso/natural-earth-vector/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_50m_admin_0_countries.geojson)
  - SHA256：`3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb`
- [ne_50m_land.geojson](https://raw.githubusercontent.com/nvkelso/natural-earth-vector/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_50m_land.geojson)
  - SHA256：`e874b27a51d146452be360cafb3cc50c86001074a67d534113e6534682f9826b`
- [ne_10m_admin_1_states_provinces.geojson](https://raw.githubusercontent.com/nvkelso/natural-earth-vector/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_10m_admin_1_states_provinces.geojson)
  - SHA256：`22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5`
  - 全球源文件约 40.7 MB，仅生成时读取，不作为网页资源部署；输出只保留选定区域及必需字段。

Natural Earth 在其[官方使用条款](https://www.naturalearthdata.com/about/terms-of-use/)中将这些矢量数据置于 **public domain（公有领域）**，允许修改和个人、教育、商业用途。界面保留 “Natural Earth” 来源说明，方便核查。仓库和本文保留许可链接及固定来源记录。

选择 10m admin-1 的依据是[官方说明](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-1-states-provinces/)；[50m admin-1 页面](https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-1-states-provinces/)说明其主要覆盖美国和加拿大，不能据此假设有完整中国省界。源数据采用其自身分类和边界观点，本项目不增画、移动或删改争议边界。

城市标签来源及许可见 [城市目录说明](city-catalog-data.md)。本轮不在线更新或改写已有目录，而是固定其规范 JSON SHA256 `d2ea345bc63d1c7a027e4740a20b99fa666b27c04e04df7d47dbe78a14157846`，使显示与已保存人物的选城结果一致。海外名称和位置来自 [GeoNames](https://www.geonames.org/export/)；[数据说明](https://download.geonames.org/export/dump/readme.txt)明确使用 **CC BY 4.0** 和 WGS84，界面须保留 GeoNames 署名链接。国内来自 `public-wheels/china-cities`，采用 MIT 许可，完整版权和许可文本随资产保留在 `china-cities-LICENSE.txt`；该文本固定到仓库提交 `91375815c8a1a5b834705be249bd1aa5f645053a` 并验证 SHA256。

当前国内目录有 370 个地点，包含直辖市、地级市、自治州及部分地区/县级地点；其中仍有莱芜等历史名称，港澳台覆盖也不是完整现行市县目录。因此可以说“保留现有目录全部城市标签”，不能说“已经核对全国最新全部地级市”。海外保留 2,969 个目录城市，原始选取规则包含首都及各国人口较多城市；显示优先级只表示阅读顺序，不宣称为人口排名。

没有下载、预取或打包 OpenStreetMap 的公共瓦片。默认地图运行时不请求外部地图服务，也不需要地图 Key；地图文件通过部署网站自身提供。首次打开网站仍需正常加载网页与这些静态资源。

## 仓库产物

文件保存在 `frontend/src/assets/basemap/`：

- `world.json`：GeoJSON `FeatureCollection`，242 个国家或地区要素、1,632 个环、99,613 个坐标位置；属性仅保留 `{name, id}`。`name` 来自 `NAME_ZH`，`id` 来自 `ADM0_A3`。
- `labels.json`：242 个标签，字段为 `{name, longitude, latitude, minZoom, kind}`；`kind` 为 `country`，仅供显示分类。`minZoom` 从上游 `MIN_LABEL` 向上取整加 1 后限制在 2–6，减少概览层级的标签重叠。
- `manifest.json`：来源提交、许可、坐标系统、源文件 SHA256、输出文件 SHA256、字节数和几何数量，供自动核验。
- `china-provinces.json`：72 个 admin-1 源要素、55,758 个坐标位置；字段 `{id, name, countryId}`。`countryId` 保留上游代码，覆盖 `CHN`、`HKG`、`MAC`、`TWN`，供运行组件在省域级别替换对应 50m 概览轮廓，避免两种比例尺海岸线叠影。它包含 31 个大陆省级要素、上游另列的西沙要素，以及香港 18 区、澳门 1 要素、台湾 21 个源县市要素；并非 72 个省。所有源岛屿和环均保留。
- `city-labels.json`：3,373 个标签，包括 34 个省级显示名称（31 个大陆省名＋香港、澳门、台湾）及目录的全部 3,339 个城市。省级显示采用河北、内蒙古、广西等常用简称，不改几何的上游全名，也不改城市名。字段 `{name, longitude, latitude, kind, minZoom, maxZoom, priority}`；`kind` 是 `region` 或 `city`，`priority` 越大越先显示。省名建议 2–6.5，使默认全国视图也有基本地名；省会等主城从 5、其余国内城市从 6、其余海外城市从 7 起参与显示，城市保留至 9。视野与文字避让仍可能暂时隐藏相互重叠的名称，继续放大或平移可查看。
- `detail-manifest.json`：省域文件及本地目录的固定来源、校验值、压缩体积、覆盖范围与精度限制。
- `china-cities-LICENSE.txt`：国内城市目录的 MIT 版权许可全文。部署打包时应通过资源引用保留该文件。

运行时使用国家及地区多边形同时绘制陆地填色和轮廓，避免再次打包同样的陆地坐标。生成过程也下载并核验固定版本的 land 数据，记录来源，但不把它重复加入网页。

不删除小岛、不删除环、不重新手绘边界。仅去除不使用的属性，将坐标四舍五入至小数点后 4 位，并使用紧凑 JSON 保存；未进行额外顶点抽稀。源数据本身已经是 50m 比例尺的概览图形，保留 4 位小数不代表达到该小数位对应的测量精度。

本次生成大小：

- `world.json`：1,876,479 字节，gzip 约 684 KB。
- `labels.json`：22,224 字节，gzip 约 5 KB。
- 两份地图运行数据合计：1,898,703 字节；网页构建和服务器压缩后的实际传输大小以构建产物及响应头为准。
- 新增 `china-provinces.json`：1,050,041 字节，gzip 331,955 字节。
- 新增 `city-labels.json`：357,245 字节，gzip 40,967 字节。
- 新增两份运行数据合计 1,407,286 字节，gzip 372,922 字节（约 373 KB）。总底图运行源数据约 3.31 MB，gzip 约 1.06 MB；最终传输以网站构建压缩产物为准，不把 40.7 MB 的全球源文件发给手机。

## 可重建过程

生成脚本仅使用 Python 3.8+ 标准库，不增加 npm 运行依赖：

```powershell
python scripts/build-web-basemap.py
python scripts/build-web-basemap-detail.py
```

两个脚本各自下载固定提交的必需源文件，先检查 SHA256，再生成产物。任何源文件不匹配都中止，不会静默使用另一个版本。细节脚本还核验本地城市目录的规范 JSON 哈希；目录变更需要审查覆盖范围和来源后更新固定哈希。

如已保存对应源文件，可完全离线重建。概览脚本需要 countries、land 两份源文件；细节脚本需要 admin-1、countries，以及按固定许可 URL 下载并命名为 `china-cities-LICENSE.txt` 的许可文件：

```powershell
python scripts/build-web-basemap.py --source-dir C:\path\to\natural-earth-source
python scripts/build-web-basemap-detail.py --source-dir C:\path\to\natural-earth-source
```

校验已提交的结果是否能够逐字节重现，并且不修改产物：

```powershell
python scripts/build-web-basemap.py --source-dir C:\path\to\natural-earth-source --check
python scripts/build-web-basemap-detail.py --source-dir C:\path\to\natural-earth-source --check
```

脚本检查 GeoJSON 类型、经纬度有效范围、有限数值、环闭合、至少三个不同顶点、非零面积、中文名称、唯一要素 ID、标签坐标和体积预算（概览 2 MB，新增细节 1.6 MB）。细节脚本还锁定 72 个几何、34 个省级标签、370 个国内城市地点和 3,339 个目录城市的数量。两个脚本保留原始环方向及 Polygon / MultiPolygon 结构，不重新抽稀顶点。构建时还应执行常规前端类型检查与地图界面验收，检查城市标记、近邻城市名称、省界、缩放和中国/世界切换。

此前概览版本额外使用临时安装的 Shapely 2.1.2 检查几何拓扑：242 个源要素和 242 个输出要素的 `is_valid` 均通过，北京、东京、悉尼及伦敦的代表性 WGS84 城市点均落在对应几何内。该结论只针对概览版本，不能挪用于新省域文件。新增细节本轮按上述生成器结构与坐标校验，并进行离线逐字节重建；未宣称通过全部几何拓扑检查。Shapely 不属于生成脚本或网站运行依赖。

本轮额外用点在多边形内检查确认：目录中的北京 `(116.4, 39.9)`、上海 `(121.5, 31.2)`、杭州 `(120.2, 30.3)`、成都 `(104.1, 30.7)`、广州 `(113.3, 23.1)` 分别位于对应省域输出几何内；只证明这些代表点与底图相容，不代表目录全部城市已逐项核验。
