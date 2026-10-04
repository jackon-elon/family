# 离线城市目录数据

`miniprogram/utils/city-catalog.ts` 由 `scripts/build-city-catalog.py` 生成，供人物卡按「国家 / 地区 → 省 / 州 → 城市」逐级选择，并为地图提供**城市中心**坐标。生成时保留一位小数，不包含住址或用户定位信息。当前目录约 3,339 座城市、241 个国家或地区；未收录的地点可手动填写，但会在地图统计中列为“城市待定位”。

数据来源：

- [public-wheels/china-cities](https://github.com/public-wheels/china-cities)：中国省份与城市中文名及坐标。仓库标注 [MIT 许可](https://github.com/public-wheels/china-cities/blob/master/LICENSE)。生成器取省级行政区和地级城市，直辖市只保留同名城市，并去重；源数据较旧，行政区划变更需要日后核对。
- [GeoNames cities15000](https://download.geonames.org/export/dump/readme.txt) 和 [admin1CodesASCII](https://download.geonames.org/export/dump/)：其他国家的城市、行政区与坐标。依据人口和首都标记，每个国家保留最多 15 座城市；部分常见国家保留 25–120 座。[GeoNames 数据条款](https://www.geonames.org/export/)为 CC BY，允许商业使用，要求署名，且不保证准确性或完整性。此文档保留数据来源和署名。

目录用于便捷选择和地图概览，不应用来推断个人精确位置。更新目录时运行 `python scripts/build-city-catalog.py`，审核生成差异、重名城市和香港、澳门、台湾等名称后再提交。
