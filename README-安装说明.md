# DSH 插件离线导出包 — 新机安装说明

本包把你本机额外安装并优化过的 6 个 DeepSeek Harness(dsh) 插件，
连同 web profile 配置与 settings.yaml，打包成可在新机上离线复现的导出包。

> 来源机器：`C:\Users\Administrator\.dsh`
> 导出方式：每个插件用 `npm pack` 打成标准 npm tarball（含 lib + cordis.patch.yml）
> dsh 内置包（`@deepseek-ai/dsh-*`）不打包，新机随 dsh CLI 重装即可。

---

## 一、包内容

```
my-dsh-plugins/                      # = GitHub 私有仓库 HaydenSmith1121/my-dsh-plugins
├─ README.md                          # 总览：插件清单 + 批量安装 + 新增插件指南
├─ README-安装说明.md（本文件）
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

> 取用方式：`gh repo clone HaydenSmith1121/my-dsh-plugins`（私有，需 gh 登录），
> 或在 GitHub 网页 `Code → Download ZIP`。

---

## 二、新机前置条件

1. 已安装 **Node.js ≥ 22.19** 与 **pnpm**（`dsh plugin` 命令底层转发到 pnpm）。
   - 校验：`node -v`、`pnpm -v`。若 pnpm 缺失：`npm i -g pnpm`。
2. 已安装 **dsh CLI**：`npm i -g @deepseek-ai/dsh`
   - 校验：`dsh --version`。
3. 把本导出包整个目录（或 zip 解压后）放到新机任意路径，下文记作 `<EXPORT>`。

> 注意：dsh CLI 的版本最好与来源机一致或更新，否则内置 bundle
> (`@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app`) 接口可能对不上。
> 来源机 dsh 版本：`0.1.5-rc.1`（见 `dsh --version`）。

---

## 三、安装步骤（PowerShell，逐条执行）

以下命令假设你已经 `cd` 到仓库根目录（含 `plugins\` 子目录）。

### 1) 还原 settings.yaml（可选，推荐）

```powershell
# 把模型目录 / 默认模型配置覆盖到新机的 ~/.dsh/settings.yaml
$env:DSH_HOME          # 先确认新机的 DSH_HOME，默认是 %USERPROFILE%\.dsh
Copy-Item ".\settings\settings.yaml" "$env:USERPROFILE\.dsh\settings.yaml" -Force
```

> 若新机还没初始化 `.dsh`，先跑一次 `dsh --profile web --version` 让它生成目录。

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

### 3) 校验 bundles 顺序

```powershell
# 应包含全部 8 个 bundle，顺序与 profile-config\profile-bundles.yaml 一致：
dsh --profile web --dump-config | Select-String "bundles|bundle" -Context 0,8
```

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

如果顺序不对，手动编辑该 `package.json` 调成上面顺序，再重启 dsh web。

### 4) 启动并验证

```powershell
dsh web          # 或: dsh --profile web
```

浏览器打开 GUI（默认 http://127.0.0.1:3080），逐项确认：
- `dsh-connect-trae`：模型选择器里能看到 trae 模型（glm-5.2 等）。
- `dsh-opencode-go`：设置页有 OpenCode Go 模型供应商项（含你的本地优化）。
- `dsh-workbuddy-connect` / `dsh-workbuddy-quota`：WorkBuddy 连接、额度显示，以及按时间范围的 token 用量统计。
- `dsh-receipt` / `@dsh-market/plugin`：对应面板可见。

---

## 四、关于 dsh-opencode-go 的本地优化

来源机这个插件是从远程下载后**手动改了 13 处源码**再构建的
（改动在 src/，已编译进 lib/）。本导出包里的 tarball 用的是**最新构建产物**，
所以新机装上就能用，**不需要重新构建**，也不需要源码 / node_modules。

如果你以后还想在新机上继续改它的源码，那就不能只用 tarball ——
需要另外把源码项目目录整体拷过去。当前导出包不含源码（按你的选择）。

---

## 五、关于凭据

按你的选择，**本包不含 `.credentials.yaml`**（API key 所在）。
新机首次启动后，在 GUI 设置里手动填入各 provider 的 key 即可。
trae 的登录态也需要新机重新登录。

---

## 六、回滚 / 卸载某个插件

```powershell
dsh plugin --profile web remove <包名>     # 例如: dsh plugin --profile web remove dsh-receipt
```

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
