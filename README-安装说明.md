# DSH 插件离线包 — 新机安装说明

本包把 6 个 DeepSeek Harness(dsh) 插件（部分自研、部分收集自他人开源项目，
来源见 [`README.md` 第二节](./README.md#二插件来源与许可)），
连同 web profile 配置与 settings.yaml，打包成可在新机上离线复现的导出包。

> 来源机器：`C:\Users\Administrator\.dsh`
> 导出方式：每个插件用 `npm pack` 打成标准 npm tarball（含 lib + cordis.patch.yml）
> dsh 内置包（`@deepseek-ai/dsh-*`）不打包，新机随 dsh CLI 重装即可。

> ⚠️ **报错了先看 [`README-排错.md`](./README-排错.md)** —— 里面是实际踩过的坑，
> 本文件有两处步骤会被它修正（见第 3 节 1) 和 3) 的提示）。

---

## 一、包内容

```
dsh-plugins/                         # = GitHub 仓库 HaydenSmith1121/dsh-plugins
├─ README.md                          # 总览：来源与许可 + 插件清单 + 批量安装 + 新增插件指南
├─ README-安装说明.md（本文件）
├─ README-排错.md                     # ★ 踩坑与排错记录（出错先看）
├─ plugins/                          # 每个插件一个目录，便于增量添加
│  ├─ dsh-market-plugin/dsh-market-plugin-0.4.8.tgz
│  ├─ dsh-workbuddy-connect/dsh-workbuddy-connect-0.5.3.tgz
│  ├─ dsh-opencode-go/dsh-opencode-go-0.1.2.tgz   # 含 13 处本地源码优化（已构建进 lib）
│  ├─ dsh-connect-trae/dsh-connect-trae-2.0.1.tgz
│  ├─ dsh-workbuddy-quota/dsh-workbuddy-quota-0.2.0.tgz
│  └─ dsh-receipt/dsh-receipt-0.1.0.tgz
├─ profile-config/
│  └─ profile-bundles.yaml           # web profile 的 bundles 顺序清单
└─ settings/
   └─ settings.yaml                  # 默认模型 / trae 模型目录等（不含密钥）
```

> 取用方式：`gh repo clone HaydenSmith1121/dsh-plugins`
> （公开仓库；旧名 `my-dsh-plugins` 会自动 301 重定向），
> 或网页 `Code → Download ZIP`。

---

## 二、新机前置条件

1. 已安装 **Node.js ≥ 22.19** 与 **pnpm**（`dsh plugin` 命令底层转发到 pnpm）。
   - 校验：`node -v`、`pnpm -v`。若 pnpm 缺失：`npm i -g pnpm`。
   - ⚠️ **多 Node 环境必读**：pnpm 必须装在**「dsh 所在的那个 Node」**上。
     本机曾出现两个 Node 并存（便携版 + 系统版），在 Bash 里 `npm i -g pnpm` 装到了
     另一个 Node 上，`dsh plugin` 直接报 `'pnpm' 不是内部或外部命令`。
     先确认 `npm config get prefix` 指向的正是 `dsh` 所在目录（`where dsh`）再装。
     完整排查见 [`README-排错.md` 坑 1](./README-排错.md)。
2. 已安装 **dsh CLI**：`npm i -g @deepseek-ai/dsh`
   - 校验：`dsh --version`。
3. 把本导出包整个目录（或 zip 解压后）放到新机**持久路径**，下文记作 `<EXPORT>`。
   - ⚠️ **不要放临时目录**：`dsh plugin add` 生成的是 `file:` 绝对路径依赖，
     这个目录后续不能删、不能挪。见 [`README-排错.md` 坑 3](./README-排错.md)。

> 注意：dsh CLI 的版本最好与来源机一致或更新，否则内置 bundle
> (`@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app`) 接口可能对不上。
> 来源机 dsh 版本：`0.1.5-rc.1`（见 `dsh --version`）。

---

## 三、安装步骤（PowerShell，逐条执行）

以下命令假设你已经 `cd` 到仓库根目录（含 `plugins\` 子目录）。

### 1) 还原 settings.yaml —— ★ 先 diff，不要盲目覆盖

```powershell
# 先确认新机的 DSH_HOME，默认是 %USERPROFILE%\.dsh
$env:DSH_HOME

# ★ 先对比顶层键，判断两份配置是否同一代
Select-String -Path ".\settings\settings.yaml" -Pattern '^[a-zA-Z][\w.-]*:'
Select-String -Path "$env:USERPROFILE\.dsh\settings.yaml" -Pattern '^[a-zA-Z][\w.-]*:'
```

**只有两边一致（或新机还没有 settings.yaml）时才可以整体覆盖**：

```powershell
Copy-Item ".\settings\settings.yaml" "$env:USERPROFILE\.dsh\settings.yaml" -Force
```

> ⚠️ **本包里的 settings.yaml 是「导出那一刻的快照」，可能比目标机更旧。**
> 实测遇到过：本包那份顶层键是 `ui-onboarding / agent-default-model / trae`
> （默认模型 `trae/glm-5.2`），而目标机那份是
> `ui-onboarding / agent-default-model / ui-theme / llm-pi-ai`
> （默认模型 `opencode-go/deepseek-v4-flash`）。
> 整体覆盖会**丢掉目标机 `llm-pi-ai.providers.*` 的完整模型清单**。
> 完整说明见 [`README-排错.md` 坑 5](./README-排错.md)。

若新机还没初始化 `.dsh`，先跑一次 `dsh --profile web --version` 让它生成目录。

### 2) 逐个安装 6 个插件 tarball

`dsh plugin --profile web add <tarball>` 会：
- 在 `~/.dsh/profiles/web` 跑 `pnpm add <tarball>`
- 自动把声明了 `dsh.bundle` 的包追加进 `dsh.profile.bundles`

**按下列顺序安装**（顺序即 bundle 层级顺序，照 profile-bundles.yaml）：

```powershell
dsh plugin --profile web add .\plugins\dsh-market-plugin\dsh-market-plugin-0.4.8.tgz
dsh plugin --profile web add .\plugins\dsh-workbuddy-connect\dsh-workbuddy-connect-0.5.3.tgz
dsh plugin --profile web add .\plugins\dsh-opencode-go\dsh-opencode-go-0.1.2.tgz
dsh plugin --profile web add .\plugins\dsh-connect-trae\dsh-connect-trae-2.0.1.tgz
dsh plugin --profile web add .\plugins\dsh-workbuddy-quota\dsh-workbuddy-quota-0.2.0.tgz
dsh plugin --profile web add .\plugins\dsh-receipt\dsh-receipt-0.1.0.tgz
```

> 路径用反斜杠或正斜杠均可；相对路径会被 dsh 自动锚定到你当前目录。
>
> ⚠️ **装 `dsh-opencode-go` 时可能报 `ERR_PNPM_IGNORED_BUILDS`**（pnpm 10+
> 默认拦截依赖的构建脚本）。这个报错**极具欺骗性**：包其实已经装进 `node_modules`、
> `dependencies` 也写了，**唯独 `dsh.profile.bundles` 没追加**，表现为「装上了但 GUI 里没有」。
> 修法是在 `~/.dsh/profiles/web/pnpm-workspace.yaml` 里填 `allowBuilds`，然后重跑该条命令。
> 详见 [`README-排错.md` 坑 2](./README-排错.md)。

### 3) 校验 bundles 顺序

```powershell
# ★ 注意：--dump-config 输出里没有 "bundles" 这个字面词！
#   它按 bundle 分组，用 "# == <bundle 名>" 做分节头，所以要匹配 '^# == '
dsh --profile web --dump-config | Select-String '^# == '
```

**不要用 `Select-String "bundles"`** —— 会返回空，很容易误判成「配置没生效」。
见 [`README-排错.md` 坑 4](./README-排错.md)。

或直接看文件：

```powershell
# 路径: ~/.dsh/profiles/web/package.json 里的 dsh.profile.bundles
type "$env:USERPROFILE\.dsh\profiles\web\package.json"
```

期望看到 `dsh.profile.bundles` 数组为：

```
@deepseek-ai/dsh-base
@deepseek-ai/dsh-web-app
@dsh-market/plugin
dsh-workbuddy-connect
dsh-opencode-go
dsh-connect-trae
dsh-workbuddy-quota
dsh-receipt
```

`--dump-config` 的期望输出（末尾 6 节，即 6 个用户插件各自注入一条）：

```
# == @dsh-market/plugin          → - id: dsh-market        name: '@dsh-market/plugin'
# == dsh-workbuddy-connect       → - id: llm-workbuddy     name: dsh-workbuddy-connect
# == dsh-opencode-go             → - id: opencode-go       name: dsh-opencode-go
# == dsh-connect-trae            → - id: dsh-connect-trae  name: dsh-connect-trae
# == dsh-workbuddy-quota         → - id: workbuddy-quota   name: dsh-workbuddy-quota
# == dsh-receipt                 → - id: receipt           name: dsh-receipt
```

若某个 bundle 的 `name:` 不是包本名，说明模块 import 失败 →
查 `~/.dsh/profiles/web/.dsh-module-fallback/`。

如果 bundles 顺序不对，手动编辑该 `package.json` 调成上面顺序，再重启 dsh web。

### 4) 启动并验证

```powershell
dsh web          # 或: dsh --profile web
```

浏览器打开 GUI（默认 http://127.0.0.1:3080），逐项确认：
- `dsh-connect-trae`：模型选择器里能看到 trae 模型（glm-5.2 等）。
- `dsh-opencode-go`：设置页有 OpenCode Go 模型供应商项（含本仓库的本地改造）。
- `dsh-workbuddy-connect` / `dsh-workbuddy-quota`：WorkBuddy 连接、额度显示，以及按时间范围的 token 用量统计。
- `dsh-receipt` / `@dsh-market/plugin`：对应面板可见。

> **GUI 里看不到某个插件时的排查顺序**：先跑第 3 节的 `--dump-config` 校验，
> 再看 [`README-排错.md` 坑 2](./README-排错.md)（`ERR_PNPM_IGNORED_BUILDS` 会导致
> 「装上了但 bundles 没追加」）。别一上来就查前端。

---

## 四、关于 dsh-opencode-go 的本地改造

本仓库收录的 `dsh-opencode-go` 上游为
[Duskriver/dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go)（MIT）。
本仓库这份是**在上游基础上手动改了 13 处源码**后重新构建的版本
（改动在 `src/`，已编译进 `lib/`），与上游 npm 发布版**不完全一致**。

本包里的 tarball 用的是**最新构建产物**，所以新机装上就能用，
**不需要重新构建**，也不需要源码 / node_modules。

如果要继续改它的源码，那就不能只用 tarball ——
需要另外把源码项目目录整体拷过去。当前仓库不含源码。

---

## 五、关于凭据

**本包不含 `.credentials.yaml`**（API key 所在）。
新机首次启动后，在 GUI 设置里手动填入各 provider 的 key 即可。
trae 的登录态也需要在新机重新登录。

---

## 六、回滚 / 卸载某个插件

```powershell
dsh plugin --profile web remove <包名>     # 例如: dsh plugin --profile web remove dsh-receipt
```

> 动手前建议先备份 `~/.dsh/profiles/web/` 下的这 3 个文件：
> `package.json`、`pnpm-workspace.yaml`、`cordis.patch.yml`。
> 出错时把它们还原即可整体回滚。

---

## 七、tarball 校验信息（来源机打包时的文件数）

| 插件 | 版本 | tarball 内文件数 | 含 cordis.patch.yml | 含 lib |
|---|---|---|---|---|
| @dsh-market/plugin | 0.4.8 | 7 | ✓ | ✓ |
| dsh-connect-trae | 2.0.1 | 12 | ✓ | ✓ |
| dsh-receipt | 0.1.0 | 16 | ✓ | ✓ |
| dsh-workbuddy-connect | 0.5.3 | 11 | ✓ | ✓ |
| dsh-opencode-go | 0.1.2 | 30 | ✓ | ✓ |
| dsh-workbuddy-quota | 0.2.0 | 5 | ✓ | ✓ |
