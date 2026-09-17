# DSH 插件包 — 安装说明

本仓库把 8 个 DeepSeek Harness（dsh）插件打成离线 tarball，连同 web profile 的
bundle 顺序与 settings 快照，做到**新机可完整复现**。

> 部分插件为自研，部分收集自他人开源项目，来源与许可见
> [`README.md` 第二节](./README.md#二插件来源与许可)。所有第三方插件版权归原作者所有。

**本文件是唯一的安装文档，自包含。** 里面每一步都已经把「容易出错的地方」
直接写成了预防措施和自检项 —— 照着走就不会遇到那些问题，出问题也能就地定位。

---

## 一、30 秒开始

前置只有一个：**Node ≥ 22.19**（[nodejs.org](https://nodejs.org/)）。

```bash
git clone https://github.com/HaydenSmith1121/dsh-plugins
cd dsh-plugins
```

然后按平台跑一个入口脚本：

| 平台 | 命令 |
|---|---|
| Windows | `scripts\install.cmd` |
| Windows（PowerShell 里） | `.\scripts\install.ps1` |
| macOS / Linux | `./scripts/install.sh` |

脚本会自动做完这五件事，**每一步都先检测再决定**：

1. **环境预检** —— Node 版本、dsh 是否存在及版本、pnpm 是否存在
2. **判定** —— 你这台机器的 dsh 版本对应仓库里哪一套插件；不匹配就停下来告诉你该装哪个版本
3. **补齐缺失环境** —— 没有 pnpm 就装（且装在 dsh 所在的那个 Node 上）；预置 `allowBuilds`
4. **按序安装** —— 严格照 bundle 层级顺序逐个装
5. **四步校验** —— 版本 / 依赖层 / 装配层 / 真实启动，四层都可能出不同的问题

想先看看不改动任何东西？加 `-PreflightOnly`（Windows）或 `--preflight-only`：

```powershell
.\scripts\install.ps1 -PreflightOnly     # 只体检，不装
.\scripts\install.ps1 -DryRun            # 只打印将要执行的命令
```

---

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

## 三、dsh 版本：为什么必须锁定 `0.1.6-alpha.1`

dsh 在 npm 上有多条发行通道：

| dist-tag | 版本 | 说明 |
|---|---|---|
| `latest` | `0.1.5-rc.1` | `npm i -g @deepseek-ai/dsh`（**不带版本**）默认装这个 |
| `next` | `0.1.5-rc.2` | |
| **`alpha`** | **`0.1.6-alpha.1`** | ★ 本仓库插件要求的 |

**必须显式带版本号安装**：

```bash
npm i -g @deepseek-ai/dsh@0.1.6-alpha.1
dsh --version        # 必须显示 0.1.6-alpha.1
```

### 版本不对会怎样：整个插件树加载失败

不是「某个插件不能用」，而是 **10 层 bundle 整体加载失败、`dsh web` 完全起不来**：

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

照各包 `package.json` 的 `peerDependencies` 实测（**这是选 dsh 版本的唯一依据**）：

| 插件 | 要求的 `@deepseek-ai/dsh-llm` | 0.1.5-rc.x | 0.1.6-alpha.1 |
|---|---|---|---|
| `@dsh-market/plugin` | 无 `@deepseek-ai` peer | ✓ | ✓ |
| `dsh-workbuddy-connect` | `^0.1.5-rc.1` | ✓ | ✓（仅有 peer 警告） |
| **`dsh-opencode-go-plus`** | **`0.1.6-alpha.1`（精确 pin）** | **✗** | **✓** |
| `dsh-connect-trae` | `>=0.1.5-0 <0.2.0-0` | ✓ | ✓ |
| `dsh-workbuddy-quota` | 仅 cordis / react | ✓ | ✓ |
| `dsh-receipt` | `cordis@4.0.1`、`dsh-session@0.1.0-rc.6`、`dsh-tools@0.1.0-rc.6` | ✓ | ✓（仅有 peer 警告） |
| `dsh-session-cleanup` | 仅 cordis / react | ✓ | ✓ |
| `dsh-ark-plans` | `@deepseek-ai/dsh-llm-pi-ai` / `dsh-credentials` 精确 pin `0.1.6-alpha.1` | ✗ | ✓ |

**→ 整批插件以 `0.1.6-alpha.1` 为运行时基线。**

<details>
<summary>两个 peer 警告的准确含义（点开）</summary>

- **`dsh-workbuddy-connect`**（`^0.1.5-rc.1`）：按 semver 的预发布规则，
  `^0.1.5-rc.1` 的上界是裸 `0.2.0`，而预发布版只有在范围里存在
  **同 major.minor.patch** 的预发布比较器时才会被纳入 —— 所以 `0.1.6-alpha.1`
  严格来说不在这个范围里。但因为 `autoInstallPeers: false` 本来就不装 peer，
  这只产生警告，不影响加载。
- **`dsh-connect-trae`**（`>=0.1.5-0 <0.2.0-0`）：范围**两端都带 `-0`**，
  这正是为了把预发布版纳入比较 —— **`0.1.6-alpha.1` 满足该范围**，不是警告。
- **`dsh-receipt`**：精确 pin 在 `0.1.0-rc.6` 的 `dsh-session` / `dsh-tools`
  与 `0.1.6-alpha.1` 不一致，会产生 peer 警告；但这两个包在运行时仍存在，实测可加载。

以上均为实测结论（7/7 插件在 `0.1.6-alpha.1` 上正常加载）。

</details>

---

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
> （默认模型 `trae/glm-5.2`），而目标机那份是
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

### 4) 按顺序安装 8 个插件

**顺序即 bundle 层级顺序，别乱**（见 `profile-config/profile-bundles.yaml`）：

```powershell
dsh plugin --profile web add .\plugins\dsh-market-plugin\0.1.6-alpha.1\dsh-market-plugin-0.4.8.tgz
dsh plugin --profile web add .\plugins\dsh-workbuddy-connect\0.1.6-alpha.1\dsh-workbuddy-connect-0.5.3.tgz
dsh plugin --profile web add .\plugins\dsh-opencode-go-plus\0.1.6-alpha.1\dsh-opencode-go-plus-0.3.0.tgz
dsh plugin --profile web add .\plugins\dsh-connect-trae\0.1.6-alpha.1\dsh-connect-trae-2.0.1.tgz
dsh plugin --profile web add .\plugins\dsh-workbuddy-quota\0.1.6-alpha.1\dsh-workbuddy-quota-0.2.0.tgz
dsh plugin --profile web add .\plugins\dsh-receipt\0.1.6-alpha.1\dsh-receipt-0.1.0.tgz
dsh plugin --profile web add .\plugins\dsh-session-cleanup\0.1.6-alpha.1\dsh-session-cleanup-0.1.2.tgz
dsh plugin --profile web add .\plugins\dsh-ark-plans\0.1.6-alpha.1\dsh-ark-plans-0.1.0.tgz
```

```bash
# macOS / Linux：把 \ 换成 / 即可
dsh plugin --profile web add ./plugins/dsh-market-plugin/0.1.6-alpha.1/dsh-market-plugin-0.4.8.tgz
# ...
```

`dsh plugin --profile web add <tarball>` 会：
- 在 `~/.dsh/profiles/web` 跑 `pnpm add <tarball>`
- 成功后把声明了 `dsh.bundle` 的包追加进 `package.json` 的 `dsh.profile.bundles`

> **路径里的 `0.1.6-alpha.1` 是 dsh 运行时版本，不是插件版本** ——
> 这是本仓库的多版本目录结构，详见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

---

## 五、路径要求（★ 装之前先看）

`dsh plugin add <tarball>` 生成的**不是**把包内容拷进去，而是 `file:` 形式的依赖：

```json
"dsh-opencode-go-plus": "file:D:/deepseek/dsh-plugins/plugins/dsh-opencode-go-plus/0.1.6-alpha.1/dsh-opencode-go-plus-0.3.0.tgz"
```

**后果**：这个目录**不能删除、不能移动**，否则以后任何 `pnpm install` /
`dsh plugin` 操作都会失败（找不到 tarball）。

**所以**：

- 仓库 clone 到**持久路径**（如 `D:\dsh-plugins`），**别放 `%TEMP%`**
- 也别放会被清理的下载目录
- 已经装好的 profile 运行时**不需要** tarball（内容已在 `node_modules`），
  但重新安装 / 升级时会需要

**自检**：

```bash
grep -o 'file:[^"]*' ~/.dsh/profiles/web/package.json
# 逐条确认这些 tarball 路径真实存在
```

万一必须挪动仓库目录，正确做法是三步：**改完路径 → 重新 install → 跑校验**：

```bash
# 1) 把 profile 里 7 条 file: 路径改成新位置（或直接重新 add 一遍）
# 2) 重跑 pnpm install 让链接指向新位置
cd ~/.dsh/profiles/web && pnpm install
# 3) 真实启动校验（见第六节第 ④ 步）
node scripts/verify.mjs
```

---

## 六、安装后校验：四步，缺一不可

```bash
# 也可以直接跑脚本，它做的就是这四步
node scripts/verify.mjs
```

| # | 查什么 | 命令 | 期望 |
|---|---|---|---|
| ① | **dsh 版本** | `dsh --version` | `0.1.6-alpha.1` |
| ② | **依赖层** | `dsh plugin --profile web list` | 7 packages |
| ③ | **装配层** | `dsh --profile web --dump-config` | 9 个 bundle，顺序正确 |
| ④ | **真实启动** | `dsh web --no-open --port 0` | 只有一行服务地址，无致命错误 |

### ③ 的正确写法（`grep bundles` 永远返回空）

`--dump-config` 输出的是**按 bundle 分组的装配树**，用 `# == <bundle 名>` 做分节头，
**输出里根本没有 "bundles" 这个字面词**：

```bash
dsh --profile web --dump-config | grep -n '^# == '
```

**不要用 `grep bundles`** —— 会返回空，很容易误判成「配置没生效」。

期望看到 10 个 bundle 头，末尾 8 个是用户插件：

```none
# == @deepseek-ai/dsh-base        （这个头会重复出现多次，属正常，不是重复装配）
# == @deepseek-ai/dsh-web-app
# == @dsh-market/plugin          → - id: dsh-market        name: '@dsh-market/plugin'
# == dsh-workbuddy-connect       → - id: llm-workbuddy     name: dsh-workbuddy-connect
# == dsh-opencode-go-plus        → - id: opencode-go-plus  name: dsh-opencode-go-plus
# == dsh-connect-trae            → - id: dsh-connect-trae  name: dsh-connect-trae
# == dsh-workbuddy-quota         → - id: workbuddy-quota   name: dsh-workbuddy-quota
# == dsh-receipt                 → - id: receipt           name: dsh-receipt
# == dsh-session-cleanup         → - id: session-cleanup   name: dsh-session-cleanup
# == dsh-ark-plans               → - id: ark-plans         name: dsh-ark-plans
```

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

## 七、GUI 里看不到某个插件？按这个顺序查

**不要一上来就查前端。** 按层次查，每层都能独立定位问题：

```none
① dsh --version 不是 0.1.6-alpha.1？
      └─→ 第三节。升级 dsh（必须带版本号），然后真实启动验证

② dsh plugin --profile web list 里少包？
      └─→ 重跑安装。若报 ERR_PNPM_IGNORED_BUILDS，看下面那段

③ --dump-config 里少 bundle 或顺序不对？
      └─→ 直接编辑 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles，
          调成第六节列出的顺序，重启 dsh web

④ 配置树正常但启动报错、或 GUI 里面板不出现？
      └─→ 真实启动看 boot log
```

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
| `node_modules/dsh-opencode-go-plus/` | ✅ **已存在**，98 个依赖也全部链接完毕 |
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

---

## 八、凭据与登录态不随包迁移

本包**有意不含** `.credentials.yaml`（API key 所在）：

- 各 provider 的 API key → 首次启动后在 GUI 设置里手填
- **trae 登录态** → 需在目标机重新登录
- `dsh-workbuddy-connect` 复用 **WorkBuddy 桌面端**的登录态，不另起 OAuth

---

## 九、卸载 / 回滚

```bash
dsh plugin --profile web remove <包名>     # 例如: dsh plugin --profile web remove dsh-receipt
```

> 动手前建议先备份 `~/.dsh/profiles/web/` 下的这 3 个文件：
> `package.json`、`pnpm-workspace.yaml`、`cordis.patch.yml`。
> 出错时把它们还原即可整体回滚。

---

## 十、关于 `dsh-opencode-go-plus` 的来历、改造与共存禁忌

本仓库的 `dsh-opencode-go-plus@0.3.0` 是**派生包**，基线为上游
[Duskriver/dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go)`@0.1.2`（MIT）。
它**取代**了此前收录的 `dsh-opencode-go@0.1.2`（那一版含 13 处本地源码改动）。

包里的 tarball 是**编译产物**（只有 `lib/`，没有 `src/`），所以新机装上就能用，
**不需要重新构建**，也不需要源码 / node_modules。要继续改它的逻辑，就得另拿源码项目目录，
当前仓库不含源码。

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
dsh plugin --profile web add .\plugins\dsh-opencode-go-plus\0.1.6-alpha.1\dsh-opencode-go-plus-0.3.0.tgz
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

## 附录：tarball 校验信息

每个 tarball 均已验证含 `package.json` + `cordis.patch.yml` + `lib/`：

| 插件 | 版本 | 文件数 | 含 cordis.patch.yml | 含 lib | 含 LICENSE |
|---|---|---|---|---|---|
| `@dsh-market/plugin` | 0.4.8 | 7 | ✓ | ✓ | **✗** |
| `dsh-workbuddy-connect` | 0.5.3 | 11 | ✓ | ✓ | ✓ |
| `dsh-opencode-go-plus` | 0.3.0 | 31 | ✓ | ✓ | ✓ |
| `dsh-connect-trae` | 2.0.1 | 12 | ✓ | ✓ | ✓ |
| `dsh-workbuddy-quota` | 0.2.0 | 5 | ✓ | ✓ | **✗** |
| `dsh-receipt` | 0.1.0 | 16 | ✓ | ✓ | ✓ |
| `dsh-session-cleanup` | 0.1.2 | 6 | ✓ | ✓ | ✓ |
| `dsh-ark-plans` | 0.1.0 | 6 | ✓ | ✓ | ✓ |

> `LICENSE` 列标注 **✗** 的两个包，其 `package.json` 里 `license` 字段均为 `MIT`，
> 但 tarball 内未附许可文件正文。`@dsh-market/plugin` 的上游许可见
> [README 第二节](./README.md#二插件来源与许可)；`dsh-workbuddy-quota` 为本仓库自研。
> 新入库的插件一律要求带许可文件，见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

自查命令：

```bash
for f in plugins/*/*/*.tgz; do
  printf "%-60s files=%s cordis=%s lib=%s lic=%s\n" "$f" \
    "$(tar -tzf "$f" | grep -vc '/$')" \
    "$(tar -tzf "$f" | grep -c 'cordis.patch.yml')" \
    "$(tar -tzf "$f" | grep -c 'package/lib/')" \
    "$(tar -tzf "$f" | grep -ciE 'package/LICENSE' )"
done
```
