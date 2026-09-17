# dsh-plugins-market

本仓库（[HaydenSmith1121/dsh-plugins](https://github.com/HaydenSmith1121/dsh-plugins)）自带的**可视化插件市场**：
装进 DeepSeek Harness 左侧导航栏，在界面里浏览、检查、一键安装插件。

它和公共市场（`@dsh-market/plugin`，数据源 dsh.market）的**根本差别是安全模型**：
本插件存在的唯一理由是「别把 harness 装坏」，所以每一次安装都先过一道兼容性闸门，
失败自动回滚。可以把它理解成「带刹车的一键安装」。

---

## 一、三层目录

| 层 | 来源 | 界面提示 | 装前检查 | 安装包 |
|---|---|---|---|---|
| **已验证** | 本仓库自带、按 dsh 版本实测过 | ✅ 可直接安装 | 必须全绿（有问题直接硬拦截） | 仓内离线 tarball，带 sha256 |
| **已审核** | 维护者**人工审核**后写进 `catalog/curated.json` | 已审核（含审核日期与 dsh 版本） | 同样要过闸门 | 按条目声明 |
| **未审核** | 公共索引全部插件 | ⚠️ 可能不兼容 | 只能做远程静态探测，**必须显式确认风险** | `github:` / npm 规格 |

三层是**同一个界面里的并列视角**，不是三个独立工具。

> 为什么未审核层要单独存在：公共索引实测 7487 条里，**1972 条连安装命令都没有**，
> 剩下的混着 `curl … | sh`、`pip install`、`brew install`、`npm install -g` 这类
> 根本不是 dsh 插件安装的命令。所以本插件**从不复用索引里的原始命令**，
> 只从中提取干净的 npm / GitHub 规格，其余一律拒绝。

---

## 二、装前闸门：到底检查什么

严重度分三档，这是整套设计的核心：

| 级别 | 含义 | 能否继续 |
|---|---|---|
| `fatal` + 不可覆盖 | **已知确定有害** | ❌ 硬拦截，界面上不提供覆盖入口 |
| `fatal` + 可覆盖 | 我们**无法确认**它安全（不是确认它不安全） | 勾选「我已阅读上述风险」后可继续 |
| `warn` | 已知软风险 | 可以继续，但界面必须如实说明 |

### 环境层

| 检查 | 级别 |
|---|---|
| Node 版本低于本仓库验证下限 | fatal（可覆盖） |
| 找不到 dsh 安装目录 | fatal（不可覆盖） |
| dsh 版本不在兼容矩阵里 | fatal（可覆盖） |
| dsh 版本被标记为不支持 | fatal（**不可覆盖**），并给出该升到哪个版本 |
| dsh 版本 == npm `latest` 通道（静默降级陷阱） | warn |
| pnpm 缺失 / 与 dsh 不在同一 Node | fatal |
| pnpm 版本低于验证下限 | warn |

### profile 层

| 检查 | 级别 |
|---|---|
| `file:` 依赖指向的 tarball 已不存在 | fatal（**不可覆盖**）—— 见第八节真实案例 |
| `pnpm-workspace.yaml` 丢了 `packages`/`nodeLinker`/`autoInstallPeers` | fatal（可覆盖，可一键修复） |
| bundles 里有既非依赖也非内置的孤儿项 | warn（可一键修复） |
| 已装版本与声明版本漂移 | warn |
| `allowBuilds` 有未决定的占位符 | warn（安装前自动补好） |

### 候选包层

| 检查 | 级别 |
|---|---|
| 精确 pin 的 `@deepseek-ai/*` **高于**本机版本 | fatal（**不可覆盖**）—— 缺具名导出会让整棵树挂 |
| 精确 pin 的 `@deepseek-ai/*` **低于**本机版本 | warn（向后兼容，实测可用） |
| peer 范围按 npm 语义不匹配 | warn（`autoInstallPeers: false`，peer 不参与安装） |
| 声明了 `dsh.bundle.patch` 但包里没有该文件 | fatal（**不可覆盖**）—— boot 期必然失败 |
| 没有声明 `dsh.bundle.patch` | fatal（可覆盖）—— 装了也永远不会加载 |
| tarball 的 sha256 与目录记录不符 | fatal（**不可覆盖**） |
| `engines.node` 不满足（注意 `^22.19.0 \|\| >=24.0.0` **排除 23.x**） | fatal（可覆盖） |
| 已知共存冲突（`dsh-opencode-go` ↔ `dsh-opencode-go-plus`） | fatal（**不可覆盖**） |
| 带 `preinstall`/`install`/`postinstall` 脚本 | warn（供应链信号） |
| insert 行 id 与现有装配树冲突 | warn |
| 包内疑似凭据文件（`.env` / `.pem` / `.npmrc` …） | warn |
| 未审核层级 | warn（且强制要求确认风险） |

> peer 的两档判据是**用仓库里两个真实数据点校准**出来的，不是拍脑袋：
> `dsh-opencode-go-plus` 精确 pin 到 **更高**版本 → 真实事故（整棵树挂）；
> `dsh-receipt` 精确 pin 到 **更低**版本 → 实测正常，若按「pin 不等即致命」会把它自己拦掉。

---

## 三、事务化安装

一次安装就是一次事务：

```
[0] 复核闸门（必须放行）
[1] 取安装包：本地仓库优先（离线）；没有就联网下载并校验 sha256
[2] 备份 profile 的 5 个状态文件 → $DSH_HOME/storages/dsh-plugins-market/backups/
[3] 事前补好 allowBuilds（读**当前**文件再合并，绝不重放旧快照）
[4] 跑 dsh plugin add
    ★ 成功判据是 **pnpm 退出码**，不是「node_modules 里有没有文件」
    ★ 撞 ERR_PNPM_IGNORED_BUILDS 时自动补 allowBuilds 并重试一次
[5] 校验三层：依赖层 / 注册表层 / 装配层
[6] 任何一步失败 → 用 [2] 的快照回滚，并重新链接 node_modules
```

**为什么第 5 步的「注册表层」是重点**：pnpm 非 0 退出时 dsh 会直接 return，
**不会**把包追加进 `dsh.profile.bundles` —— 这一步完全静默，表现为
「装上了但 GUI 里没有」。这是本插件存在的直接原因。

安装成功后界面会提示：**新增的 bundle 是在启动时合成的，必须重启 dsh web 才会出现。**

---

## 四、界面

左侧导航栏「插件市场」图标 → 中央面板。6 个页签：

| 页签 | 内容 |
|---|---|
| 已验证 / 已审核 / 未审核 | 搜索（服务端检索）、分页列表、插件卡片；未审核层带醒目的风险提示 |
| 已装 | 每个插件的挂载状态：已挂载 / **装了但没挂载**（红色，ERR_PNPM_IGNORED_BUILDS 残局）/ 版本漂移；可单独校验、卸载 |
| 体检 | profile 层检查、三层校验、真实启动校验（可选，约 30–40 秒）、快照回滚 |
| 日志 | 每次检查/安装/回滚的结构化记录 |

点「装前检查」或「安装」会打开**检查抽屉**：按严重度分组列出每一项、给出可读原因与建议动作，
并显示**将要执行的确切安装规格**。被判定为硬拦截时，「开始安装」按钮直接禁用。

---

## 五、性能

公共索引（7487 条，未压缩约 22 MB）的策略是：

- 首次拉取后**投影成瘦身版落盘**（只保留界面要用的字段），之后从磁盘缓存读取
- 缓存 TTL 6 小时，过期后**先返回旧数据、后台刷新**（stale-while-revalidate）
- 检索与分页全部在**服务端**完成，浏览器只收当前页

实测：远程首次拉取约 110 秒（22 MB，取决于网络）；命中磁盘缓存后
列表接口 **0.15 秒**、跨层检索 **0.06 秒**。这也是相对既有实现的一处改进 ——
远程优先的实现每次进程启动都要重下整份索引。

---

## 六、零运行时依赖

服务器半**只用 Node 内置模块**，客户端半**只用 `react`**（shell 的基线模块表里就有）。

这不是洁癖：每多一个依赖就多一分 pnpm 解析失败 / `ERR_PNPM_IGNORED_BUILDS` /
离线不可用的风险，而本插件存在的意义正是「别把 harness 装坏」。
所以 semver 判定、tar 只读访问、YAML 局部合并都是自己实现并有单测覆盖的。

同理，客户端半**不打包、不转译**（源码就是可运行的经典脚本），
少一层构建就少一类「产物与源码不一致」的故障。

**已知限制**（界面上会讲清楚）：

- 客户端半的错误在 CLI 侧查不出来 —— 例如注册 id 写错会导致浏览器白屏而服务端一切正常。
  本仓库为此有专门的 headless 测试（`test/client-bundle.test.mjs`）把 bundle 真跑一遍。
- `bootVerify` 会在同一个 profile 上再起一个 dsh 进程（用 `--port 0` 避开端口冲突），
  因此默认**不**自动执行，需要用户显式点击。

---

## 七、开发

```bash
node build.mjs          # 生成目录 + 组装产物到 .build/package + 打包 tarball
node build.mjs --check  # 只校验产物是否与源码一致（CI / 提交前）
node test/run.mjs       # 跑全部测试
```

**产物只落在 `.build/package/`**，源码树保持干净（构建不该改动它自己的输入）。

测试跑在**隔离环境**（`DSH_HOME=~/.dsh-dev`）上，不会碰生产 profile。

往隔离环境装本插件：

```bash
node ../../scripts/dev-env.mjs install ../../plugins/dsh-plugins-market/<dsh版本>/dsh-plugins-market-<版本>.tgz
```

> ⚠️ **改完代码重新打包后，必须 `remove` 再 `add`**。
> `file:` 指向同一个 tarball 路径时，pnpm 会认为 lockfile 是新的、
> **跳过解包**（`Lockfile is up to date, resolution step is skipped`），
> 即使加 `--force` 也只重新链接、不重新解包 —— 你会一直在跑旧代码。

---

## 八、真实案例

本插件的第一批测试就跑出了两个仓库里真实存在的问题：

1. **两个 profile 各有一条指向已删除 tarball 的 `file:` 依赖**
   （生产指向 `dsh-session-cleanup-0.1.1.tgz`，隔离环境指向 `0.1.0.tgz`，仓库里只有 `0.1.2`）。
   只要引用还在，之后**任何** `pnpm install` / `dsh plugin` 操作都会失败 ——
   包括「装一个别的插件」。闸门把它作为**不可覆盖的致命项**拦下来。
2. **公共索引里 star 最高的条目并不是 dsh 插件**。
   `ruvnet/ruflo`（7.2 万 star）的 `package.json` 没有声明 `dsh.bundle.patch`，
   装进去只会躺在 `node_modules` 里、永远不会被加载。远程静态探测拦住了它。

---

## License

MIT
