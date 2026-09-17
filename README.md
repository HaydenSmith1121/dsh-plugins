<p align="center">
  <img src="assets/hero-everything-is-a-plugin.svg" alt="万物皆插件 — Everything is a plugin：模型、工具、界面、工作流经同一套 contract 组合进同一个 DeepSeek Harness 运行时" width="100%">
</p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/Upstream-DeepSeek_Harness-4D6BFE?style=flat-square" alt="Upstream: DeepSeek Harness"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-2EA44F?style=flat-square" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Baseline-dsh_0.1.6--alpha.1-8B5CF6?style=flat-square" alt="Runtime baseline: dsh 0.1.6-alpha.1">
  <img src="https://img.shields.io/badge/Plugins-11-0EA5E9?style=flat-square" alt="11 plugins">
</p>

<p align="center">
  <strong>万物皆插件</strong> —— 自研 + 精选的 DeepSeek Harness 插件分发层：离线 tarball · 装前兼容闸门 · 不可变收录快照<br>
  <sub>A curated distribution layer for DeepSeek Harness — offline tarballs, pre-install compatibility gates, immutable snapshots.</sub>
</p>

<p align="center">
  <a href="#quickstart">🚀 快速开始</a> ·
  <a href="#install">📖 安装教程</a> ·
  <a href="#docs">🗺️ 文档地图</a> ·
  <a href="#plugins">🧩 插件清单</a> ·
  <a href="#contributing">🤝 贡献</a> ·
  <a href="#license">⚖️ 许可</a>
</p>

---

<a name="why"></a>

## 💡 立意 · Why

> **模型、工具、界面、工作流，都可以是一个插件。**
> 插件遵循同一套 contract，装在一起即可协同工作、互不干扰。

DeepSeek Harness 是一个**可组合的 agent harness**：模型、工具、界面、工作流都是独立的能力单元，
按同一套 contract 组合进同一个运行时 —— 这正是 [Cordis](https://github.com/cordiverse/cordis)
的插件思想，也是本仓库存在的理由。

本仓库补齐同一件事的另一半：**让这些能力单元装得上、装得对、随时可复现。**

| | 上游负责 | 本仓库负责 |
|---|---|---|
| **关注点** | 能力如何被组合 | 组合件如何被可靠分发 |
| **产出** | agent、模型、工具、会话、插件系统 | 离线 tarball、兼容矩阵、装前闸门、收录快照 |
| **失败模式** | —— | 上游一更新，就装不回验证过的那一版 |

所以这里不是插件包的简单集合，而是**围绕兼容性设计的分发层**：
按 dsh 版本分层、装前兼容性闸门、失败自动回滚，并把验证过的字节固定为不可变快照。

> **运行时基线：dsh `0.1.6-alpha.1`** —— 选型依据见[版本兼容矩阵](./docs/版本兼容矩阵.md)；
> 仓内含全部离线 tarball 与[收录快照](./collection/README.md)，新机可完整复现。

**内容构成**：自研插件 + 收集整理的第三方开源插件，统一 **MIT** 许可；
第三方插件的版权归原作者所有，来源、作者与上游仓库见
[插件清单](#plugins)与[收录介绍](./collection/README.md)。

---

<a name="quickstart"></a>
<a name="一30-秒开始"></a>

## 🚀 快速开始 · Quick Start

**前置要求只有一个：Node ≥ 22.19**（[nodejs.org](https://nodejs.org/)）。一条命令装完，不用 clone、不用 `cd`。

**Windows（PowerShell）**

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main/scripts/install.ps1).TrimStart([char]0xFEFF)))
```

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main/scripts/install.sh | sh
```

脚本会先把仓库 clone 到 `~/.dsh-plugins`（已存在则原地更新），再自动完成：环境预检 →
判定 dsh 版本是否匹配 → 补装 pnpm 与 `allowBuilds` → 装插件（默认全部，`-BootstrapOnly` /
`--bootstrap-only` 只装市场）→ 四步校验（含真实启动）。

装完重启 `dsh web`，左侧导航 →「插件市场」，其余插件在面板里点装。

<details>
<summary><strong>🔧 常用参数</strong>（点开）</summary>

| 参数（PowerShell / sh） | 作用 |
|---|---|
| `-PreflightOnly` / `--preflight-only` | 只体检，不做任何改动 |
| `-DryRun` / `--dry-run` | 只打印将要执行的命令 |
| `-BootstrapOnly` / `--bootstrap-only` | 只装引导插件 `dsh-plugins-market` |
| `-SkipVerify` / `--skip-verify` | 跳过装完的四步校验 |
| `-Profile web` / `--profile web` | 指定 profile，默认 `web` |

在命令末尾接参数即可，例如只体检：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main/scripts/install.ps1).TrimStart([char]0xFEFF))) -PreflightOnly
```

> **为什么不写成更短的 `irm ... | iex`？** 脚本含中文、文件带 UTF-8 BOM，
> `Invoke-Expression` 直接吃 BOM 会以
> `The assignment expression is not valid` 解析失败。
> `[scriptblock]::Create(...)` 先去掉 BOM 再执行，顺带还能正常传参。
> 先落地成文件再跑也可以：
> `iwr <同一地址> -OutFile $env:TEMP\dsh-install.ps1; & $env:TEMP\dsh-install.ps1`

</details>

**遇到问题？** 常见故障按层次对号入座：

| 症状 | 去看 |
|---|---|
| `dsh --version` 不是 `0.1.6-alpha.1` | [版本兼容矩阵 § 两条必须记住的规矩](./docs/版本兼容矩阵.md#二两条必须记住的规矩) |
| 装到一半报 `ERR_PNPM_IGNORED_BUILDS` | [注意事项 § 这个报错极具欺骗性](./docs/注意事项.md#-特别当心errpnpmignoredbuilds-的假象) |
| GUI 里看不到某个插件 | [安装教程 § 排查顺序](./README-安装说明.md#七gui-里看不到某个插件按这个顺序查) |
| 想退掉某个插件 | [安装教程 § 卸载 / 回滚](./README-安装说明.md#九卸载-回滚) |

---

<a name="install"></a>

## 📖 安装教程 · Install Guide

**全文见 [`README-安装说明.md`](./README-安装说明.md)** —— 唯一、自包含的安装文档：
每个易错点都配了预防措施与自检项，照着走即可一次装对。

<details>
<summary><strong>📑 章节速查</strong>（11 章 + 附录，点开定位）</summary>

| 章节 | 内容 | 什么时候看 |
|---|---|---|
| [一、30 秒开始](./README-安装说明.md#一30-秒开始) | clone → 装引导插件 → 面板点装 | 第一次装 |
| [二、环境要求](./README-安装说明.md#二环境要求) | Node / pnpm / dsh 的版本要求 | 装之前 |
| [三、dsh 版本为什么锁死](./README-安装说明.md#三dsh-版本为什么必须锁定-016-alpha1) | 版本不对会怎样、静默降级陷阱 | 升级 dsh 之前 ★ |
| [四、手动安装](./README-安装说明.md#四手动安装不想用脚本时) | 不想用脚本时逐条命令 | 脚本用不了 |
| [五、路径要求](./README-安装说明.md#五路径要求-装之前先看) | 仓库目录不能删、不能挪 | 装之前 ★ |
| [六、安装后校验](./README-安装说明.md#六安装后校验四步缺一不可) | 版本 / 依赖层 / 装配层 / 真实启动 | 装完 |
| [七、看不到插件怎么查](./README-安装说明.md#七gui-里看不到某个插件按这个顺序查) | 按层次定位，含 `ERR_PNPM_IGNORED_BUILDS` | 出问题时 |
| [八、凭据不随包迁移](./README-安装说明.md#八凭据与登录态不随包迁移) | API key / 登录态要重填 | 换机器 |
| [九、卸载 / 回滚](./README-安装说明.md#九卸载-回滚) | `dsh plugin remove` 与备份 | 想退掉插件 |
| [十、`dsh-opencode-go-plus` 的来历](./README-安装说明.md#十关于-dsh-opencode-go-plus-的来历改造与共存禁忌) | 派生来源、共存禁忌 | 用到这个插件 |
| [附录：tarball 校验信息](./README-安装说明.md#附录tarball-校验信息) | 每个 tarball 的内容自检 | 核对分发内容 |

</details>

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
| **安装** | 装插件（唯一的安装文档） | [`README-安装说明.md`](./README-安装说明.md) |
| | 开发插件时隔离环境 | [`README-开发环境隔离.md`](./README-开发环境隔离.md) |
| **兼容** | 每个 dsh 版本支持到什么程度 | [`docs/版本兼容矩阵.md`](./docs/版本兼容矩阵.md) |
| | 兼容策略、注意事项、踩过的坑 | [`docs/注意事项.md`](./docs/注意事项.md) |
| **仓库** | 仓库里都有什么文件、怎么分层 | [`docs/目录结构.md`](./docs/目录结构.md) |
| | 插件清单 / 来源 / 许可 / tarball 校验 | [`docs/插件清单与来源.md`](./docs/插件清单与来源.md) |
| **收录** | 什么是收录快照、收录的是哪一版 | [`docs/收录说明.md`](./docs/收录说明.md) |
| | 收录规范（新增收录必须遵守，规范性文档） | [`collection/SPEC.md`](./collection/SPEC.md) |
| | 收录快照目录本身 | [`collection/README.md`](./collection/README.md) |
| **市场** | 插件市场的三层目录与安全模型 | [`plugins-src/dsh-plugins-market/README.md`](./plugins-src/dsh-plugins-market/README.md) |
| **贡献** | 怎么贡献、入库规范 | [`CONTRIBUTING.md`](./CONTRIBUTING.md) |

---

<a name="plugins"></a>

## 🧩 插件清单 · Plugins

**共 11 个插件**：自研 7 / 第三方 4，全部以 dsh `0.1.6-alpha.1` 为运行时基线，
**全部从「插件市场」面板安装**。

| 插件 | 作用 | 来源 |
|---|---|---|
| `dsh-plugins-market` | **可视化插件市场（本仓库的安装入口）**：三层目录 + 装前兼容性闸门 + 失败自动回滚 | 自研 |
| `dsh-memory` | 跨会话长期记忆：turn 结束自动蒸馏成笔记，下次会话自动召回 | 自研 |
| `dsh-ark-plans` | 火山方舟 Agent Plan + Coding Plan 模型接入 | 自研 |
| `dsh-opencode-go-plus` | OpenCode Go 模型供应商（自研维护分支，取代 `dsh-opencode-go`） | 自研（派生） |
| `dsh-excel-viewer` | Excel / CSV 表格预览 | 自研（内联 SheetJS） |
| `dsh-workbuddy-quota` | WorkBuddy 额度显示 + token 用量统计 | 自研 |
| `dsh-session-cleanup` | 已归档会话的真实删除 | 自研 |
| `@dsh-market/plugin` | dsh 插件市场（第三方，公共索引） | 第三方 |
| `dsh-workbuddy-connect` | WorkBuddy 连接 | 第三方 |
| `dsh-connect-trae` | Trae 模型接入 | 第三方 |
| `dsh-receipt` | 凭证 / 收据 | 第三方 |

**版本号、原作者、上游仓库、许可、bundle 顺序、tarball 校验信息** →
[`docs/插件清单与来源.md`](./docs/插件清单与来源.md)。

> 命令行脚本仅用于安装引导插件 `dsh-plugins-market`；
> 市场三层目录中的「已验证」层使用仓内离线 tarball，装前检查全绿才放行。

---

<a name="contributing"></a>

## 🤝 贡献 · Contributing

**欢迎参与。** 作为分发层，这里的贡献方式比一般开源项目宽得多 ——
**不写插件也能帮上忙。**

| 优先级 | 类型 | 说明 |
|---|---|---|
| ★★★ | **补齐新 dsh 版本的适配包** | dsh 迭代很快，仓库最容易过时的就是这里 |
| ★★ | **修正兼容性信息** | 发现 `compatibility.json`、版本矩阵或文档有错，直接改、直接提 |
| ★★ | **提交新插件** | 自研的或收集到的都可以 |
| ★ | **改进脚本与文档** | `scripts/` 下的检测、安装、校验逻辑，或安装教程 |

**没把握就先开 Issue 问。** 发现上游插件出新版本、或 dsh 发布新版本，也欢迎开 Issue 告知。

**完整规范见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)**：插件准入条件、来源标注义务、
收录快照登记、多版本目录规则、打包入库流程与 PR 检查清单。

> 若某个包的 `author` / `repository` 缺失且查不到上游，**不要猜**：
> 按规范标注「第三方收集，作者未注明」并说明核实过程 —— 版权准确性优先于表格美观。

---

<a name="license"></a>

## ⚖️ 许可 · License

- 本仓库**自身的**代码与文档：MIT
- **第三方插件版权归各自原作者所有**。本仓库仅做离线打包与索引，
  不修改其许可声明，也不在其之上再声明版权
- 如你是某个插件的原作者，希望本仓库移除或调整收录方式，
  请开 Issue 或直接联系，我们会立即处理

---

<p align="center">
  <sub>万物皆插件 · Everything is a plugin — 如果这个仓库帮到了你，欢迎 ⭐ Star；有问题开 Issue 交流。</sub>
</p>
