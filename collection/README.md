# 收录快照

**[English](README.en.md) | 中文**

本目录固定保存**经过验证的插件 tarball**，以及它们的来源信息。

它的存在只为一件事：**上游更新之后，当时验证过的那一版仍然装得回来。**

---

## ⚠️ 收录的不一定是最新版本

**这是设计意图，不是缺陷。**

本目录收录的是「**在本仓库真机上验证过、装得上、跑得起来**」的那一版，
**不是「上游的最新版」**。两者经常不是同一个版本，而且这是刻意的：

| | 收录原则 | 上游发布节奏 |
|---|---|---|
| 目标 | 验证过的字节可复现 | 持续发新版 |
| 关注点 | 装得上、不崩 | 加功能、改结构 |

上游发新版时，可能出现这些情况 —— 而它们正是收录快照要挡住的：

- 撤回旧版本（unpublish）→ 老用户**装不回来**
- 同一版本号重新发布不同内容 → 装到的**不是验证过的那一份**
- 收紧 `peerDependencies` → 原本可用的 dsh 版本**突然装不上**
- 改动包结构（挪走 `lib/`、去掉 `cordis.patch.yml`）→ 装上了但**界面里没有**

所以：**需要最新版时，先按 [`SPEC.md`](./SPEC.md) 真机验证，再新增一套快照，不覆盖旧版。**

> 每条记录的「是否最新版」在 `manifest.json` 的 `isLatest` 字段里。
> 该字段为 `null` 表示**维护者尚未核实**，不是「否」——
> 核实规则见 [`SPEC.md`](./SPEC.md) 第三节第 3 步③，**禁止凭印象填**。

---

## 收录内容

**运行时基线：`dsh 0.1.6-alpha.1`**（通道 `alpha`）

共 **11** 个包：自研 **7** / 第三方 **4**。

| 包名 | 收录版本 | 来源 | 作者 | 上游仓库 | 许可 |
|---|---|---|---|---|---|
| `@dsh-market/plugin` | 0.4.8 | 第三方 | 2BingLing | [2BingLing/dsh-market](https://github.com/2BingLing/dsh-market) | MIT |
| `dsh-workbuddy-connect` | 0.5.3 | 第三方 | corrinehu | [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | MIT |
| `dsh-connect-trae` | 2.0.1 | 第三方 | dingminhua | [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) | MIT |
| `dsh-receipt` | 0.1.0 | 第三方 | <sub>未注明</sub> | [deronendless/dsh-receipt](https://github.com/deronendless/dsh-receipt) | MIT |
| `dsh-plugins-market` | 0.1.0 | **自研** | HaydenSmith1121 | 本仓库 | MIT |
| `dsh-opencode-go-plus` | 0.3.0 | **自研**（派生） | HaydenSmith1121 | 本仓库，派生自 [Duskriver/dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go) | MIT |
| `dsh-workbuddy-quota` | 0.2.0 | **自研** | HaydenSmith1121 | 本仓库 | MIT |
| `dsh-session-cleanup` | 0.1.2 | **自研** | HaydenSmith1121 | 本仓库 | MIT |
| `dsh-ark-plans` | 0.1.0 | **自研** | HaydenSmith1121 | 本仓库 | MIT |
| `dsh-memory` | 0.1.0 | **自研** | HaydenSmith1121 | 本仓库 | MIT |
| `dsh-excel-viewer` | 0.1.0 | **自研** | HaydenSmith1121 | 本仓库 | MIT |

### 关于来源标注

- **作者**按包内 `package.json` 的 `author` 字段填写
- 该字段缺失时，**依据包内 `README.md` 声明的上游核实**
- 核实不到就写「**未注明**」，**不留空、不猜测**

> **`@dsh-market/plugin`**：`package.json` 没有 `author` / `repository` 字段，
> 来源依据包内 `README.md` 核实的。
> ⚠️ 其 tarball 内**未附 LICENSE 正文**（`package.json` 声明 MIT）。

> **`dsh-receipt`**：`package.json` 有 `repository` 但**没有 `author`**，
> 因此作者标注为「未注明」—— 这是如实记录，不是遗漏。

> **`dsh-opencode-go-plus`**：本仓库维护的**派生包**。打包、修复与分发由本仓库负责，
> 但代码不是从零写的：基线为 `dsh-opencode-go@0.1.2`，本仓库只改宿主侧逻辑。
> 完整归属见包内 `THIRD_PARTY_NOTICES.md` 与 `docs/derivation.md`。
> 它**取代**旧的 `dsh-opencode-go`，**两者不能装进同一个 profile**。

> **`dsh-excel-viewer`**：自研客户端渲染器，tarball 内**内联分发**了
> SheetJS Community Edition 0.20.3（Apache-2.0，取自 SheetJS 官方 CDN）。
> 不是运行时依赖：dsh 的浏览器模块表只提供 `react` 与 `@deepseek-ai/*`，
> 解析器必须在构建期内联。完整归属与合规动作见包内 `THIRD_PARTY_NOTICES.md`。

**第三方插件的版权归各自原作者所有。** 本仓库仅做离线打包与索引，不修改其许可声明。

---

## 完整性校验

每个快照都有 `sha256`，记录在 [`manifest.json`](./manifest.json) 里。
它保证「装回来的和当初验证过的是同一个字节」。

```bash
# 重新生成清单并逐个核对 sha256
node scripts/build-collection.mjs

# 只校验不写盘（CI 用）
node scripts/build-collection.mjs --check
```

校验失败会明确报出哪一项不一致（与 `compatibility.json` 不符 / 快照文件缺失 / sha256 不匹配）。

---

## 目录结构

```none
collection/
├─ README.md                  # 本文件：收录介绍
├─ SPEC.md                    # 收录规范（面向贡献者，强制）
├─ manifest.json              # 机器可读清单（含 sha256），由脚本生成
├─ collection-notes.json      # 版本核实结论与收录理由（人工维护）
└─ snapshots/
   └─ <目录名>/<插件版本>/<包名>-<版本>.tgz
```

快照是**不可变**的：已收录的目录不得修改、覆盖或删除。上游发新版时**新增**一套目录。

---

## 如何安装

**不需要手动用这里的 tarball。** 在 GUI 里打开左侧「插件市场」→「已验证」页签，
点「安装」即可 —— 市场会自动读取本目录并跑装前兼容性闸门。

详见仓库根目录 [`README.md`](./../README.md)。

---

## 如何新增收录

1. 阅读 **[`SPEC.md`](./SPEC.md)** —— 收录规则是**强制**的
2. 确认真实来源（版本 / 作者 / 上游仓库 / 许可，四项齐全）
3. 在隔离环境真机验证通过
4. 按规范登记并运行 `node scripts/build-collection.mjs`

没有把握的，先进 Issue 问 —— **不要凭印象填版本号或作者**。

---

## 许可

- 本目录的**文档与清单**：MIT
- **第三方插件版权归各自原作者所有**，本仓库仅做离线打包与索引
- 如你是某个插件的原作者，希望调整或移除收录方式，请开 Issue 或直接联系，我们会立即处理
