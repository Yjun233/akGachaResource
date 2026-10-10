# akGachaResource

「[明日方舟寻访数据站](https://github.com/Yjun233/akGachaData)」的**静态资源仓库**：
存放卡池 / 干员数据与干员头像，供站点（以及任何人）通过 **jsDelivr CDN** 直接读取。

- 📊 **卡池与干员数据**：国服来自 [PRTS Wiki](https://prts.wiki/)，国际服来自
  [arknights.wiki.gg](https://arknights.wiki.gg/)，繁中服由人工维护的金山在线表格生成
- 🧩 **皮肤 / 密录 / 模组的日期**与**中坚寻访（含中坚甄选）的干员名单**来自
  [ArknightsAssets/ArknightsGamedata](https://github.com/ArknightsAssets/ArknightsGamedata)
  —— 官方解包数据，三个服都有
- 🖼 **干员头像**：来自
  [ArknightsAssets/ArknightsAssets2](https://github.com/ArknightsAssets/ArknightsAssets2)（`cn` 分支），
  已压缩到 96×96

## 直接用这些数据

```bash
# 干员表（标准寻访、中坚寻访和限定寻访会出现的5★/6★干员，以 charId 为键）
#   各服共用一份，用 scReleaseDate / enReleaseDate / tcReleaseDate 区分实装日
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/operators.json

# 卡池表（以卡池 ID 为键，不含联动寻访、跨年欢庆寻访、新人和回归寻访）
#   按服务器分文件；「中坚寻访 / 中坚甄选」在**单独一个文件**里（官方解包来源，站点侧合并）
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/banners_sc.json       # 国服
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/banners_cla_sc.json   # 国服 · 中坚
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/banners_en.json       # 国际服
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/banners_cla_en.json   # 国际服 · 中坚
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/banners_tc.json       # 繁中服
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/banners_cla_tc.json   # 繁中服 · 中坚

# 元信息（生成时间、服务器列表、各服卡池数、中坚数据的更新日）
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/metadata.json

# 干员皮肤 / 密录 / 模组（按服务器分文件；时间是 YYYY-MM-DD）
#   · 皮肤：**国服**来自 PRTS（含**复刻 / 下架窗口**，是该字段的唯一来源）；
#     en / tc 来自官方解包 —— 官方只有「首发上架日」，所以窗口按「首发日 + 14 天」兜底
#   · 密录 / 模组：三个服都来自官方解包
#   · 都只收 operators.json 里那些「参与过寻访 UP 的干员」
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/skins_sc.json      # 时装：上架窗口 + 获取途径
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/memoirs_sc.json    # 密录：第几批 + 推出日期
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/modules_sc.json    # 模组：第几个 + 推出日期
#   把 _sc 换成 _en / _tc 就是另外两个服（皮肤的国服那份字段最全，其余两份只有 char / skinIndex / name / onShelf）

# 干员头像（charId 见 operators.json）
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/avatars/char_306_leizi.png
```

> ⚠️ 请用 `cdn.jsdelivr.net`。实测 `fastly.jsdelivr.net` 对本仓库的 **PNG 会 301 跳回**
> raw.githubusercontent.com（国内网络下会取不到），而 JSON 又是正常的。
> `gcore.jsdelivr.net` 也可用。

卡池 / 干员数据由 GitHub Actions **每周四 / 周五的北京时间 13:17 与 18:17** 自动更新，
没有更新时不产生提交。⚠️ GitHub 的定时任务目前**普遍延后 5~7 小时**（平台侧问题），所以时间
整体前移了 —— 实际落地多在当天傍晚到深夜。**皮肤与官方解包数据（模组 / 密录 / 中坚）** 由另一条工作流
**每周六 13:17** 更新 —— 它也读官方解包，但**周六那条的 `--only=extras`** 只做
模组 / 密录 / 皮肤，中坚归主工作流。

这两条工作流读的都是公开数据源，**不需要任何令牌**。繁中服的卡池数据源是人工维护的金山在线
表格，经 **AirScript webhook** 读取 —— 需要给仓库配 `AIRSCRIPT_TOKEN` 这个 Secret
（脚本令牌半年过期，到期去金山「脚本信息」里延期）。

## 目录

```
data/       operators.json · metadata.json
            banners_<srv>.json（卡池）· banners_cla_<srv>.json（中坚寻访 / 中坚甄选）
            skins_<srv>.json · memoirs_<srv>.json · modules_<srv>.json
            —— 皮肤 / 密录 / 模组，srv = sc（国服）/ en（国际服）/ tc（繁中服）
avatars/    <charId>.png（96×96）
scripts/    fetch-data.mjs（国服）· fetch-data-en.mjs（国际服）· fetch-data-tc.mjs（繁中服）
            fetch-skins.mjs（国服皮肤，PRTS）· fetch-avatars.mjs（抓头像）
            fetch-gamedata.mjs（官方解包：中坚 + 模组 / 密录 / 皮肤）
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
npm run build            # 一键全量：国服 → 国际服 → 繁中服 → 官方解包 → 国服皮肤 → 头像
                         #   （繁中服需要 AIRSCRIPT_TOKEN，没配的话跑不通会中断）
npm run build:data       # 从 PRTS Wiki 重爬**国服**卡池 / 干员 → data/
npm run build:data:en    # 从 arknights.wiki.gg 抓**国际服**数据 → data/
npm run build:data:tc    # 从**金山在线表格**（AirScript webhook）生成繁中服数据
                         #   需要脚本令牌：设环境变量 AIRSCRIPT_TOKEN，或写成一行放到
                         #   scripts/.airscript_token（已 gitignore）—— 详见 scripts/lib/airscript.mjs
npm run build:gamedata   # 从**官方解包数据**抽取：中坚寻访 / 中坚甄选 + 模组 / 密录 / 皮肤
                         #   → data/banners_cla_<server>.json · modules_/memoirs_/skins_<server>.json
                         #   --check 只对撞不落盘；--only=mid|extras 只做其中一块；
                         #   --servers sc,en,tc 只跑指定服务器
                         #   ⚠️ 本地被代理挡住时用 --local <解包仓库副本>（其中 character_table.json
                         #   有 20MB+，jsDelivr 供不了，只能走本地 / raw；CI 上 raw 可直连）
npm run build:skins      # 从 PRTS Wiki 抓**国服皮肤**（含复刻窗口）→ data/skins_sc.json
                         #   加 --dry 可只看统计不写盘
npm run build:avatars    # 补齐头像 → avatars/（只拉缺失的）
```

头像默认存 96×96；要原始尺寸：`node scripts/fetch-avatars.mjs --size=180`。

## 声明

本仓库是个人非商业的数据整理项目。《明日方舟》相关素材与数据的著作权归
上海鹰角网络科技有限公司所有，数据来源为 PRTS Wiki、arknights.wiki.gg、
ArknightsAssets/ArknightsGamedata 与人工维护的金山在线表格。
