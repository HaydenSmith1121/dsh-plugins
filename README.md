# dsh-plugins

DeepSeek Harness（dsh）插件仓库。每个插件独立放在 `plugins/<插件名>/<dsh 版本>/` 下，
便于增量添加、互不干扰，也能同时容纳适配不同 dsh 版本的插件包。

**内容构成**：部分是自研插件，部分是收集整理的他人开源插件。
所有插件均为 **MIT** 许可；第三方插件的版权归原作者所有，来源与许可见
[三、插件来源与许可](#三插件来源与许可)。

> **运行时基线：dsh `0.1.6-alpha.1`** —— 这个版本不是随便选的，见
> [五、运行时版本兼容矩阵](#五运行时版本兼容矩阵)。
> 仓库内含离线 tarball，可在新机上完整复现。

---

## 一、30 秒开始

> ## ⚠️ 只提供一种安装方式：**GUI 里的插件市场**
>
> 自 2026-09 起，插件**一律通过「插件市场」面板安装**，不再逐个用命令行装。
> 市场在每次安装前会跑兼容性闸门（环境 / profile / 候选包三层），致命项硬拦截，
> 失败自动回滚 —— 这是批量安装脚本给不了的保护。
>
> 流程：**装引导插件（市场本身）→ 重启 → 在面板里点装其余插件。**

前置只有一个：**Node ≥ 22.19**。

```bash
git clone https://github.com/HaydenSmith1121/dsh-plugins
cd dsh-plugins
```

### 第 1 步：装引导插件（唯一需要命令行的安装）

| 平台 | 命令 |
|---|---|
| Windows | `scripts\install.cmd` |
| Windows（PowerShell 里） | `.\scripts\install.ps1` |
| macOS / Linux | `./scripts/install.sh` |

脚本会**先检测这台机器的环境、再决定装什么**：检查 Node / dsh / pnpm，
缺 pnpm 就补上（且补在 dsh 所在的那个 Node 上），dsh 版本不匹配就停下来
告诉你该装哪个版本，然后**只装 `dsh-plugins-market` 这一个引导插件**并做四步校验。

不改动任何东西、只看体检结果：

```powershell
.\scripts\install.ps1 -PreflightOnly
```

### 第 2 步：在面板里点装其余插件

```bash
dsh web
```

左侧导航栏 →「插件市场」→「已验证」页签 → 挑插件点「安装」→ **再重启一次**。

**逐条命令的手动步骤见 [`README-安装说明.md`](./README-安装说明.md)** ——
那是唯一的安装文档，自包含，所有容易出错的地方都已写成预防措施和自检项。

---

## 一之二、要开发插件？先隔离环境

如果你打算**在本机开发/调试插件**，别直接在默认的 `~/.dsh` 上做 ——
`dsh web` 不能起两次，第二个进程会抢端口，旧页面随之断连；
插件树改坏则整个 harness 起不来。

仓库自带一套隔离脚手架，把「日常在用的 harness」和「开发插件的 harness」分成两套：

```bash
node scripts/dev-env.mjs init     # 在 ~/.dsh-dev 建一套独立的 harness
node scripts/dev-env.mjs web      # 启动隔离环境（3090），依赖由首次启动自动安装
```

> 不用手动 `pnpm install` —— 首次 `dsh web` 会自己建出 profile 并装好依赖。

**Windows 上最省事的起法**：双击仓库根目录的 **`启动-调试环境-3090.cmd`**，
或者用任意一个薄壳入口（三者等价）：

```powershell
.\启动-调试环境-3090.cmd          # 双击 / 直接跑
.\scripts\dev-env.ps1 web         # PowerShell
.\scripts\dev-env.cmd web         # cmd（执行策略禁止跑 .ps1 时用这个）
```

起来后浏览器开 **`http://127.0.0.1:3090`**，日常在用的 **3080 完全不受影响**，两套可同时跑。
关掉窗口或 Ctrl+C 即停。

隔离基于 `DSH_HOME`（整个主目录独立），而不是 `--profile`
（那只隔离插件树，凭据/设置/会话仍共享）。脚本不含任何硬编码盘符，
**换设备 clone 后直接可用**。

完整说明 + 自检 + 常见坑见 **[`README-开发环境隔离.md`](./README-开发环境隔离.md)**。

> **往隔离环境装插件**（改完插件重新打包后也必须**先 remove 再 add**，原因见下）：
>
> ```bash
> node scripts/dev-env.mjs install plugins/<包名>/<dsh版本>/<包名>-<版本>.tgz
> ```
>
> ⚠️ 同一个 tarball 路径内容变了时，pnpm 会认为 lockfile 是新的、**跳过解包**
> （`Lockfile is up to date, resolution step is skipped`），加 `--force` 也只重新链接、
> 不重新解包 —— 你会一直在跑旧代码。所以更新一个**已经装过的**插件要：
> `dsh plugin --profile web remove <包名>` → 再 `add`。

---

## 二、目录结构

```none
dsh-plugins/
├─ README.md                        # 本文件：总览 / 来源 / 兼容策略 / 贡献入口
├─ README-安装说明.md                # ★ 安装教程（唯一的安装文档，自包含）
├─ README-开发环境隔离.md            # ★ 开发插件时的环境隔离（可移植到新设备）
├─ 启动-调试环境-3090.cmd            # ★ 双击即起隔离调试环境（3090），不影响日常的 3080
├─ CONTRIBUTING.md                  # ★ 插件入库规范（新插件请照此提交）
├─ compatibility.json               # ★ 机器可读的版本兼容矩阵，安装脚本据此判定
├─ catalog/                         # ★ 插件市场的目录数据
│  ├─ verified-meta.json            #   已验证层的**展示**元数据（标题 / 简介 / 标签）
│  └─ curated.json                  #   已审核层：人工审核收录的第三方插件（含审核证据）
├─ scripts/
│  ├─ preflight.mjs                 # 环境预检（只读）：检测 + 判定 + 给出行动方案
│  ├─ install.mjs                   # 安装执行器（两平台共用同一份逻辑）
│  ├─ verify.mjs                    # 安装后四步校验（含真实启动）
│  ├─ dev-env.mjs                   # ★ 开发环境隔离（init/status/doctor/web/install…）
│  ├─ market-review.mjs             # ★ 市场收录助手：探测候选包 → 产出审核草稿条目
│  ├─ install.ps1 / install.cmd     # Windows 入口（薄壳）
│  ├─ install.sh                    # macOS / Linux 入口（薄壳）
│  └─ dev-env.ps1 / dev-env.cmd / dev-env.sh   # 隔离脚本的薄壳入口
├─ plugins-src/                     # ★ 带源码的插件（本仓库第一个）
│  └─ dsh-plugins-market/           #   可视化插件市场：src/ + build.mjs + test/ + README
├─ plugins/                         # 每个插件一个目录，其下按 dsh 版本分层
│  ├─ dsh-plugins-market/
│  │  └─ 0.1.6-alpha.1/             # 自研（本仓库自带的市场面板；源码在 plugins-src/）
│  ├─ dsh-market-plugin/
│  │  └─ 0.1.6-alpha.1/
│  │     └─ dsh-market-plugin-0.4.8.tgz
│  ├─ dsh-workbuddy-connect/
│  │  └─ 0.1.6-alpha.1/
│  ├─ dsh-opencode-go-plus/
│  │  └─ 0.1.6-alpha.1/             # 自研维护分支，取代 dsh-opencode-go
│  ├─ dsh-connect-trae/
│  │  └─ 0.1.6-alpha.1/
│  ├─ dsh-workbuddy-quota/
│  │  └─ 0.1.6-alpha.1/             # 自研
│  ├─ dsh-receipt/
│  │  └─ 0.1.6-alpha.1/
│  ├─ dsh-session-cleanup/
│  │  └─ 0.1.6-alpha.1/             # 自研
│  ├─ dsh-ark-plans/
│  │  └─ 0.1.6-alpha.1/             # 自研（火山方舟 Agent Plan + Coding Plan 模型接入）
│  └─ dsh-excel-viewer/
│     └─ 0.1.6-alpha.1/             # 自研（表格预览：xlsx / xlsm / xls / csv / tsv）
├─ profile-config/
│  └─ profile-bundles.yaml          # web profile 的 bundles 顺序清单
└─ settings/
   └─ settings.yaml                 # 默认模型 / trae 模型目录（不含密钥）
```

> **`plugins/<包名>/<dsh 版本>/` 里的那一层是 dsh 运行时版本，不是插件版本。**
> 含义是「这套 tarball 适配 dsh 的哪个版本」。装哪一套由你机器上的 dsh 版本决定，
> 安装脚本会自动选。

---

## 三、插件来源与许可

以各插件 `package.json` 的 `author` / `repository` 字段为准；
**这两个字段缺失时，以包内 README 声明的上游为准**（下表已逐项核实）。

| 包名 | 版本 | 来源 | 原作者 | 上游仓库 | 许可 |
|---|---|---|---|---|---|
| `dsh-workbuddy-quota` | 0.2.0 | **本仓库自研** | HaydenSmith1121 | 本仓库 | MIT |
| `dsh-session-cleanup` | 0.1.2 | **本仓库自研** | HaydenSmith1121 | 本仓库 | MIT |
| `dsh-ark-plans` | 0.1.0 | **本仓库自研** | HaydenSmith1121 | 本仓库 | MIT |
| `dsh-memory` | 0.1.0 | **本仓库自研** | HaydenSmith1121 | 本仓库 | MIT |
| `dsh-opencode-go-plus` | 0.3.0 | **本仓库自研**（派生） | HaydenSmith1121 | 本仓库，派生自 [Duskriver/dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go) | MIT |
| `@dsh-market/plugin` | 0.4.8 | 第三方收集 | **2BingLing** | [2BingLing/dsh-market](https://github.com/2BingLing/dsh-market) | MIT |
| `dsh-workbuddy-connect` | 0.5.3 | 第三方收集 | corrinehu | [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | MIT |
| `dsh-connect-trae` | 2.0.1 | 第三方收集 | dingminhua | [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) | MIT |
| `dsh-receipt` | 0.1.0 | 第三方收集 | — | [deronendless/dsh-receipt](https://github.com/deronendless/dsh-receipt) | MIT |
| `dsh-excel-viewer` | 0.1.0 | **本仓库自研**（内联第三方） | HaydenSmith1121 | 本仓库 | MIT |

> **关于 `@dsh-market/plugin`**：该包的 `package.json` **没有** `author` 与
> `repository` 字段，来源是依据包内 `README.md` 声明的上游核实的 ——
> 上游仓库 `2BingLing/dsh-market`，Web 版 <https://dsh.market/>，
> 插件数据源 `https://2bingling.github.io/dsh-market/plugins.json`。
> 该包自称要求 DSH ≥ 0.1.5、Node ≥ 20。
> ⚠️ 其 tarball 内**未附带 LICENSE 文件正文**（`package.json` 中 `license` 为 MIT）。

> **关于 `dsh-excel-viewer`**：这是本仓库自研的**客户端渲染器**，但它的 tarball 里
> **内联分发**了 SheetJS Community Edition 0.20.3（Apache-2.0，取自 SheetJS 官方 CDN）——
> 不是运行时依赖：dsh 的浏览器模块表只提供 `react` 与 `@deepseek-ai/*`，插件 bundle 里出现别的
> `require(...)` 会在用户打开文件时抛错，所以解析器必须在构建期内联进 `lib/client.js`。
> 选官方 CDN 的 0.20.3 而不是 npm 上的 0.18.5，是因为后者已停更且带已在后续版本修复的安全问题
> （原型污染 CVE-2023-30533、ReDoS CVE-2024-22363），而本插件解析的正是用户文件。
> 版权头在构建时以 `legalComments: inline` 保留，完整归属、内联方式与合规动作见包内
> `THIRD_PARTY_NOTICES.md`。

> **关于 `dsh-opencode-go-plus`**：这是本仓库维护的**派生包**，标在「自研」一栏是因为
> 它的打包、修复与分发都由本仓库负责 —— 但它的代码**不是**从零写的，归属必须讲清楚：
>
> | 层 | 来源 |
> |---|---|
> | 适配器、设置 UI、协议转换模块 | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT） |
> | 包外壳、构建、`docs/`、`examples/` | [Duskriver/dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go)（MIT） |
> | 本仓库的宿主侧修复 | 本仓库（MIT） |
>
> 基线是 `dsh-opencode-go@0.1.2`，只改宿主侧逻辑，`lib/client.js` 未动。完整归属与改动清单见
> 包内 `THIRD_PARTY_NOTICES.md`、`docs/derivation.md`。上游版权不因派生而被吞掉。
>
> ⚠️ **它取代了此前的 `dsh-opencode-go@0.1.2`（含 13 处本地源码改动那一版），两者不能装进同一个
> profile** —— 共用设置命名空间与 provider 路由，实测存在一种组合会让 `dsh web` 完全起不来。
> 详见 [`README-安装说明.md` 第十节](./README-安装说明.md) 与包内 `docs/verification.md`。

**第三方插件的版权归各自原作者所有**，本仓库仅做离线打包与索引，未修改其许可声明。

---

## 四、插件清单

> **安装方式**：下表里的插件**都从「插件市场」面板里点装**（见
> [四之一](#四之一可视化插件市场dsh-plugins-market)）。命令行的 `install` 脚本
> 只负责装引导插件 `dsh-plugins-market`；不再提供逐个装插件的方式。
> 下表的「安装顺序」记录的是 bundle 层级顺序（市场点装时会自动维持），
> 供排查装配问题时对照。

| 目录 | 包名 | 插件版本 | 适配 dsh | 说明 |
|---|---|---|---|---|
| `plugins/dsh-plugins-market/` | `dsh-plugins-market` | 0.1.0 | 0.1.6-alpha.1 | **本仓库自带的可视化插件市场**（三层目录 + 装前兼容性闸门 + 失败自动回滚；**带源码**，见 `plugins-src/`） |
| `plugins/dsh-market-plugin/` | `@dsh-market/plugin` | 0.4.8 | 0.1.6-alpha.1 | dsh 插件市场（第三方，公共索引） |
| `plugins/dsh-workbuddy-connect/` | `dsh-workbuddy-connect` | 0.5.3 | 0.1.6-alpha.1 | WorkBuddy 连接 |
| `plugins/dsh-opencode-go-plus/` | `dsh-opencode-go-plus` | 0.3.0 | 0.1.6-alpha.1 | OpenCode Go 模型供应商（**自研维护分支，取代 `dsh-opencode-go`**；配置入口在「设置 → 模型」页的 OpenCode Go 行） |
| `plugins/dsh-connect-trae/` | `dsh-connect-trae` | 2.0.1 | 0.1.6-alpha.1 | Trae 模型接入 |
| `plugins/dsh-workbuddy-quota/` | `dsh-workbuddy-quota` | 0.2.0 | 0.1.6-alpha.1 | WorkBuddy 额度显示 + token 用量统计 |
| `plugins/dsh-receipt/` | `dsh-receipt` | 0.1.0 | 0.1.6-alpha.1 | 凭证 / 收据 |
| `plugins/dsh-session-cleanup/` | `dsh-session-cleanup` | 0.1.2 | 0.1.6-alpha.1 | 已归档会话的真实删除（**带宿主半**） |
| `plugins/dsh-ark-plans/` | `dsh-ark-plans` | 0.1.0 | 0.1.6-alpha.1 | 火山方舟 **Agent Plan + Coding Plan** 模型接入（**纯组合配置 + 凭据诊断**，无 wire 代码） |
| `plugins/dsh-memory/` | `dsh-memory` | 0.1.0 | 0.1.6-alpha.1 | **跨会话长期记忆**：turn 结束自动蒸馏成 markdown 笔记，下次会话自动作为提示段召回（**纯宿主半**，零包导入；**带源码**，见 `plugins-src/`） |
| `plugins/dsh-excel-viewer/` | `dsh-excel-viewer` | 0.1.0 | 0.1.6-alpha.1 | Excel / CSV 表格预览（**纯客户端渲染器，宿主半为空**；内联 SheetJS，见包内 `THIRD_PARTY_NOTICES.md`） |

**安装顺序**（即 dsh bundle 层级顺序，见 `profile-config/profile-bundles.yaml`）：

```none
@dsh-market/plugin → dsh-workbuddy-connect → dsh-opencode-go-plus
→ dsh-connect-trae → dsh-workbuddy-quota → dsh-receipt → dsh-session-cleanup
→ dsh-ark-plans → dsh-memory → dsh-plugins-market → dsh-excel-viewer
```

> `dsh-plugins-market` 排在最后：插件市场的面板本身不依赖别的插件，
> 但放在最后可以让它的 patch 层在装配时最后生效，装/卸其它插件时不会互相干扰。
> `dsh-memory` 同理排在 `dsh-ark-plans` 之后、市场之前 —— 它是普通的宿主半插件，
> 不参与任何 patch 覆盖，没有理由插到别的前面去。

> `dsh-excel-viewer` 追加在这条链的末尾：它只在客户端注册一个文档渲染器，不覆盖任何 patch 行，
> 也不依赖别的插件。追加在末尾是约定而不是依赖关系 —— 列表顺序才是唯一事实来源。

### 四之一、可视化插件市场（`dsh-plugins-market`）

装完重启 `dsh web` 后，左侧导航栏会出现「插件市场」图标。它的三层目录：

| 层 | 来源 | 提示 | 装前检查 |
|---|---|---|---|
| **已验证** | 本仓库自带、已实测（见上表） | ✅ 可直接安装 | 必须全绿，有问题直接硬拦截 |
| **已审核** | 人工审核收录（`catalog/curated.json`） | 含审核日期与 dsh 版本 | 同样要过闸门 |
| **未审核** | 公共索引全部插件（7487 个） | ⚠️ 可能不兼容 | 远程静态探测，**必须显式确认风险** |

三层是同一个界面里的并列视角。**其余插件的安装入口就是这里** ——
「已验证」层用仓内离线 tarball，点一下就装，装前检查全绿才放行。

它和第三方公共市场（`@dsh-market/plugin`）**并存、不冲突**，差别在安全模型 ——
本插件每次安装都先过一道兼容性闸门（环境 / profile / 候选包三层），
致命项分「已知有害（硬拦截、不可覆盖）」与「无法确认（可覆盖、需显式确认）」两档，
安装全程事务化，失败自动回滚。完整说明见
[`plugins-src/dsh-plugins-market/README.md`](./plugins-src/dsh-plugins-market/README.md)。

**要往「已审核」层加插件**：先跑收录助手，再按提示在隔离环境真装一次并记录证据，最后填完
`review` 字段写进 `catalog/curated.json`：

```bash
node scripts/market-review.mjs <owner/repo | npm 包名>
```

---

## 五、运行时版本兼容矩阵

照各包 `package.json` 的 `peerDependencies` 逐一实测（**这是选 dsh 版本的唯一依据**）：

| 插件 | 要求的 `@deepseek-ai/dsh-llm` | 0.1.5-rc.x | 0.1.6-alpha.1 |
|---|---|---|---|
| `@dsh-market/plugin` | 无 `@deepseek-ai` peer | ✓ | ✓ |
| `dsh-workbuddy-connect` | `^0.1.5-rc.1` | ✓ | ✓（仅 peer 警告） |
| **`dsh-opencode-go-plus`** | **`0.1.6-alpha.1`（精确 pin）** | **✗** | **✓** |
| `dsh-connect-trae` | `>=0.1.5-0 <0.2.0-0` | ✓ | ✓ |
| `dsh-workbuddy-quota` | 仅 cordis / react | ✓ | ✓ |
| `dsh-receipt` | `cordis@4.0.1`、`dsh-session@0.1.0-rc.6`、`dsh-tools@0.1.0-rc.6` | ✓ | ✓（仅 peer 警告） |
| `dsh-session-cleanup` | 仅 cordis / react | ✓ | ✓ |
| `dsh-ark-plans` | `@deepseek-ai/dsh-llm-pi-ai` / `dsh-credentials` 精确 pin `0.1.6-alpha.1` | ✗ | ✓ |
| `dsh-memory` | 仅 cordis（宿主半零包导入） | ✓ | ✓ |
| `dsh-excel-viewer` | 仅 cordis / react（SheetJS 内联，非运行时依赖） | ✓ | ✓ |

**→ 整批插件以 `0.1.6-alpha.1` 为基线。**

`dsh-opencode-go-plus` 没有任何兼容 0.1.5 的发布版本（其基线 `0.1.0` / `0.1.1` / `0.1.2`
全都要求 alpha），所以**只能升 dsh，不能退插件**。

### ⚠️ 两条必须记住的规矩

1. **安装 dsh 必须显式带版本号**：

   ```bash
   npm i -g @deepseek-ai/dsh@0.1.6-alpha.1
   ```

   npm 的 `latest` 通道是 `0.1.5-rc.1`，**默认装的那个版本不够用**。

2. **永远不要跑不带版本的升级**：`npm i -g @deepseek-ai/dsh` 会**静默降级**回
   `0.1.5-rc.1`，插件立刻又炸，且没有任何提示。升级后请重跑
   `node scripts/verify.mjs`。

> 机器可读版本：以上全部结论同时记录在 [`compatibility.json`](./compatibility.json)，
> 安装脚本读它来判定该装哪一套插件。

---

## 六、兼容性与版本策略

本仓库的目标是**事前兼容**而不是事后排错：让用户拿到手就能装对版本，
而不是装完启动失败再回来查文档。

### 为什么按 dsh 版本分层

插件对 dsh 运行时（`@deepseek-ai/*`）的依赖有两种写法，都会导致「只适配有限版本」：

- **精确 pin**（`dsh-opencode-go-plus` 的 `0.1.6-alpha.1`）—— 换版本即崩
- **窄范围**（`dsh-workbuddy-connect` 的 `^0.1.5-rc.1`）—— 换版本可能只是警告，也可能是隐患

所以同一个插件在 dsh 不同版本下往往**需要不同的构建产物**。
目录结构 `plugins/<包名>/<dsh 版本>/` 就是为此预留的：
新 dsh 版本发布后，**增量补一套目录即可，不影响已有的**。

### 当前支持状态

| dsh 版本 | 通道 | 状态 | 说明 |
|---|---|---|---|
| `0.1.6-alpha.1` | alpha | ✅ **支持**（已实测 11/11 加载成功） | 当前基线 |
| `0.1.5-rc.1` | latest | ❌ 不支持 | 内置 `dsh-llm` 缺 0.1.6 的导出，启动即失败 |
| `0.1.5-rc.2` | next | ❌ 不支持 | 同上 |

### 遇到本仓库未适配的 dsh 版本怎么办

安装脚本会明确告诉你「本仓库尚未适配这个版本」，而不是硬装一个不兼容的组合。
想让它支持，见 [`CONTRIBUTING.md`](./CONTRIBUTING.md) 里
「新增一个 dsh 运行时版本」一节 —— 这是最受欢迎的一类贡献。

---

## 七、贡献

欢迎参与维护，尤其是以下三类：

1. **补齐新 dsh 版本的适配包** —— 让仓库跟上 dsh 的迭代
2. **提交新插件** —— 按规范入库
3. **修正兼容性信息** —— 发现 `compatibility.json` 或本文档有错，直接提 PR

**完整规范见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)**，含：

- 插件准入条件（必须声明 `dsh.bundle`、必须说明适配的 dsh 版本范围、必须通过真实启动验证）
- **来源标注义务**（自研 / 第三方 + 原作者 + 上游仓库 + 许可，缺失时如何标注）
- 多版本目录结构与命名规则
- 打包、入库、提交流程
- PR 检查清单

> 如果某个包的 `author` / `repository` 字段缺失、也查不到上游，**不要猜** ——
> 按规范标注为「第三方收集，作者未注明」，并说明核实过程。
> 版权准确性比表格好看重要。

---

## 八、tarball 校验信息

每个 tarball 均已验证含 `package.json` + `cordis.patch.yml` + `lib/`：

| 插件 | 版本 | 文件数 | cordis.patch.yml | lib | LICENSE |
|---|---|---|---|---|---|
| `@dsh-market/plugin` | 0.4.8 | 7 | ✓ | ✓ | ✗ |
| `dsh-workbuddy-connect` | 0.5.3 | 11 | ✓ | ✓ | ✓ |
| `dsh-opencode-go-plus` | 0.3.0 | 31 | ✓ | ✓ | ✓ |
| `dsh-connect-trae` | 2.0.1 | 12 | ✓ | ✓ | ✓ |
| `dsh-workbuddy-quota` | 0.2.0 | 5 | ✓ | ✓ | ✗ |
| `dsh-receipt` | 0.1.0 | 16 | ✓ | ✓ | ✓ |
| `dsh-session-cleanup` | 0.1.2 | 6 | ✓ | ✓ | ✓ |
| `dsh-ark-plans` | 0.1.0 | 6 | ✓ | ✓ | ✓ |
| `dsh-memory` | 0.1.0 | 6 | ✓ | ✓ | ✓ |
| `dsh-excel-viewer` | 0.1.0 | 7 | ✓ | ✓ | ✓ |

自查命令：

```bash
for f in plugins/*/*/*.tgz; do
  printf "%-62s files=%s cordis=%s lib=%s lic=%s\n" "$f" \
    "$(tar -tzf "$f" | grep -vc '/$')" \
    "$(tar -tzf "$f" | grep -c 'cordis.patch.yml')" \
    "$(tar -tzf "$f" | grep -c 'package/lib/')" \
    "$(tar -tzf "$f" | grep -ciE 'package/LICENSE' )"
done
```
