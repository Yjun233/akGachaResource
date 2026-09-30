# akGachaResource

「[明日方舟寻访数据站](https://github.com/Yjun233/akGachaData)」的**静态资源仓库**：
存放卡池 / 干员数据与干员头像，供站点（以及任何人）通过 **jsDelivr CDN** 直接读取。

- 📊 卡池与干员数据：抓取自 [PRTS Wiki](https://prts.wiki/)，目前只有国服
- 🖼 干员头像：来自 [ArknightsGameResource](https://github.com/yuanyan3060/ArknightsGameResource)，
  已压缩到 96×96

## 直接用这些数据

```bash
# 干员表（230 位 5★/6★，以 charId 为键）
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/operators.json

# 卡池表（430 个，以卡池 ID 为键）
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/banners_sc.json

# 元信息（生成时间、服务器列表）
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/metadata.json

# 干员头像（charId 见 operators.json）
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/avatars/char_306_leizi.png
```

> ⚠️ 请用 `cdn.jsdelivr.net`。实测 `fastly.jsdelivr.net` 对本仓库的 **PNG 会 301 跳回**
> raw.githubusercontent.com（国内网络下会取不到），而 JSON 又是正常的。
> `gcore.jsdelivr.net` 也可用。

数据由 GitHub Actions **每周二 / 周四 / 周五 北京时间 18:00** 自动更新，
没有更新时不产生提交。

## 目录

```
data/       operators.json / banners_sc.json / metadata.json
avatars/    230 张 <charId>.png（96×96）
scripts/    fetch-data.mjs（爬虫）· fetch-avatars.mjs（抓头像）
```

## 卡池类型

| 大类 | type |
| --- | --- |
| 标准寻访 | `double` `joint` `stdfes` `mainfes` `single` `five` |
| 中坚寻访 | `classic` `clafes` |
| 限定寻访 | `limcel`（庆典）`limspr`（春节）`limsum`（夏季） |

## 自己跑一遍

```bash
npm install
npm run build:data       # 从 PRTS Wiki 重爬数据 → data/
npm run build:avatars    # 补齐头像 → avatars/（只拉缺失的）
```

头像默认存 96×96；要原始尺寸：`node scripts/fetch-avatars.mjs --size=180`。

## 声明

本仓库是个人非商业的数据整理项目。《明日方舟》相关素材与数据的著作权归
上海鹰角网络科技有限公司所有，卡池数据来源为 PRTS Wiki。
