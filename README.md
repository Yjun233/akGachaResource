# akGachaResource

「明日方舟寻访数据站」的**静态资源仓库**。卡池 / 干员数据与干员头像都放在这里，
**不进站点主仓库 [`akGachaData`](../akGachaData)** —— 站点在浏览器里通过 jsDelivr CDN
直接引用本仓库的文件，所以数据更新只需在本仓库跑一次爬虫，两边都不会失同步。

```
akGachaResource/
├── data/                    站点读取的 JSON 数据（由爬虫产出）
│   ├── operators.json       以 charId 为键的干员表（仅 5★/6★）
│   ├── banners_sc.json      卡池表（按服务器分文件，当前只有 sc）
│   ├── banner-categories.json
│   └── metadata.json
├── avatars/                 干员头像，<charId>.png
└── scripts/
    ├── fetch-data.mjs       爬虫：从 PRTS Wiki 抓卡池数据 → data/
    └── fetch-avatars.mjs    从 ArknightsGameResource 抓头像 → avatars/
```

## 常用命令

```bash
npm install                 # 首次（只需 pinyin-pro）
npm run build:data          # 重爬卡池数据 → data/
npm run build:avatars       # 补齐头像 → avatars/（只拉缺失的）
```

## 浏览器怎么引用

```
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/operators.json
https://cdn.jsdelivr.net/gh/Yjun233/akGachaResource@0b22f39b40a829da7255280e18e87e4de9b04993/avatars/char_306_leizi.png
```

**缓存策略**：jsDelivr 对 `@main` 的缓存很长（最长 7 天），所以

- **头像**：用 **commit sha 固定**（`@<sha>`）—— jsDelivr 对 sha 版本返回
  `max-age=31536000, immutable`（一年不可变），且**没有冷启动 301**。
  在站点里改 `src/lib/resource.js` 的 `AVATARS_SHA` 即可换版本（当前
  `0b22f39b40a829da7255280e18e87e4de9b04993`）。
- **数据 JSON**：每次 `build:data` 推送后调用 jsDelivr 的 purge 接口刷掉缓存，
  几分钟内生效（详见下方）。
- ⚠️ **用 `cdn.jsdelivr.net`，不要用 `fastly.jsdelivr.net`**：实测 fastly 端点对本仓库的
  PNG 恒 301 跳回 raw（国内裂图），JSON 却正常。`gcore.jsdelivr.net` 也可用。

```bash
# 推送后刷新 jsDelivr 缓存（对 @main 生效）
curl -X POST https://purge.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/operators.json
curl -X POST https://purge.jsdelivr.net/gh/Yjun233/akGachaResource@main/data/banners_sc.json
```

## 头像来源与规格

- 来源：`[yuanyan3060/ArknightsGameResource](https://github.com/yuanyan3060/ArknightsGameResource)`
  的 `avatar/<charId>.png`（原始 180×180 RGBA）。
- ⚠️ 源仓库太大（avatar 目录 2218 个文件 / 104 MB），**jsDelivr 不为它提供托管**
  （只 301 跳回 raw.githubusercontent.com），所以不能直接直链源仓库，必须先落到本仓库。
- 本仓库存的是**缩到 96×96** 的版本（页面实际只显示 20~26px）。
  想换成原图 180px 重跑一次即可：`node scripts/fetch-avatars.mjs --size=180`。
- 素材版权归游戏方所有，本仓库仅作个人数据站的展示用途。

## 更新流程

```bash
npm run build:data          # 重新爬数据
git add -A && git commit -m "data: YYYY-MM-DD 快照"
git push                    # 推到 github.com/Yjun233/akGachaResource
# 然后刷 jsDelivr 缓存（见上）
```
