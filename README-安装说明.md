# DSH 插件包 — 安装说明

> ## ⚠️ 安装方式：一条命令装市场，其余在面板点装
>
> 自 2026-09 起不需要先 `git clone` 再 `cd` 再逐条执行 —— 一条命令即可：
> 脚本自己把仓库落地到 `~/.dsh-plugins`，再完成预检 → 判定 → 补环境 → 装引导插件 → 校验。
>
> 装完之后，**其余插件的安装入口是 GUI 里的「插件市场」面板**：
> 面板不判定「能不能装」（所有插件都可装），它把两条路摆给你选 ——
> **自动安装**（服务端执行命令，界面不弹命令窗口，全程有进度与预计时间、可随时中止）
> 或**手动安装**（命令给你，自己敲）；两条路都先备份 profile、失败自动回滚。
>
> ★ **自 0.4.0（市场与插件分离）起，脚本只装一个插件：引导插件 `dsh-plugins-market`。**
> 插件的字节已经不在本仓库：自研插件**各自在自己的源码仓库**里（见下表），
> 第三方插件按各自配置里记录的 `github:` / npm 规格从上游安装。
> 所以「一键装全套」这件事本身没有了，`-BootstrapOnly` / `--bootstrap-only` 仍然接受，
> 含义与默认行为一致（保留是为了兼容旧命令与显式表达意图）。
>
> ★ **`dsh-plugin-collection`（插件集合仓库）已于 2026-09-18 退役。**
> 它此前托管 6 个自研插件的 tarball；现在一个插件一个源码仓库，安装规格统一是
> `github:HaydenSmith1121/<仓库名>`。`lib/` 已提交进各仓库，所以 **git 安装不需要本地构建**：
>
> | 插件 | 源码仓库 | 安装 |
> |---|---|---|
> | `dsh-ark-plans` | [dsh-ark-plans](https://github.com/HaydenSmith1121/dsh-ark-plans) | `dsh plugin --profile web add github:HaydenSmith1121/dsh-ark-plans` |
> | `dsh-memory` | [dsh-memory](https://github.com/HaydenSmith1121/dsh-memory) | `dsh plugin --profile web add github:HaydenSmith1121/dsh-memory` |
> | `dsh-excel-viewer` | [dsh-excel-viewer](https://github.com/HaydenSmith1121/dsh-excel-viewer) | `dsh plugin --profile web add github:HaydenSmith1121/dsh-excel-viewer` |
> | `dsh-session-cleanup` | [dsh-session-cleanup](https://github.com/HaydenSmith1121/dsh-session-cleanup) | `dsh plugin --profile web add github:HaydenSmith1121/dsh-session-cleanup` |
> | `dsh-opencode-go-plus` | [dsh-opencode-go-plus](https://github.com/HaydenSmith1121/dsh-opencode-go-plus) | `dsh plugin --profile web add github:HaydenSmith1121/dsh-opencode-go-plus` |
> | `dsh-connect-trae` | [dsh-connect-trae-plus](https://github.com/HaydenSmith1121/dsh-connect-trae-plus) | `dsh plugin --profile web add github:HaydenSmith1121/dsh-connect-trae-plus` |
>
> ⚠️ `dsh-opencode-go-plus` 首装会撞 `ERR_PNPM_IGNORED_BUILDS`（依赖树里两条未批准的
> 构建脚本，表现是「文件都装了、GUI 里看不到」），修法写在
> [该仓库的 README](https://github.com/HaydenSmith1121/dsh-opencode-go-plus#readme) 里。

**本文件是唯一的安装文档，自包含。** 里面每一步都已经把「容易出错的地方」
直接写成了预防措施和自检项 —— 照着走就不会遇到那些问题，出问题也能就地定位。

> 逐插件的版本 / 安装与配置说明：**每个插件自己的源码仓库**（见上表），
> 或本仓库[市场目录](./catalog/plugins)里那一份配置。
> 本仓库里插件的**目录数据**（版本 / 收藏量 / 安装方式）见
> [`docs/插件清单与来源.md`](./docs/插件清单与来源.md)。
> 所有第三方插件版权归原作者所有。

---

<a name="ch1"></a>

## 一、30 秒开始

前置只有一个：**Node ≥ 22.19**（[nodejs.org](https://nodejs.org/)）。一条命令装完，不用 clone、不用 `cd`。

### 第 1 步：一键安装

**Windows（PowerShell）**

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main/scripts/install.ps1).TrimStart([char]0xFEFF)))
```

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main/scripts/install.sh | sh
```

> 仓库会被落地到 `~/.dsh-plugins`（已存在就原地更新）。这个目录**不能删、不能挪**，
> 原因见第五节。

脚本会自动做完这五件事，**每一步都先检测再决定**：

1. **环境预检** —— Node 版本、dsh 是否存在及版本、pnpm 是否存在
2. **判定** —— 你这台机器的 dsh 版本是否在本仓库的兼容矩阵里；不在就停下来告诉你该装哪个版本
3. **补齐缺失环境** —— 没有 pnpm 就装（且装在 dsh 所在的那个 Node 上）；预置 `allowBuilds`
4. **安装引导插件** —— 只装 `dsh-plugins-market`（市场面板）；
   它的版本与 tarball 地址从目录里它自己的那条记录读（`catalog/plugins/dsh-plugins-market.json`），再按
   它自己的配置文件 `catalog/plugins/dsh-plugins-market.json` 安装
5. **四步校验** —— 版本 / 依赖层 / 装配层 / 真实启动，四层都可能出不同的问题

想先看看不改动任何东西？加 `-PreflightOnly`（Windows）或 `--preflight-only`：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main/scripts/install.ps1).TrimStart([char]0xFEFF))) -PreflightOnly
```

> **为什么不写成更短的 `irm ... | iex`？** 两个原因：
> 一是脚本含中文、文件带 UTF-8 BOM，`Invoke-Expression` 直接吃 BOM 会以
> `The assignment expression is not valid` 解析失败；
> 二是管道进 `iex` 没法传参。
> `[scriptblock]::Create(...)` 先去掉 BOM 再执行，两条都解决。
> 也可以用环境变量：`$env:DSH_INSTALL_ARGS = '-SkipVerify'`。
> Windows 上若嫌 `.ps1` 被执行策略挡着，可以直接用薄壳 `scripts\install.cmd`。

| 参数（PowerShell / sh） | 作用 |
|---|---|
| `-PreflightOnly` / `--preflight-only` | 只体检，不装 |
| `-DryRun` / `--dry-run` | 只打印将要执行的命令 |
| `-SkipVerify` / `--skip-verify` | 跳过装完的四步校验 |
| `-BootstrapOnly` / `--bootstrap-only` | 与默认行为相同：只装引导插件（保留以兼容旧命令） |
| `-Profile web` / `--profile web` | 指定 profile，默认 `web` |
| `-Force` / `--force` | dsh 版本不受支持也强装（不推荐，启动很可能失败） |
| `-RepoDir <路径>` / `-RepoUrl <URL>` / `-Ref <分支>` | 仓库落地位置 / 地址 / 分支，默认 `~/.dsh-plugins`、官方仓库、`main` |

### 第 2 步：重启 harness，在面板里补装其余插件

```bash
dsh web          # 默认 http://127.0.0.1:3080
```

1. 左侧导航栏点 **「插件市场」**
2. 在列表里挑需要的插件（顶部筛选器：`已安装 / 可升级 / 我收藏的`）
3. 点 **「安装」** —— 打开的是**安装方案页**，上面摆着两条路，你选一条：
   - **自动安装**：市场在服务端替你执行命令，界面上**不会弹出命令窗口**，
     全程用进度页展示（阶段 / 已耗时 / 预计剩余 / pnpm 实时输出），随时可以中止
   - **手动安装**：把命令给你（下载 + sha256 校验 + `add` + 三层校验 + 重启），你自己在终端里敲
4. 装完**再重启一次 `dsh web`**（新增的 bundle 是在启动时合成的）

**市场不判定「能不能装」**（0.6.0 起）：所有插件都可装，没有按钮点不动的情况。
它只把「怎么装」摆清楚，以及把**知道的事实**列出来供你判断：

| 你会在方案页看到 | 含义 | 你要做什么 |
|---|---|---|
| 自动 / 手动两张卡 | 两条路都可用，默认选自动 | 选一条；自动不可用时会说明原因并落到手动 |
| **装之前你可能想知道**（提示列表） | 我们知道的事实：包没声明 `dsh.bundle.patch`（装上了 GUI 里也不会有）、声明的 patch 不在包里（启动会失败）、peer 精确 pin 到了比本机更新的版本、与已装的插件不能共存、需要配置才能用…… | 看完自己决定继续还是算了。**这些是提示，不是禁止** |
| 「已是最新版」时的「重新安装」 | 目录里这一版与你装的相同 | 想重装就点（装坏了要修、想换装法都算正当理由） |

> 「字节来源」仍然如实标注，它说的是「我们查得有多细」，不是「可不可信」：
> 字节由本仓库托管时（下载我们自己的 tarball、`sha256` 逐字节核对、可离线安装），
> 方案页能给出确定的文件与校验和；装的是上游产物时（npm / GitHub），
> 只能做静态探测，手动方案给的就是等价的 `github:` / npm 命令。

> 面板每次安装都会：读**那个插件自己的配置文件**（`catalog/plugins/<slug>.json`）→
> 按它写的 `install.method` 解析出自动规格 → 备份 profile → 装完校验 → 失败自动回滚。
> **配置文件读不到就不装**（而不是拿列表里的字段猜一个安装方法），并在详情里给出可复制的手动命令。
> 完整说明见 [`plugins-src/dsh-plugins-market/README.md`](./plugins-src/dsh-plugins-market/README.md)。

**如果市场面板起不来**（装坏了、或想回退），打开面板的 **「已装」** 页
（0.3.0 起不再有独立的「体检」页签，能力都搬到了这里），里面有**三层校验 /
真实启动校验 / 快照回滚 / 修复 profile**；或者直接跑一次校验看是哪一层出的问题：

```bash
node scripts/verify.mjs --profile web
```

---

<a name="ch2"></a>

## 二、环境要求

| 组件 | 要求 | 校验命令 | 说明 |
|---|---|---|---|
| Node | **≥ 22.19** | `node -v` | dsh 的 `package.json` 没有 `engines` 字段，此下限是按实测写的 |
| pnpm | ≥ 10 | `pnpm -v` | `dsh plugin` 底层就是转发给 pnpm |
| dsh | **`0.1.6-alpha.1`** | `dsh --version` | ★ 不是「一致或更新就行」，见第三节 |

### ⚠️ pnpm 必须装在「dsh 所在的那个 Node」上

这是新机安装**最容易踩、也最难自查**的一个坑。多 Node 环境（nvm、便携版 Node 并存、
或者系统里同时有多个 node）下，直接跑 `npm i -g pnpm` 很可能装到了**另一个** Node 上。
结果是：

```none
'pnpm' 不是内部或外部命令，也不是可运行的程序或批处理文件。
dsh: pnpm failed in profile directory C:\Users\...\.dsh\profiles\web
```

连 `dsh plugin --profile web list` 都会这样报 —— 因为 `list` 同样转发给 pnpm。

**正确做法**：先确认 dsh 在哪，再用**那个目录里的 npm** 装 pnpm。

```powershell
# 1) 找 dsh 的安装位置
Get-Command dsh | Select-Object Source
#    假设输出 C:\Users\你\AppData\Roaming\npm\dsh.cmd

# 2) 用同一个目录下的 npm 装 pnpm
& "C:\Users\你\AppData\Roaming\npm\npm.cmd" install -g pnpm
```

```bash
# macOS / Linux 同理：where/which dsh 找到 prefix，再用该 prefix 里的 npm
which dsh          # 例：/usr/local/bin/dsh  → prefix 是 /usr/local
/usr/local/bin/npm install -g pnpm
```

**自检**：确认 `pnpm` 文件就躺在 dsh 旁边。

```bash
# Windows
dir "$env:APPDATA\npm\pnpm*"        # 应看到 pnpm.cmd / pnpm.ps1 / pnpm
# macOS / Linux
ls "$(dirname "$(which dsh)")/pnpm"
```

> `node scripts/preflight.mjs` 会自动做这项比对，并在不一致时直接给出该执行的命令。
> 如果它报「pnpm 与 dsh 不在同一个 Node」，照着输出的那条命令做即可。

---

<a name="ch3"></a>

## 三、dsh 版本：为什么必须锁定 `0.1.6-alpha.1`

dsh 在 npm 上有多条发行通道：

| dist-tag | 版本 | 说明 |
|---|---|---|
| `latest` | `0.1.5-rc.1` | `npm i -g @deepseek-ai/dsh`（**不带版本**）默认装这个 |
| `next` | `0.1.5-rc.2` | |
| **`alpha`** | **`0.1.6-alpha.1`** | ★ 本仓库基线要求的 |

**必须显式带版本号安装**：

```bash
npm i -g @deepseek-ai/dsh@0.1.6-alpha.1
dsh --version        # 必须显示 0.1.6-alpha.1
```

### 版本不对会怎样：整个插件树加载失败

不是「某个插件不能用」，而是 **整棵 bundle 树加载失败、`dsh web` 完全起不来**：

```none
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
failed to import loader entry opencode-go-plus (dsh-opencode-go-plus):
The requested module '@deepseek-ai/dsh-llm' does not provide an export named 'IMAGE_OFFLOAD_REQUIRED_CODE'
```

**根因**：`dsh-opencode-go-plus` 的 `peerDependencies` 把整套 `@deepseek-ai/*`
**精确 pin 在 `0.1.6-alpha.1`**（沿用其基线，未改动），而 `0.1.5-rc.1` 内置的
`@deepseek-ai/dsh-llm` 是 `0.1.5-rc.2` —— 里面根本没有 `IMAGE_OFFLOAD_REQUIRED_CODE`、
`offloadedImageText`、`projectOffloadedImages`、`requiredImageOffload` 这些导出
（图片卸载是 0.1.6 才加的 API）。

ESM 的具名导入在符号不存在时是**确定性失败**，不存在「有时候能过」。
又因为 profile 的 `pnpm-workspace.yaml` 里有 `autoInstallPeers: false`，
pnpm 不会安装 peer 依赖，插件的 `import "@deepseek-ai/dsh-llm"` 只能沿目录树向上
找到 CLI 内置的那一份 → 导出缺失 → 报错。

### 退插件版本解决不了

`dsh-opencode-go-plus` 在 npm 上的全部上游发布版本（即它的基线 `dsh-opencode-go`）
要求的都是 alpha：

| 版本 | 要求的 `@deepseek-ai/dsh-llm` |
|---|---|
| 0.1.0 | `0.1.6-alpha.1` |
| 0.1.1 | `0.1.6-alpha.1` |
| 0.1.2 | `0.1.6-alpha.1` |

最老的 `0.1.0` 也要 alpha。**所以只能升 dsh，不能退插件。**

### ★ 最大的长期陷阱：静默降级

`npm i -g @deepseek-ai/dsh`（**不带版本**）装的是 `latest` = `0.1.5-rc.1`。
以后只要顺手跑一次这样的升级，就会把 CLI **静默降回 0.1.5**，上面的故障立刻复现，
而且**没有任何提示**。

> **规矩**：升级 dsh 时必须显式带版本号，并且每次升级后重跑一次
> `node scripts/verify.mjs`（它会做真实启动校验，见第六节第 ④ 步）。

### 版本兼容矩阵

**逐插件的 peer 约束与实测结论统一记在 [`docs/版本兼容矩阵.md`](./docs/版本兼容矩阵.md)**：
自研 6 个与第三方插件的结论都写在
[`catalog/overrides/curated.json`](./catalog/overrides/curated.json) 的 `peerVerdict` / `peerNote` / `evidence` 里
（例：`dsh-workbuddy-connect` 的 `^0.1.5-rc.1`、`dsh-connect-trae` 的 `>=0.1.5-0 <0.2.0-0`
按 semver 预发布规则的实际含义，以及 `@dsh-external/dsh-ads` 的 `dsh-client-locale` 警告）。
机器可读的那份是 [`compatibility.json`](./compatibility.json)。

**→ 整批插件以 `0.1.6-alpha.1` 为运行时基线。**

---

<a name="ch4"></a>

## 四、手动安装（不想用脚本时）

脚本做的事就是下面这些，逐步执行同样可以。

### 1) 安装正确版本的 dsh

```bash
npm i -g @deepseek-ai/dsh@0.1.6-alpha.1
dsh --version        # 必须显示 0.1.6-alpha.1
```

### 2) 还原 settings.yaml —— ★ 先 diff，不要盲目覆盖

```powershell
# 先确认 DSH_HOME，默认是 %USERPROFILE%\.dsh
$env:DSH_HOME

# 对比两边顶层键，判断是否同一代配置
Select-String -Path ".\settings\settings.yaml" -Pattern '^[a-zA-Z][\w.-]*:'
Select-String -Path "$env:USERPROFILE\.dsh\settings.yaml" -Pattern '^[a-zA-Z][\w.-]*:'
```

**只有两边一致（或新机还没有 settings.yaml）时才可以整体覆盖**：

```powershell
Copy-Item ".\settings\settings.yaml" "$env:USERPROFILE\.dsh\settings.yaml" -Force
```

> ⚠️ **仓库里这份是「导出那一刻的快照」，可能比目标机更旧。**
> 实测遇到过的差异：仓库那份顶层键是 `ui-onboarding / agent-default-model / trae`
> （默认模型 `trae/glm-5.2`），而另一台机器那份是
> `ui-onboarding / agent-default-model / ui-theme / llm-pi-ai`
> （默认模型 `opencode-go/deepseek-v4-flash`）。
> 整体覆盖会**丢掉目标机 `llm-pi-ai.providers.*` 的完整模型清单**。
>
> **两边不一致时不要整文件覆盖**，按需 merge 具体段落。
> 其中 `trae:` 段只影响 `dsh-connect-trae` 的**模型缓存**（`lastCatalog`），
> 登录后会重建 —— 目标机缺这一段，通常**在 GUI 里重新登录 trae 即可**。

若新机还没初始化 `.dsh`，先跑一次 `dsh --profile web --version` 让它生成目录。

### 3) 预置 allowBuilds（★ 建议先做，可省一次失败）

`dsh-opencode-go-plus` 的依赖树里有两个包声明了 install 脚本，pnpm 10+ 默认拦截它们。
不预先处理，安装时会撞 `ERR_PNPM_IGNORED_BUILDS` —— 而那个报错**极具欺骗性**（见第七节）。
本仓库的 `compatibility.json` 里也记着这条：`allowBuilds.triggeredBy = dsh-opencode-go-plus`。

在 `~/.dsh/profiles/web/pnpm-workspace.yaml` 里加上：

```yaml
allowBuilds:
  '@google/genai': false
  protobufjs: false
```

**为什么填 `false` 是安全的**：

| 包 | 声明了什么脚本 | 实际作用 | 需要跑吗 |
|---|---|---|---|
| `protobufjs` | `postinstall: node scripts/postinstall` | 只打印一句 protobufjs-cli 提示 | ❌ 纯装饰 |
| `@google/genai` | `prepare: node scripts/prepare.js` | `prepare` 对 registry / tarball 安装**本就不执行**（仅 git / 本地目录安装生效） | ❌ 不会跑 |

填 `false` 的含义是「**已知并同意忽略**」，不是「跳过构建」。

> ⚠️ **不要用 `strictDepBuilds: false` 一把梭** —— 那会把将来真正需要编译的依赖
> （native 模块等）也静默跳过。用 `allowBuilds` 逐个白名单更安全：
> 保留了严格模式，遇到新的未知构建脚本仍会报出来。
>
> ✅ 已实测：dsh **不会覆盖**这个文件，手写的 `allowBuilds` 能长期留存。
> 也无需 `pnpm approve-builds`（那是交互式的，不适合脚本化）。

### 4) 装引导插件（市场面板）

```powershell
# 下载本仓库托管的市场插件 tarball（版本与 sha256 见 catalog/plugins/dsh-plugins-market.json
# 与同目录的 .tgz.sha256 边车文件）
Invoke-WebRequest -Uri https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main/plugins/dsh-plugins-market/0.1.6-alpha.1/dsh-plugins-market-0.4.0.tgz -OutFile $env:TEMP\dsh-plugins-market.tgz
dsh plugin --profile web add $env:TEMP\dsh-plugins-market.tgz
```

```bash
# macOS / Linux 等价写法
curl -fL -o /tmp/dsh-plugins-market.tgz https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main/plugins/dsh-plugins-market/0.1.6-alpha.1/dsh-plugins-market-0.4.0.tgz
dsh plugin --profile web add /tmp/dsh-plugins-market.tgz
```

`dsh plugin --profile web add <tarball>` 会：
- 在 `~/.dsh/profiles/web` 跑 `pnpm add <tarball>`
- 成功后把声明了 `dsh.bundle` 的包追加进 `package.json` 的 `dsh.profile.bundles`

**其余插件的手动装法**（都不经过本仓库的 `plugins/`）：

```bash
# ① 自研插件：直接装它自己的源码仓库（pnpm 的 git 依赖，不需要下载 tarball）
dsh plugin --profile web add github:HaydenSmith1121/dsh-memory

# ② 第三方插件：按它配置里记录的安装方式装（github: 或 npm）
dsh plugin --profile web add github:Nagi-ovo/dsh-ads
```

> ★ **自研插件的装法在 2026-09-18 变过一次。** 原先是从**插件集合仓库**下 tarball
> （`curl` + `sha256sum` + `add`）—— 那条路已随 `dsh-plugin-collection` 退役一起消失，
> 那个仓库现在没有 tarball 了。现在统一走 `github:` 规格、一个插件一个仓库，
> 也就不再有「集合仓库的 tarball 校验表」这回事（见附录）。

> **路径里的 `0.1.6-alpha.1` 是 dsh 运行时版本，不是插件版本** ——
> 这套多版本目录约定见 [`CONTRIBUTING.md` 第三节](./CONTRIBUTING.md#naming)
> 与 [`docs/目录结构.md`](./docs/目录结构.md#two-layers)。
>
> 手动装插件时**没人替你做检查**：兼容性要你自己对着
> [`docs/版本兼容矩阵.md`](./docs/版本兼容矩阵.md) 判断，sha256 要你自己核对。
> 面板的「手动安装」方案会把这几步（含 `sha256` 期望值与校验命令）整理好给你 ——
> 那和这里手敲是同一条命令，只是不用自己拼路径。

---

<a name="ch5"></a>

## 五、路径要求（★ 装之前先看）

`dsh plugin add <tarball>` 生成的**不是**把包内容拷进去，而是 `file:` 形式的依赖：

```json
"dsh-plugins-market": "file:C:/Users/你/.dsh-plugins/plugins/dsh-plugins-market/0.1.6-alpha.1/dsh-plugins-market-0.4.0.tgz"
```

这个 `file:` 指向的路径**不能删除、不能移动**，否则以后任何 `pnpm install` /
`dsh plugin` 操作都会失败（找不到 tarball）。

自 0.4.0 起 tarball 只可能来自这三处，规则对它们**一视同仁**：

| 来源 | 路径 |
|---|---|
| 本仓库的 clone（市场插件） | `~/.dsh-plugins/plugins/dsh-plugins-market/<dsh 版本>/*.tgz` |
| 市场面板下载的缓存（集合仓库与第三方 tarball） | `$DSH_HOME/storages/dsh-plugins-market/tarballs/`（按 sha256 复用） |
| 你自己手动下载的 | 你放它的地方 —— **别放 `%TEMP%` 或会被清理的下载目录** |

**自检**：

```bash
grep -o 'file:[^"]*' ~/.dsh/profiles/web/package.json
# 逐条确认这些 tarball 路径真实存在
```

万一必须挪动仓库目录或清过缓存，正确做法是三步：**重新 add → 重跑 install → 跑校验**：

```bash
# 1) 把失链的那几个包重新 add 一遍（或直接用面板的「修复 / 重装」）
# 2) 重跑 pnpm install 让链接指向新位置
cd ~/.dsh/profiles/web && pnpm install
# 3) 真实启动校验（见第六节第 ④ 步）
node scripts/verify.mjs
```

---

<a name="ch6"></a>

## 六、安装后校验：四步，缺一不可

```bash
# 也可以直接跑脚本，它做的就是这四步
node scripts/verify.mjs
```

| # | 查什么 | 命令 | 期望 |
|---|---|---|---|
| ① | **dsh 版本** | `dsh --version` | `0.1.6-alpha.1` |
| ② | **依赖层** | `dsh plugin --profile web list` | 引导插件 `dsh-plugins-market` 在列；你点装过的插件都在列 |
| ③ | **装配层** | `dsh --profile web --dump-config` | 内置 bundle + 你实际装了的插件，顺序单调 |
| ④ | **真实启动** | `dsh web --no-open --port 0` | 只有一行服务地址，无致命错误 |

> ②③ 的期望集合**不再是「某个清单里的全部插件」**：插件现在是按需点装的，
> 校验脚本的判据是「**内置 bundle + 引导插件（硬性要求）+ profile 里实际装了的运行时插件**」。
> 你还没点装的插件不会被算成缺失 —— 那不算装坏。

### ③ 的正确写法（`grep bundles` 永远返回空）

`--dump-config` 输出的是**按 bundle 分组的装配树**，用 `# == <bundle 名>` 做分节头，
**输出里根本没有 "bundles" 这个字面词**：

```bash
dsh --profile web --dump-config | grep -n '^# == '
```

**不要用 `grep bundles`** —— 会返回空，很容易误判成「配置没生效」。

刚装完引导插件时的期望输出（顺序即层级顺序）：

```none
# == @deepseek-ai/dsh-base        （这个头会重复出现多次，属正常，不是重复装配）
# == @deepseek-ai/dsh-web-app
# == dsh-plugins-market           → - id: dsh-plugins-market  name: dsh-plugins-market
```

面板里点装的插件会依次追加在后面（`# == <包名>`），例如
`# == @dsh-external/dsh-ads`、`# == dsh-memory` 等。

若某个 bundle 的 `name:` 不是包本名，说明模块 import 失败 →
查 `~/.dsh/profiles/web/.dsh-module-fallback/`。

### ④ 的真实启动（唯一能查出「导出缺失」的办法）

```bash
dsh web --no-open --port 0 > boot.log 2>&1 &
sleep 30
cat boot.log
kill %1
```

**期望**：只有一行 `dsh web: http://127.0.0.1:<port>/?token=...`

**出现以下字样就是没装好**：
`plugin tree failed to load` / `does not provide an export` / `SyntaxError` / `Cannot find module`

> ★ **③ 和 ④ 不能互相替代**，这是最容易被忽略的一点：
> `--dump-config` **只打配置树、不 import 任何模块**，所以「导出缺失」这类问题
> 在它那里完全看不出来；反过来，第 ④ 步查不出 bundles 顺序错。**两步都要做。**

---

<a name="ch7"></a>

## 七、GUI 里看不到某个插件？按这个顺序查

**不要一上来就查前端。** 按层次查，每层都能独立定位问题：

```none
① dsh --version 不是 0.1.6-alpha.1？
      └─→ 第三节。升级 dsh（必须带版本号），然后真实启动验证

② dsh plugin --profile web list 里少包？
      └─→ 面板装的：重开面板看「已装」页的状态与失败原因（安装是事务化的，失败会回滚）
          手动装的：重跑那条 add。若报 ERR_PNPM_IGNORED_BUILDS，看下面那段

③ --dump-config 里少 bundle 或顺序不对？
      └─→ 直接编辑 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles，
          调成第六节列出的顺序，重启 dsh web

④ 配置树正常但启动报错、或 GUI 里面板不出现？
      └─→ 真实启动看 boot log
```

<a name="pitfalls-ignored-builds"></a>

### ★ 特别当心：`ERR_PNPM_IGNORED_BUILDS` 的假象

```none
Error: ERR_PNPM_IGNORED_BUILDS
  × adding a new package
  ╰─▶ Ignored build scripts: @google/genai@1.52.0, protobufjs@7.6.6
  help: Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
dsh: pnpm failed in profile directory ...
```

看到这个报错，第一反应是「装失败了」。但实际状态是：

| 检查项 | 实际 |
|---|---|
| `node_modules/dsh-opencode-go-plus/` | ✅ **已存在**，依赖也全部链接完毕 |
| `package.json` 的 `dependencies` | ✅ **已写入** |
| `package.json` 的 `dsh.profile.bundles` | ❌ **没有追加** |

原因：dsh 的流程是「先跑 pnpm → 成功后才写 bundles」。pnpm 因「有未批准的构建脚本」
**以非 0 退出**，dsh 就提前 return 了。

**最终表现**：插件文件都在 `node_modules` 里，但 **GUI 里完全看不到它** ——
很容易误判成「装了但没生效」而去查前端。

> **规矩：只要 pnpm 退出码非 0，就当作「这条插件没装完」。**
> 别被 `node_modules` 里有文件骗到。
>
> **修法**：按第 3 节预置 `allowBuilds`，然后**重跑同一条 `dsh plugin add`**
> （幂等，会报 `Lockfile is up to date`）→ 退出码 0 → dsh 这才补上 bundles 条目。
> 面板点装时这一步是自动的（撞到这个错会自动补 `allowBuilds` 后重试一次）。

---

<a name="ch8"></a>

## 八、凭据与登录态不随包迁移

本仓库**有意不含** `.credentials.yaml`（API key 所在）：

- 各 provider 的 API key → 首次启动后在 GUI 设置里手填
- **trae 登录态** → 需在目标机重新登录
- `dsh-workbuddy-connect` 复用 **WorkBuddy 桌面端**的登录态，不另起 OAuth
- `dsh-ark-plans` 的额度 pill 复用本机 `~/.arkcli` 的身份；**没登录 arkcli 时插件照常工作**，
  只是那条车道显示「不可用」并写明原因

---

<a name="ch9"></a>

## 九、卸载 / 回滚

```bash
dsh plugin --profile web remove <包名>     # 例如: dsh plugin --profile web remove dsh-receipt
```

面板点装的插件也可以在「已装」页里直接**更新 / 校验 / 卸载**，
并在安装或卸载**之前**自动备份 profile 的 5 个状态文件到
`$DSH_HOME/storages/dsh-plugins-market/backups/`；出错时可以回滚。

> 手动操作前建议先自己备份 `~/.dsh/profiles/web/` 下的这 3 个文件：
> `package.json`、`pnpm-workspace.yaml`、`cordis.patch.yml`。
> 出错时把它们还原即可整体回滚。

---

<a name="ch10"></a>

## 十、关于 `dsh-opencode-go-plus` 的来历、改造与共存禁忌

`dsh-opencode-go-plus@0.3.0` 是**派生包**，基线为上游
[Duskriver/dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go)`@0.1.2`（MIT）。
它**取代**了此前收录的 `dsh-opencode-go@0.1.2`（那一版含 13 处本地源码改动）。
它在自己的源码仓库 [HaydenSmith1121/dsh-opencode-go-plus](https://github.com/HaydenSmith1121/dsh-opencode-go-plus)：

```bash
dsh plugin --profile web add github:HaydenSmith1121/dsh-opencode-go-plus
```

★ 那是一个**分发仓库**：只含编译产物（`lib/` + `cordis.patch.yml` + `docs/` + `examples/` +
`THIRD_PARTY_NOTICES.md`），**没有 `src/`** —— 所以新机装上就能用，不需要重新构建，
也不需要源码 / node_modules。派生关系与改动清单见仓库内 `docs/derivation.md`。

⚠️ **首装会撞 `ERR_PNPM_IGNORED_BUILDS`**：依赖树里 `@google/genai` 与 `protobufjs`
两条构建脚本未获批准，pnpm 10+ 因此以非 0 退出 —— 表现是「文件都在 `node_modules` 里了，
但 `dsh.profile.bundles` 没有追加，GUI 里看不到它」。修法：把 profile 目录下
`pnpm-workspace.yaml` 里 pnpm 写出的 `allowBuilds` 占位模板填成 `false`，再**重跑同一条命令**
（幂等，会报 `Lockfile is up to date`）—— 退出码 0 之后 bundles 才会补上。

### 0.3.0：配置入口在「设置 → 模型」里，不再有独立分区

0.3.0 起，插件的 Web 配置面是 **设置 → 模型** 页里的 **OpenCode Go** 一行
（显示名 + 凭据绿点，与 DeepSeek、火山方舟等 provider 并列）。此前那个自带的
「设置 → OpenCode Go」侧边栏分区**已删除** —— 同一个 provider 两个配置入口，
其中一个还管不了另一个，正是这一版要合并掉的。

该行的"编辑"卡片里是通用凭据字段；`refreshMinutes`、`autoDiscover`、图片预算、
`catalogAdditions` 这些插件专有字段仍留在 `settings.yaml` 的 `llm-opencode-go` 段，
卡片会明确提示这一点，不做半吊子编辑。

> ⚠️ **这一行登记的路由是 `opencode-go-plus`，不是 `opencode-go`**，这是刻意的：
> 可配置 provider 目录**拒绝重复声明**，而 `opencode-go` 已经被
> `@deepseek-ai/dsh-llm-pi-ai` 声明了（它内置的 pi-ai 目录里就有同名路由）。
> 在插件里再声明一次会抛 `DUPLICATE_DIRECTORY`，而且异常从 `apply()` 里逸出 ——
> 后面的路由注册、设置段安装**全都不执行**，插件彻底失效（不只是"这行不显示"）。

### 这一版改了什么

0.2.x 的宿主侧改动共五处，都在 `lib/index.js` 里，协议转换未动。
完整归属与改动清单见包内 `THIRD_PARTY_NOTICES.md` 与 `docs/derivation.md`。
其中最需要记住的一条：

> **`ctx.llm.registerModelDiscovery()` 也是全有或全无的，而且它以「设置命名空间」为键。**
> 本包为了旧配置能继续用，刻意沿用了基线的命名空间 `llm-opencode-go`。
> 基线没有捕获这个重复注册，错误会从 loader 自身的 effect 里逸出 ——
> **整棵插件树加载失败，`dsh web` 直接起不来，同 profile 其余插件一起挂**。

### ★ 共存禁忌（会决定 `dsh web` 能不能起来）

`dsh-opencode-go-plus` 与 `dsh-opencode-go` **不能装进同一个 profile**。
四种组合都实测过（Windows / Node 24.14.0 / pnpm 12.4.2 / dsh 0.1.6-alpha.1）：

| 安装情况 | `dsh web` | 结果 |
|---|---|---|
| 只有 `dsh-opencode-go-plus` | ✅ 正常 | `opencode-go` 分组 **38** 条模型 |
| 只有 `dsh-opencode-go` | ✅ 正常 | `opencode-go` 分组 **37** 条（无 `union-alpha`） |
| 两者共存，基线在前 | ✅ 正常 | 基线服务 37 条；plus 记一条 warn 后**主动退场** |
| 两者共存，plus 在前 | ❌ **退出码 1** | 基线抛未捕获的 `DUPLICATE_DISCOVERY`，整树加载失败 |
| 两者共存，基线被 patch `disabled` | ✅ 正常 | plus 服务 **38** 条 |

第四行是**基线的缺陷**，本包无法阻止 —— 唯一办法就是别把两个装在一起。

**所以升级路径是「先卸后装」**：

```bash
dsh plugin --profile web remove dsh-opencode-go
dsh plugin --profile web add <下载后的 dsh-opencode-go-plus-0.3.0.tgz 绝对路径>
```

**怎么确认装对了：数模型数**。plus 是 **38** 条并含 `union-alpha`；基线是 37 条且没有它。

> ⚠️ 走错路时**命令行不会报任何错**：`ctx.logger.warn` 只写进 harness 的内存日志
> 环形缓冲，**不输出到终端**。所以「看起来一切正常但模型数还是 37」就是本包退场了。
> 若要两者并存做对比，用包内 `examples/migrate-from-fork.patch.yml`
> 把基线 `disabled` 掉（上面表格最后一行那条，同样实测过）。

> **与另一类冲突区分开**：如果 `opencode-go` 路由被 `settings.yaml` 里
> `llm-pi-ai.providers.opencode-go` 那种**静态模型表**占用，本包会**换个路由**
> （`opencode-go-plus`）继续把目录服务出来，模型数仍是 38 —— 那是正常降级，不是退场。

---

<a name="appendix"></a>

## 附录：tarball 校验信息去哪了

**自 2026-09-18 起：没有「自研插件的 tarball 校验表」这回事了。**
`dsh-plugin-collection` 退役后，自研插件由**各自的源码仓库**以 git 依赖分发 ——
`github:` 安装拿到的是仓库里的 `lib/`，没有 tarball，也就没有配套的 sha256 清单。
本仓库自 0.4.0 起只托管**市场插件自己**一个 tarball：

| 内容 | 去哪看 |
|---|---|
| 6 个自研插件的版本 | 各自源码仓库的 `package.json`；市场侧见 [`catalog/plugins/`](./catalog/plugins) |
| 市场插件自己的版本 / sha256 | `catalog/plugins/dsh-plugins-market.json`（版本取自源码 `package.json`，sha256 由采集脚本实测）与 `plugins/dsh-plugins-market/0.1.6-alpha.1/*.tgz.sha256` 边车文件 |
| 第三方插件的字节完整性 | **本仓库不再分发它们的字节**。实测记录（含验证时的 commit）在 [`catalog/overrides/curated.json`](./catalog/overrides/curated.json)；装的时候由市场面板校验配置里记录的 sha256（若有） |

**自查命令**（核对本仓库里那唯一一个 tarball 的内容构成）：

```bash
for f in plugins/*/*/*.tgz; do
  printf "%-62s files=%s cordis=%s lib=%s lic=%s\n" "$f" \
    "$(tar -tzf "$f" | grep -vc '/$')" \
    "$(tar -tzf "$f" | grep -c 'cordis.patch.yml')" \
    "$(tar -tzf "$f" | grep -c 'package/lib/')" \
    "$(tar -tzf "$f" | grep -ciE 'package/LICENSE' )"
done
```

> 上面 `LICENSE` 一列曾经标出两个缺许可文件正文的包（`dsh-memory` 与
> `dsh-workbuddy-quota`）—— 前者现在的仓库里带 `LICENSE`，后者已随集合仓库退役下线
> （用量统计由 [`dsh-usage-stats`](https://github.com/HaydenSmith1121/dsh-usage-stats) 接手）。
> 新入库的插件一律要求带许可文件，见 [`CONTRIBUTING.md`](./CONTRIBUTING.md#requirements)。
