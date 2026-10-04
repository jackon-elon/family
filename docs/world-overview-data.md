# 世界地图概览底图来源

小程序“世界”视图上方的陆地图形是本地图片 `miniprogram/components/person-map/world-land.png`。它由 [Natural Earth 1:110m Land](https://www.naturalearthdata.com/downloads/110m-physical-vectors/110m-land/) 的陆地多边形生成，不调用在线地图服务。Natural Earth 官方[使用条款](https://www.naturalearthdata.com/about/terms-of-use/)明确说明其矢量与栅格地图数据属于 **public domain**，允许修改与在应用中使用。

生成脚本为 `scripts/build-world-overview.py`，读取 [Natural Earth 官方维护的 GeoJSON 仓库](https://github.com/nvkelso/natural-earth-vector/blob/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_110m_land.geojson) 的固定提交 `ca96624a56bd078437bca8184e78163e5039ad19`。脚本校验源文件 SHA-256 `9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9`，需要 Python 与 Pillow 才能重新生成；交付的小程序直接使用已生成的 PNG，不需要运行脚本或下载地图。

底图和人物点使用相同的经纬度等距投影，经度范围为 −180° 至 180°，纬度展示范围为 −60° 至 85°。概览只用于同时查看不同大洲的城市分布；点击点位可选择城市，并让下方原生腾讯地图定位到该城市。点位数据仍遵循小程序现有的城市可见权限与约 0.1° 的位置精度。底图省略了南极洲，极端高纬和低纬点会贴近图像边缘显示。

[开发者工具模拟器截图](preview/world-overview-simulator.png)展示家庭圈世界概览：美国旧金山 1 人、中国城市 3 人同时可见，下面保留真实可缩放地图。模拟器中点旧金山后，选择状态为 `美国/旧金山`，原生地图中心经度变为约 −122.4°、缩放级别为 5。
