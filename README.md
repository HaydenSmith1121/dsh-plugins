<p align="center">
  <img src="assets/hero-everything-is-a-plugin.svg" alt="万物皆插件 — Everything is a plugin：模型、工具、界面、工作流经同一套 contract 组合进同一个 DeepSeek Harness 运行时" width="100%">
</p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/Upstream-DeepSeek_Harness-4D6BFE?style=flat-square" alt="Upstream: DeepSeek Harness"></a>
  <a href="#license"><img src="https://img.shields.io/badge/License-MIT-2EA44F?style=flat-square" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Baseline-dsh_0.1.6--alpha.1-8B5CF6?style=flat-square" alt="Runtime baseline: dsh 0.1.6-alpha.1">
  <img src="https://img.shields.io/badge/Plugins-7658-0EA5E9?style=flat-square" alt="7,658 catalogued plugins">
  <img src="https://img.shields.io/badge/Sync-daily_(GitHub_Actions)-2088FF?style=flat-square" alt="Catalog refreshed daily by GitHub Actions">
</p>

<p align="center">
  <strong>本仓库只有市场，插件在另一个仓库</strong> —— 目录（一个插件一个配置文件） · 自动/手动两条安装路径 · 每日自动刷新<br>
  <sub>Marketplace only: a one-file-per-plugin catalog, install-it-your-way (automatic or manual), refreshed every day.</sub>
</p>

<p align="center">
  <a href="#what">🧭 两个仓库</a> ·
  <a href="#quickstart">🚀 快速开始</a> ·
  <a href="#catalog">🗂️ 目录与安装</a> ·
  <a href="#tiers">🧭 谁来决定装不装</a> ·
  <a href="#sync">🔄 每日刷新</a> ·
  <a href="#docs">🗺️ 文档地图</a> ·
  <a href="#contributing">🤝 贡献</a> ·
  <a href="#license">⚖️ 许可</a>
</p>

---

<a name="what"></a>

## 🧭 两个仓库：市场 vs 插件 · What

**`dsh-plugins`（本仓库）是市场，不是插件仓库。** 它只做三件事：维护**目录**、
提供**安装入口**（市场面板插件 `dsh-plugins-market` + 引导脚本）、把目录**每天刷新一遍**。
插件的字节与源码在**每个插件自己的仓库**里。

| | **本仓库** `HaydenSmith1121/dsh-plugins` | **每个插件自己的源码仓库** |
|---|---|---|
| **是什么** | 市场：目录 + 面板 + 引导脚本 | 插件本体：`lib/`（构建产物，已提交）+ 源码 + 文档 |
| **里面有什么** | `catalog/plugins/<slug>.json`（**一个插件一个配置文件**）、`catalog/index.json`、`compatibility.json`、`scripts/sync-catalog.mjs`、市场插件 `plugins-src/dsh-plugins-market/` | 各自的 `src/`、`lib/`、`cordis.patch.yml`、`docs/`、`README.md` |
| **发新版要改什么** | 什么都不用改 —— 目录由每日任务从公开索引与各插件仓库**采集**而来 | 改 `src/` → 重新 build → 提交 `lib/` → 发版 |
| **谁读它** | 市场面板（列表读 `catalog/index.json`，安装读单条配置文件）、`scripts/install.*` | pnpm（`github:` 安装直接从仓库取 `lib/`）、想审计源码的人 |
| **分不分发插件字节** | **不分发**。唯一由本仓库托管的产物是市场插件自己那一个 tarball | 分发自己那份 `lib/`（git 依赖，没有 tarball） |

> ★ **`dsh-plugin-collection`（插件集合仓库）已于 2026-09-18 退役。** 自研插件不再有
> 中心化的 tarball 仓库 —— 6 个插件各自一个源码仓库，安装规格统一是
> `github:HaydenSmith1121/<仓库名>`；那个仓库现在只剩一份退役说明。
> 逐插件的仓库地址见 [`README-安装说明.md` 第一节](./README-安装说明.md)。

> **一句话**：装插件 = **先读那个插件自己的配置文件，再按它写的 `install.method` 去装**。
> 索引只负责让你**看到**有哪些插件；读不到配置文件就**不装**，而不是拿索引里的字段猜一个方法
> —— 见[第三节](#catalog)。

---

<a name="quickstart"></a>

## 🚀 快速开始 · Quick Start

**前置只有一个：Node ≥ 22.19**（[nodejs.org](https://nodejs.org/)）。一条命令把仓库落地到
`~/.dsh-plugins` 并装上**市场面板**，不用 clone、不用 `cd`。

**Windows（PowerShell）**

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main/scripts/install.ps1).TrimStart([char]0xFEFF)))
```

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main/scripts/install.sh | sh
```

脚本只做五步：**环境预检 → 判定 dsh 版本 → 补齐 pnpm 与 `allowBuilds` → 装引导插件
`dsh-plugins-market` → 四步校验（含真实启动）**。

> ★ **引导脚本现在只装市场插件这一个**。「一键装全套」这条路已经没有了 ——
> 插件市场与插件本体分离之后，装哪个插件、怎么装是市场面板的职责（自动或手动由你选，
> 失败自动回滚）；
> 脚本只负责把入口装上。`-BootstrapOnly` / `--bootstrap-only` 仍然接受，含义与默认行为一致，
> 保留它是为了兼容旧命令与显式表达意图。

装完重启 `dsh web`，左侧导航 →「插件市场」，其余插件在面板里点装。

<details>
<summary><strong>🔧 常用参数</strong>（点开）</summary>

| 参数（PowerShell / sh） | 作用 |
|---|---|
| `-PreflightOnly` / `--preflight-only` | 只体检（走 `scripts/preflight.mjs`），不做任何改动 |
| `-DryRun` / `--dry-run` | 只打印将要执行的命令 |
| `-SkipVerify` / `--skip-verify` | 跳过装完的四步校验 |
| `-BootstrapOnly` / `--bootstrap-only` | 与默认行为相同：只装引导插件（保留以兼容旧命令） |
| `-Profile web` / `--profile web` | 指定 profile，默认 `web` |
| `-Force` / `--force` | dsh 版本不在兼容矩阵里也强装（不推荐，启动很可能失败） |
| `-RepoDir <路径>` / `-RepoUrl <URL>` / `-Ref <分支>` | 仓库落地位置 / 地址 / 分支，默认 `~/.dsh-plugins`、官方仓库、`main` |

远程管道（`irm ... | iex`）没法传参时，用环境变量：
`$env:DSH_INSTALL_ARGS = '-SkipVerify'`；仓库位置也能用 `DSH_REPO_DIR` / `DSH_REPO_URL` / `DSH_REF` 覆盖。

在命令末尾接参数即可，例如只体检：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main/scripts/install.ps1).TrimStart([char]0xFEFF))) -PreflightOnly
```

> **为什么不写成更短的 `irm ... | iex`？** 脚本含中文、文件带 UTF-8 BOM，
> `Invoke-Expression` 直接吃 BOM 会以 `The assignment expression is not valid` 解析失败。
> `[scriptblock]::Create(...)` 先去掉 BOM 再执行，顺带还能正常传参。
> 先落地成文件再跑也可以：
> `iwr <同一地址> -OutFile $env:TEMP\dsh-install.ps1; & $env:TEMP\dsh-install.ps1`

</details>

**遇到问题？** 常见故障按层次对号入座：

| 症状 | 去看 |
|---|---|
| `dsh --version` 不是 `0.1.6-alpha.1` | [版本兼容矩阵 § 两条必须记住的规矩](./docs/版本兼容矩阵.md#two-rules) |
| 装到一半报 `ERR_PNPM_IGNORED_BUILDS` | [注意事项 § 这个报错极具欺骗性](./docs/注意事项.md#pitfalls-ignored-builds) |
| GUI 里看不到某个插件 | [安装教程 § 排查顺序](./README-安装说明.md#ch7) |
| 想退掉某个插件 | [安装教程 § 卸载 / 回滚](./README-安装说明.md#ch9) |
| 面板里某个插件装不动 | [安装教程 § 面板点装](./README-安装说明.md#ch1)、[市场插件说明](./plugins-src/dsh-plugins-market/README.md) |

---

<a name="catalog"></a>

## 🗂️ 目录与安装 · Catalog

目录**不是几个大 JSON，而是一个插件一个配置文件**：

```none
catalog/
├─ plugins/<slug>.json     # ★ 一个插件一份：版本 / 收藏量 / 仓库地址 / 安装方法
├─ index.json              # 由上面**派生**的轻量索引 —— 列表页只读这一份（当前 7496 条）
└─ overrides/
   ├─ curated.json         # 人工核对过的第三方条目（安装规格 / peer 结论 / 实测记录，当前 7 条）
   └─ self.json            # 市场插件自己那一行（版本与 sha256 由脚本反推，不手写）
```

**这样做的直接好处**：某个插件的版本号或 star 数变了，diff 里就是**那一个文件的一行**，
而不是混在 7000 条里的一坨；某个插件要下架或补实测记录，也只碰它自己那份文件。

### 安装是怎么发生的

| 步 | 做什么 |
|---|---|
| 1 | 列表页读 `catalog/index.json`（派生索引，只用于**展示**：标题 / 版本 / star / 安装方式的标签） |
| 2 | 点「安装」时，**按需拉取那一个插件的 `catalog/plugins/<slug>.json`**（远程 → 本地缓存 → 包内兜底） |
| 3 | 按配置文件里的 `install.method` 解析出**自动安装规格**，同时算出一份**手动安装方案**（两条路的命令都从这里来） |
| 4 | 你在安装方案页选一条路：**自动**（市场在服务端执行，界面不弹命令窗口，有进度/预计剩余/可中止）或**手动**（命令给你，自己敲）。安装前自动备份 profile，失败自动回滚 |
| 5 | —— 前提是配置文件**读得到**。读不到就**拒绝安装**（`configUnavailable`），绝不拿索引字段猜一个方法；此时页面仍然把手动说明摆出来 |

> **为什么这条约定值得单独写一遍**：按索引猜出来的方法会把「装什么」从「配置说了算」变成
> 「代码猜的」，而那种错非常安静 —— 装是装上了。所以市场宁可停下来，并同时给出一份
> 拿到就能执行的手动安装方案。

### `install.method` 的五个取值

| 值 | 含义 | 装的时候用什么 |
|---|---|---|
| `tarball` | 仓库托管的离线 `.tgz`，带 `url` + `sha256` | 下载后校验 sha256 再 `dsh plugin add`；本机有仓库副本时优先用本地字节 |
| `npm` | npm 包名 | 直接交给 pnpm |
| `github` | `github:owner/repo` | pnpm 直接解析那个仓库（目标明确，不会装进来一个同名无关的包） |
| `skills` | 上游走的是 skills 机制，**不是 dsh 插件** | 市场没有可执行的安装路径，只给说明 |
| `manual` | 没有可靠的一键方式 | 只给说明与命令 |

> 采集器会做**自洽性检查**：声明了 `github` 却没有 `github:` 规格、声明了 `npm` 却不是合法包名、
> 声明了 `tarball` 却没有 `url` —— 一律降级成 `manual`（只有说明、没有可执行命令），
> 而不是让 pnpm 去报一个看不懂的错。注意这条降级**只影响自动那条路**：
> 页面会说明「为什么没有自动方式」并把手动方案原样列出来 —— **不是禁止安装**。

### 字段与格式

每一份配置文件的完整字段表、哪些是自动采集、哪些必须手写，见
[`docs/插件清单与来源.md`](./docs/插件清单与来源.md#fields)（含一份可照抄的示例配置）。

---

<a name="tiers"></a>

## 🧭 谁来决定装不装 · You Do

> **0.5.0 去掉了信任分级**（`verified` / `reviewed` / `community`），
> **0.6.0 去掉了装前检查（闸门）**。目录是一份**平铺列表**：有多少插件就是多少条，
> 没有层级标签、没有对应的页签与筛选，也没有「能不能装」的判决。

**为什么去掉分级**：那一套回答的是「维护者该不该为这个插件背书」，而用户真正要回答的问题
只有一个 —— **这个插件我这儿装不装得上**。而「装不装得上」这件事，一个维护者贴的标签
既答不准，也会过期。

**为什么连装前检查也去掉了**：静态检查看不到真实发布产物、看不到运行时行为、也看不到依赖
闭包 —— 它给出的「不安全」结论必然带着猜测，而这个结论在界面上会被读成「装不了」，
于是本来能用的插件被挡在门外。0.6.0 之后市场不再产出这类判决，只做两件事：

| 市场做的 | 用户做的 |
|---|---|
| 把**自动**那条路的规格解析出来（`kind` / `spec` / 来源如实标注） | 选自动，还是手动 |
| 把**手动**那条路的完整命令摆出来（下载 + sha256 + add + 校验 + 重启） | 决定要不要装、什么时候装 |
| 把知道的**事实**列出来（没声明 `dsh.bundle`、peer pin 到更新的版本、与已装的冲突、需要配置……） | 看完之后决定继续还是算了 |

连带去掉的还有一件：

| 去掉的 | 为什么 |
|---|---|
| **点赞** | 它和收藏在数据形状上一模一样，区别只是「一个数字大一点好看」—— 而这个数字**只统计你自己点过的**（本插件没有后端）。含义与收藏重复，纯粹是界面噪音。收藏留着 |

**留下来的事实仍然要说清楚**：字节由**本仓库托管**时（下载我们自己的 tarball、
`sha256` 逐字节核对、可离线安装），与安装**上游**发布的产物时（npm / GitHub，
本仓库不转发它的字节、只能做静态探测）是两种不同的确定性。
这是「我们查得有多细」，不是「这个插件可不可信」。

> 目录里仍有一批条目带着**人工核对过的实测记录**（安装规格、peer 约束与结论、
> 当时怎么验的）。那些记录没有丢，见 [`catalog/overrides/curated.json`](./catalog/overrides/curated.json)，
> 在界面上的详情页可见 —— 但它们**不再构成一个层级**，不参与筛选、不影响能不能装。

**本仓库不再随仓库分发任何第三方或自研插件的字节**：第三方插件按各自配置里的 `github:` / npm 规格
从上游安装，自研插件现在也走 `github:HaydenSmith1121/<仓库名>` —— 托管它们 tarball 的那个
集合仓库已于 2026-09-18 退役。原先随本仓库打包的四个第三方插件
（`@dsh-market/plugin`、`dsh-workbuddy-connect`、`dsh-connect-trae`、`dsh-receipt`）的 tarball 已全部删除，
它们**是否出现在市场里取决于能不能采到干净的上游规格** —— 例如 `dsh-workbuddy-connect` 与
`dsh-connect-trae` 现在解析为 npm 规格；采不到规格的就不在目录里，市场不会假装能装一个
没有安装方式的插件。

---

<a name="sync"></a>

## 🔄 每日自动刷新 · Daily Sync

目录是**运行时数据**：面板显示的版本号、能不能升级、按什么方式安装，全部来自这些配置文件。
它们过期的表现很隐蔽 —— 界面照常工作，只是「明明上游发了 0.5.0，这里还写着 0.4.2」，而用户
没有任何办法看出来。所以刷新是**自动、定时**的，而不是「想起来才跑一次」。

[`.github/workflows/sync-catalog.yml`](./.github/workflows/sync-catalog.yml) 每天
**18:00 UTC（北京时间次日 02:00）** 重新采集版本号 / 收藏量 / 仓库地址 / 安装方法，
**内容真的变了才提交**（时间戳只在内容变化时推进，所以不会产生「每天一次空提交」）。

| 关注点 | 做法 |
|---|---|
| 数据从哪来 | 四路来源按优先级合并：`catalog/overrides/self.json` → 集合仓库 `manifest.json` → `catalog/overrides/curated.json` → 公开索引，再由上一轮的配置文件传承实测记录与首次发现时间 |
| 版本号怎么定 | npm registry → GitHub release → GitHub tag → 默认分支的 `package.json`；**解析不出来就写 `null` + `versionSource: "none"`，绝不用别处的值凑数** |
| npm 的坑 | 只有「配置文件里本来就是干净的 npm 规格」**且** npm 上那个包声明的 repository 指向**同一个仓库**时才采信 —— 公共索引里的 `name` 与真实包名毫无关系 |
| GitHub 配额 | 批量 GraphQL，一批 50 个仓库一次往返；全量 7000+ 个仓库约 150 批 / 约 150 点，配额是 5000 点/小时 |

**完整机制、四路合并的优先级、时间戳策略、本地怎么跑**（`--check` / `--offline` / `--only` / `--limit`）
→ [`docs/目录同步.md`](./docs/目录同步.md)。

---

<a name="install"></a>

## 📖 安装教程 · Install Guide

**全文见 [`README-安装说明.md`](./README-安装说明.md)** —— 唯一、自包含的安装文档：
每个易错点都配了预防措施与自检项，照着走即可一次装对。

<details>
<summary><strong>📑 章节速查</strong>（10 章 + 附录，点开定位）</summary>

| 章节 | 内容 | 什么时候看 |
|---|---|---|
| [一、30 秒开始](./README-安装说明.md#ch1) | 一条命令 → 装引导插件 → 面板点装 | 第一次装 |
| [二、环境要求](./README-安装说明.md#ch2) | Node / pnpm / dsh 的版本要求 | 装之前 |
| [三、dsh 版本为什么锁死](./README-安装说明.md#ch3) | 版本不对会怎样、静默降级陷阱 | 升级 dsh 之前 ★ |
| [四、手动安装](./README-安装说明.md#ch4) | 不想用脚本时逐条命令 | 脚本用不了 |
| [五、路径要求](./README-安装说明.md#ch5) | tarball 所在目录不能删、不能挪 | 装之前 ★ |
| [六、安装后校验](./README-安装说明.md#ch6) | 版本 / 依赖层 / 装配层 / 真实启动 | 装完 |
| [七、看不到插件怎么查](./README-安装说明.md#ch7) | 按层次定位，含 `ERR_PNPM_IGNORED_BUILDS` | 出问题时 |
| [八、凭据不随包迁移](./README-安装说明.md#ch8) | API key / 登录态要重填 | 换机器 |
| [九、卸载 / 回滚](./README-安装说明.md#ch9) | `dsh plugin remove` 与备份 | 想退掉插件 |
| [十、`dsh-opencode-go-plus` 的来历与共存禁忌](./README-安装说明.md#ch10) | 派生来源、先卸后装 | 用到这个插件 |
| [附录：tarball 校验信息去哪了](./README-安装说明.md#appendix) | 为什么搬去集合仓库 | 想核对分发内容 |

</details>

> **运行时基线：dsh `0.1.6-alpha.1`** —— 选型依据与实测记录见
> [`docs/版本兼容矩阵.md`](./docs/版本兼容矩阵.md)；机器可读的那份是
> [`compatibility.json`](./compatibility.json)（只保留运行时矩阵，
> 逐插件的版本 / tarball / sha256 已从这里移出）。

> **开发插件？先隔离环境。** 不要直接改默认的 `~/.dsh`：`dsh web` 不允许第二个实例
> （端口冲突），插件树损坏会导致整个 harness 无法启动。
> 仓库自带隔离脚手架，详见 [`README-开发环境隔离.md`](./README-开发环境隔离.md)：
>
> ```bash
> node scripts/dev-env.mjs init     # 在 ~/.dsh-dev 建一套独立的 harness
> node scripts/dev-env.mjs web      # 启动隔离环境（3090），日常 3080 不受影响
> ```

---

<a name="docs"></a>

## 🗺️ 文档地图 · Docs

首页只负责指路，深度内容各自成篇，需要时再点进去。

| 分类 | 想看什么 | 去哪里 |
|---|---|---|
| **市场** | 仓库里都有什么、怎么分层 | [`docs/目录结构.md`](./docs/目录结构.md) |
| | 配置文件格式：每个字段什么意思、谁写的 | [`docs/插件清单与来源.md`](./docs/插件清单与来源.md) |
| | 每日同步：采集什么、怎么合并、本地怎么跑 | [`docs/目录同步.md`](./docs/目录同步.md) |
| | 收录方式、旧内容搬到哪去了、为什么不分级 | [`docs/收录说明.md`](./docs/收录说明.md) |
| | 市场面板的安全模型与安装事务 | [`plugins-src/dsh-plugins-market/README.md`](./plugins-src/dsh-plugins-market/README.md) |
| **安装** | 装插件（唯一的安装文档） | [`README-安装说明.md`](./README-安装说明.md) |
| | 开发插件时隔离环境 | [`README-开发环境隔离.md`](./README-开发环境隔离.md) |
| **兼容** | 每个 dsh 版本支持到什么程度 | [`docs/版本兼容矩阵.md`](./docs/版本兼容矩阵.md) |
| | 兼容策略、注意事项、踩过的坑 | [`docs/注意事项.md`](./docs/注意事项.md) |
| | 机器可读的运行时矩阵 | [`compatibility.json`](./compatibility.json) |
| **插件本体** | 插件清单 / 版本 / 安装说明 | **各插件自己的源码仓库** —— 地址见 [`README-安装说明.md` 第一节](./README-安装说明.md) 的表 |
| **贡献** | 怎么贡献、收录规范、PR 检查清单 | [`CONTRIBUTING.md`](./CONTRIBUTING.md) |

---

<a name="contributing"></a>

## 🤝 贡献 · Contributing

**欢迎参与。** 作为市场，这里的贡献方式比一般开源项目宽得多 —— **不写插件也能帮上忙。**

| 优先级 | 类型 | 说明 |
|---|---|---|
| ★★★ | **补齐新 dsh 版本的适配结论** | dsh 迭代很快，仓库最容易过时的地方就是这里 |
| ★★ | **修正采集结果与兼容信息** | 发现某个配置文件的版本 / star / 安装方法不对，或 `compatibility.json` 有错 |
| ★★ | **给第三方插件补上实测记录** | 真机装一次、留下证据，写进 `catalog/overrides/curated.json`（补事实，不是打标签） |
| ★ | **改进采集脚本与文档** | `scripts/sync-catalog.mjs`、市场面板、或本目录下的文档 |

**没把握就先开 Issue 问。** 发现上游插件出新版本、或 dsh 发布新版本，也欢迎开 Issue 告知。

**完整规范见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)**：配置文件与目录规则、来源标注义务、
新 dsh 版本的适配流程、`market-review.mjs` 收录助手用法，以及提交前的检查清单
（`node scripts/sync-catalog.mjs --check`）。

> 若某个包的 `author` / `repository` 缺失且查不到上游，**不要猜**：
> 按规范标注「未注明」并说明核实过程 —— 版权准确性优先于表格美观。

---

<a name="license"></a>

## ⚖️ 许可 · License

- 本仓库**自身的**代码与文档：MIT
- **第三方插件的版权归各自原作者所有。** 自 0.4.0（市场与插件分离）起，本仓库
  **不再分发**任何第三方插件的字节，也不再重新打包自研插件：目录里只记录
  版本、仓库地址、许可与**安装方式**，安装时去上游取。第三方插件的许可以其上游为准
- 如你是某个插件的原作者，希望本仓库移除或调整收录方式，
  请开 Issue 或直接联系，我们会立即处理

---

<p align="center">
  <sub>万物皆插件 · Everything is a plugin — 如果这个仓库帮到了你，欢迎 ⭐ Star；有问题开 Issue 交流。</sub>
</p>
