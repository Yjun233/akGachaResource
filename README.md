# akGachaResource

「[明日方舟寻访数据站](https://github.com/Yjun233/akGachaData)」的**静态资源仓库**：
存放卡池 / 干员数据与干员头像，供站点（以及任何人）通过 **jsDelivr CDN** 直接读取。

- 📊 卡池与干员数据：**国服**来自 [PRTS Wiki](https://prts.wiki/)，**国际服**来自
  [arknights.wiki.gg](https://arknights.wiki.gg/)，**繁中服**由人工维护的金山在线表格生成
- 🖼 干员头像：来自 [ArknightsGameResource](https://github.com/yuanyan3060/ArknightsGameResource)，
  已压缩到 96×96

## 直接用这些数据

```bash
# 干员表（标准寻访、中坚寻访和限定寻访会出现的5★/6★干员，以 charId 为键）
#   各服共用一份，用 scReleaseDate / enReleaseDate / tcReleaseDate 区分实装日
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/operators.json

# 卡池表（以卡池 ID 为键，不含联动寻访、跨年欢庆寻访、新人和回归寻访）
#   按服务器分文件：
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/banners_sc.json   # 国服
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/banners_en.json   # 国际服
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/banners_tc.json   # 繁中服

# 元信息（生成时间、服务器列表）
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/metadata.json

# 干员皮肤 / 密录 / 模组（只做国服；时间是 YYYY-MM-DD）
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/skins.json     # 时装：上架窗口 + 获取途径
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/memoirs.json   # 密录：第几批 + 推出日期
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/modules.json   # 模组：第几个 + 推出日期

# 干员头像（charId 见 operators.json）
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/avatars/char_306_leizi.png
```

> ⚠️ 请用 `cdn.jsdelivr.net`。实测 `fastly.jsdelivr.net` 对本仓库的 **PNG 会 301 跳回**
> raw.githubusercontent.com（国内网络下会取不到），而 JSON 又是正常的。
> `gcore.jsdelivr.net` 也可用。

三个服务器的数据都由 GitHub Actions **每周二 / 周四 / 周五 北京时间 18:00** 自动更新，
没有更新时不产生提交。**干员皮肤 / 密录 / 模组（只做国服）** 也在同一次任务里更新
（读同一个公开 wiki，不需要任何令牌）。繁中服的数据源是人工维护的金山在线表格，
经 **AirScript webhook** 读取 —— 需要给仓库配 `AIRSCRIPT_TOKEN` 这个 Secret
（脚本令牌半年过期，到期去金山「脚本信息」里延期）。

## 目录

```
data/       operators.json · metadata.json
            banners_sc.json（国服）· banners_en.json（国际服）· banners_tc.json（繁中服）
            skins.json · memoirs.json · modules.json（干员皮肤 / 密录 / 模组，只做国服）
avatars/    <charId>.png（96×96）
scripts/    fetch-data.mjs（国服）· fetch-data-en.mjs（国际服）· fetch-data-tc.mjs（繁中服）
            fetch-extras.mjs（皮肤 / 密录 / 模组，国服）· fetch-avatars.mjs（抓头像）
            lib/（数据脚本共用的小工具，含 AirScript 调用封装）
            airscript-sheet-reader.js   ⚠️ 不是 Node 脚本，要整段粘到金山文档的 AirScript 编辑器里
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
npm run build            # 一键全量：国服 → 国际服 → 繁中服 → 皮肤/密录/模组 → 头像
                         #   （繁中服需要 AIRSCRIPT_TOKEN，没配的话跑不通会中断）
npm run build:data       # 从 PRTS Wiki 重爬**国服**数据 → data/
npm run build:data:en    # 从 arknights.wiki.gg 抓**国际服**数据 → data/
npm run build:data:tc    # 从**金山在线表格**（AirScript webhook）生成繁中服数据
                         #   需要脚本令牌：设环境变量 AIRSCRIPT_TOKEN，或写成一行放到
                         #   scripts/.airscript_token（已 gitignore）—— 详见 scripts/lib/airscript.mjs
npm run build:avatars    # 补齐头像 → avatars/（只拉缺失的）
npm run build:extras     # 从 PRTS Wiki 抓**干员皮肤 / 密录 / 模组**（只做国服）→ data/
                         #   加 --dry 可只看统计不写盘
```

头像默认存 96×96；要原始尺寸：`node scripts/fetch-avatars.mjs --size=180`。

## 声明

本仓库是个人非商业的数据整理项目。《明日方舟》相关素材与数据的著作权归
上海鹰角网络科技有限公司所有，卡池数据来源为 PRTS Wiki、arknights.wiki.gg
与人工维护的金山在线表格。
