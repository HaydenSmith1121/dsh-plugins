# dsh 插件安装 — 踩坑与排错记录

本文件记录**实际安装过程中撞到的坑**，每条含：现象 → 根因 → 修法 → 验证方式。
比 `README-安装说明.md` 更侧重「出错了怎么办」。

- 环境：Windows，dsh `0.1.6-alpha.1`（**见坑 7，版本必须对上**），pnpm `12.4.2`，Node `24.14.0`（system）
- 本记录来自一次真实的 6 插件全量还原（6/6 成功）

> ⚠️ **先看坑 7。** 它会让 `dsh web` **完全起不来**（整个插件树加载失败），
> 而且成因不在安装步骤上，而在 **dsh 版本**上 —— 装完插件直接启动就会撞。
> 按本文档的顺序走，最容易踩的就是它。

---

## 0. 先懂原理：`dsh plugin` 只是 pnpm 的薄封装

`dsh plugin --profile <name> <args>` 的实际行为是：`cd ~/.dsh/profiles/<name>/`
然后**原样执行 `pnpm <args>`**，成功后再把 `dsh.bundle` 声明的包追加进
`package.json` 的 `dsh.profile.bundles`。

**诊断价值**：`dsh plugin --profile web --help` 会把 **pnpm 自己的帮助**吐出来 —— 这一条就能
确认「参数是透传给 pnpm 的」。所以**任何装包层面的报错，实质都是 pnpm 的报错**，
去 pnpm 的文档/issue 找答案比在 dsh 里找有效。

---

## 坑 1：本机没有 pnpm

### 现象

```none
'pnpm' 不是内部或外部命令，也不是可运行的程序或批处理文件。
dsh: pnpm failed in profile directory C:\Users\Administrator\.dsh\profiles\web
```

连 `dsh plugin --profile web list` 都会报，因为 `list` 同样转发给 pnpm。

### 根因：这台机器上有**两个 Node**，容易装错地方

| node | 路径 | 全局 bin（npm prefix） | 在持久化 PATH 里？ |
|---|---|---|---|
| managed | `.workbuddy\binaries\node\versions\22.22.2-3` | 它自己的目录 | ❌ 只在 Bash 会话里临时出现 |
| **system** | `D:\tools\nodejs`（v24.14.0） | **`AppData\Roaming\npm`** | ✅ |

**`dsh` 本身就住在 `C:\Users\Administrator\AppData\Roaming\npm`** —— 那是 **system node**
的全局 bin。如果在 Bash 里直接 `npm i -g pnpm`，`npm` 解析到的是 managed node，
pnpm 会落进 managed node 自己的目录 → 用户在 cmd / PowerShell 里跑 `dsh web` 时找不到它。

### 修法

**用 system node 的 npm 装**（先确认 prefix 指向 `AppData\Roaming\npm`）：

```bash
# 确认真在用的 node 与其 prefix
"D:/tools/nodejs/npm.cmd" config get prefix
#   期望：C:\Users\Administrator\AppData\Roaming\npm

# 装 pnpm
"D:/tools/nodejs/npm.cmd" install -g pnpm --no-fund --no-audit
```

### 验证

```bash
ls "$APPDATA/npm/pnpm"*                          # 应能看到 pnpm / pnpm.cmd / pnpm.ps1
dsh plugin --profile web list                    # 不再报 pnpm 找不到
```

> 排查持久化 PATH 用 Python `winreg` 读 `HKCU\Environment` 的 `Path`
> （本机 `reg.exe` 被安全策略拦，不可用）。

---

## 坑 2 ★：`ERR_PNPM_IGNORED_BUILDS` —— 最坑的一个

### 现象

装到 `dsh-opencode-go` 时报：

```none
Error: ERR_PNPM_IGNORED_BUILDS
  × adding a new package
  ╰─▶ Ignored build scripts: @google/genai@1.52.0, protobufjs@7.6.6
  help: Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
dsh: pnpm failed in profile directory C:\Users\Administrator\.dsh\profiles\web
```

### 为什么坑：它的表象极具欺骗性

看到这个报错，第一反应是「装失败了」。但实际状态是：

| 检查项 | 实际 |
|---|---|
| `node_modules/dsh-opencode-go/` | ✅ **已存在**，98 个依赖也全部链接完毕 |
| `package.json` 的 `dependencies` | ✅ **已写入** `dsh-opencode-go` |
| `package.json` 的 `dsh.profile.bundles` | ❌ **没有追加** |

原因：dsh 的流程是「先跑 pnpm → 成功后才写 bundles」。pnpm 因「有未批准的构建脚本」
**以非 0 退出**，dsh 就提前 return 了。

**最终表现**：插件文件都在 `node_modules` 里，但 **dsh web 的 GUI 里完全看不到它**。
很容易误判成「装了但没生效」而去查前端。

> ⚠️ **别被 `node_modules` 里有文件骗到** —— 只要 pnpm 退出码非 0，就当作「这条插件没装完」。

### 根因：pnpm 10+ 默认拦截依赖的 install 脚本

`strictDepBuilds` 默认开启，防供应链投毒。`dsh-opencode-go` 的依赖树里有两个包声明了脚本：

| 包 | 脚本 | 实际作用 | 需要跑吗 |
|---|---|---|---|
| `protobufjs@7.6.6` | `postinstall: node scripts/postinstall` | 只打印一句 protobufjs-cli 提示 | ❌ 纯装饰 |
| `@google/genai@1.52.0` | `prepare: node scripts/prepare.js` | `prepare` **对 registry/tarball 安装本就不执行**（仅 git / 本地目录安装生效） | ❌ 不会跑 |

→ **两个都不需要执行**，可以直接标记为「已批准忽略」。

### 修法

pnpm 失败时会在 `~/.dsh/profiles/web/pnpm-workspace.yaml` 末尾**自动写下占位符**，
把它填成 `false` 即可：

```yaml
allowBuilds:
  '@google/genai': false
  protobufjs: false
```

改完**重跑同一条 `dsh plugin add`** 即可（幂等，会报 `Lockfile is up to date`）→ exit 0 →
dsh 这才补上 bundles 条目。

```bash
dsh plugin --profile web add ./plugins/dsh-opencode-go/dsh-opencode-go-0.1.2.tgz
```

> ✅ 已实测：**dsh 不会覆盖这个文件**，手写的 `allowBuilds` 能长期留存。
> 无需 `pnpm approve-builds`（那是交互式的，不适合脚本化）。

### 别用 `strictDepBuilds: false` 一把梭

那会把**将来真正需要编译的依赖**（native 模块等）也静默跳过。用 `allowBuilds` 逐个白名单
更安全 —— 保留了严格模式，遇到新的未知构建脚本仍会报出来。

---

## 坑 3：`file:` 依赖锚定**绝对路径**，tarball 目录不能挪

`dsh plugin add <tarball>` 生成的不是把包内容拷进去，而是 `file:` 形式的依赖：

```json
"dsh-opencode-go": "file:D:/deepseek/dsh-plugins/plugins/dsh-opencode-go/dsh-opencode-go-0.1.2.tgz"
```

**后果**：那个目录**不能删除、不能移动**，否则以后任何 `pnpm install` / `dsh plugin`
操作都会失败（找不到 tarball）。

### 实践建议

- 仓库 clone 到**持久路径**（如 `D:\deepseek\dsh-plugins`），**别放 `%TEMP%`**
- 也别放会被清理的下载目录
- 已经装好的 profile 运行时**不需要** tarball（内容已在 `node_modules`），
  但重新安装 / 升级时会需要

### 验证

```bash
grep -o 'file:[^"]*' ~/.dsh/profiles/web/package.json
# 逐条确认这些 tarball 路径真实存在
```

---

## 坑 4：用 `grep bundles` 校验配置 → 永远返回空

### 现象

按 `README-安装说明.md` 第 3 步校验时：

```bash
dsh --profile web --dump-config | grep bundles     # ← 输出为空！
```

看起来像「配置没生效」，其实配置是好的。

### 根因

`--dump-config` 输出的是**按 bundle 分组的装配树**，bundle 之间用注释头分隔：

```none
# == @deepseek-ai/dsh-base
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
...
# == dsh-opencode-go
- id: opencode-go
  name: dsh-opencode-go
```

**输出里根本没有 "bundles" 这个字面词**。

### 正确的校验写法

```bash
# ① bundle 装配顺序（期望：2 个 in-box + 6 个用户插件，共 8 个头）
dsh --profile web --dump-config | grep -n '^# == '

# ② 每个插件是否正确注入（name 应是包本名，不是回退路径）
dsh --profile web --dump-config | tail -30
```

期望末尾 6 个 bundle 及注入条目：

```none
# == @dsh-market/plugin          → - id: dsh-market        name: '@dsh-market/plugin'
# == dsh-workbuddy-connect       → - id: llm-workbuddy     name: dsh-workbuddy-connect
# == dsh-opencode-go             → - id: opencode-go       name: dsh-opencode-go
# == dsh-connect-trae            → - id: dsh-connect-trae  name: dsh-connect-trae
# == dsh-workbuddy-quota         → - id: workbuddy-quota   name: dsh-workbuddy-quota
# == dsh-receipt                 → - id: receipt           name: dsh-receipt
```

若某个 bundle 的 `name:` 不是包本名而是别的东西，说明模块 import 失败 →
查 `~/.dsh/profiles/web/.dsh-module-fallback/`。

> 注：`@deepseek-ai/dsh-base` 的头会**反复出现多次**（每次被 web-app 打 patch 都打一个头），
> 属正常，不是重复装配。

---

## 坑 5 ★：`settings/settings.yaml` **不要盲目覆盖**

### 现象

`README-安装说明.md` 第 1 步把还原 `settings.yaml` 列为「可选，推荐」。照做：

```powershell
Copy-Item .\settings\settings.yaml "$env:USERPROFILE\.dsh\settings.yaml" -Force
```

但在某些机器上，这一覆盖是**破坏性的**。

### 根因：仓库里的那份是「导出那一刻的快照」，可能比目标机更旧

实测遇到过的差异：

| | 顶层键 | `agent-default-model` |
|---|---|---|
| 仓库那份 | `ui-onboarding` / `agent-default-model` / **`trae`** | `trae` / `glm-5.2` |
| 目标机那份 | `ui-onboarding` / `agent-default-model` / **`ui-theme`** / **`llm-pi-ai`** | `opencode-go` / `deepseek-v4-flash` |

覆盖会**丢掉目标机 `llm-pi-ai.providers.opencode-go` 的完整模型清单与
`x-opencode-session` 请求头**，并把默认模型改回 `trae`。

### 正确做法：先 diff 顶层键，再决定

```bash
diff ./settings/settings.yaml ~/.dsh/settings.yaml
grep -E '^[a-zA-Z][a-zA-Z0-9_.-]*:' ./settings/settings.yaml ~/.dsh/settings.yaml
```

- 两边一致 → 随便
- **不一致 → 不要整文件覆盖**，按需 merge 具体段落

### 关于 `trae:` 段

`dsh-connect-trae` 确实会读 `settings.trae`（其 `lib/` 里可见 `lastCatalog` / `regions` /
`enabledModelIds`）。但 `lastCatalog` 只是**模型缓存**，登录后会重建。

→ **目标机缺 `trae:` 段，通常只需在 GUI 里重新登录 trae 即可**，不必覆盖整个 settings.yaml。
真要补，只 merge `trae:` 这**一个顶层段**。

---

## 坑 6：凭据与登录态**不随包迁移**（导出包有意不含）

`README-安装说明.md` 第五节已说明，但容易漏：

- `.credentials.yaml`（API key 所在）**不在包内** → GUI 设置里手填
- **trae 登录态**需在目标机重新登录
- `dsh-workbuddy-connect` 复用 **WorkBuddy 桌面端**的登录态，不另起 OAuth

---

## 坑 7 ★★★：dsh 版本不对 → **整个插件树加载失败，`dsh web` 完全起不来**

### 现象

6 个插件都装好、`dsh plugin list` 也正常，但一启动就崩：

```none
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
failed to import loader entry opencode-go (dsh-opencode-go):
The requested module '@deepseek-ai/dsh-llm' does not provide an export named 'IMAGE_OFFLOAD_REQUIRED_CODE'

file:///C:/Users/Administrator/.dsh/profiles/web/node_modules/dsh-opencode-go/lib/index.js:65
import { contentHasImage, IMAGE_OFFLOAD_REQUIRED_CODE, LlmError as LlmError2, offloadedImageText,
         projectOffloadedImages, requestImageHandleText, requiredImageOffload } from "@deepseek-ai/dsh-llm";
```

注意这不是「某个插件不能用」——**是 8 层 bundle 整体加载失败**，
所以**所有插件全废，`dsh web` 根本起不来**。

### 根因：插件的 peerDependencies 与 CLI 版本不匹配

`dsh-opencode-go` 的 `peerDependencies` 把整套 `@deepseek-ai/*` **精确 pin 在 `0.1.6-alpha.1`**：

```json
"peerDependencies": {
  "@deepseek-ai/dsh-llm": "0.1.6-alpha.1",
  "@deepseek-ai/dsh-attachment": "0.1.6-alpha.1",
  "@deepseek-ai/dsh-typert-protocol": "0.1.6-alpha.1",
  ...
}
```

而 dsh 在 npm 上的发行通道是：

| dist-tag | 版本 | 说明 |
|---|---|---|
| `latest` | **0.1.5-rc.1** | `npm i -g @deepseek-ai/dsh` 默认装这个 |
| `next` | 0.1.5-rc.2 | |
| `alpha` | **0.1.6-alpha.1** | ★ 插件要求的 |

`0.1.5-rc.1` 内置的 `@deepseek-ai/dsh-llm` 是 `0.1.5-rc.2`，**里面没有**
`IMAGE_OFFLOAD_REQUIRED_CODE` / `offloadedImageText` / `projectOffloadedImages` /
`requiredImageOffload` 这几个导出（图片卸载是 0.1.6 才加的 API）。

### 为什么 peer 依赖没自动补上

profile 的 `pnpm-workspace.yaml` 里有：

```yaml
autoInstallPeers: false      # ← 关键
```

pnpm 因此**不会安装 peer 依赖**，插件的 `import "@deepseek-ai/dsh-llm"`
只能沿目录树向上找到 **CLI 内置的那份**（0.1.5-rc.2）→ 导出缺失 → 报错。

### ★ 这个插件没有「兼容 0.1.5」的版本可选

查过 npm 上全部发布版本：

| dsh-opencode-go | 要求的 `@deepseek-ai/dsh-llm` |
|---|---|
| 0.1.0 | `0.1.6-alpha.1` |
| 0.1.1 | `0.1.6-alpha.1` |
| 0.1.2 | `0.1.6-alpha.1` |

**最老的 0.1.0 也要 alpha。** 所以「回退插件版本」这条路不存在 ——
想用这个插件，只能把 dsh 升到 `0.1.6-alpha.1`。

（顺带排除一个常见误解：这**不是**本仓库「13 处本地改造」造成的，
上游 0.1.1 / 0.1.2 的 peer 声明完全一样。）

### 修法

```bash
# ★ 必须用「dsh 所在的那个 Node」的 npm（见坑 1）
"D:/tools/nodejs/npm.cmd" install -g @deepseek-ai/dsh@0.1.6-alpha.1
dsh --version        # 期望 0.1.6-alpha.1
```

验证内置运行时确实带上了新 API：

```bash
node -e "console.log(require('C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/package.json').version)"
# 期望 0.1.6-alpha.1
grep -c IMAGE_OFFLOAD_REQUIRED_CODE \
  "/c/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js"
# 期望 > 0
```

然后真实启动一次（`--dump-config` **验不出这个问题**，因为它只打配置树、不 import 模块）：

```bash
dsh web --no-open --port 0 > boot.log 2>&1 &
sleep 30
cat boot.log     # 期望只有 "dsh web: http://127.0.0.1:<port>/?token=..."
                 # 若出现 plugin tree failed to load / SyntaxError / does not provide an export 就是没修好
```

### ★★ 最大的陷阱：以后会被**静默降级**

`npm i -g @deepseek-ai/dsh`（**不带版本**）装的是 `latest` = `0.1.5-rc.1`。
以后只要顺手跑一次升级，就会把 CLI 降回 0.1.5，**坑 7 立刻复现**，而且没有任何提示。

→ 升级 dsh 时**必须显式带版本**，并且每次升级后重跑一次上面那条启动验证。

### 六个插件的版本兼容矩阵（照 `package.json` 的 peerDependencies 实测）

| 插件 | 要求的 `@deepseek-ai/dsh-llm` | 兼容 0.1.5-rc.x？ | 兼容 0.1.6-alpha.1？ |
|---|---|---|---|
| `@dsh-market/plugin` | 无 `@deepseek-ai` peer | ✓ | ✓ |
| `dsh-workbuddy-connect` | `^0.1.5-rc.1` | ✓ | ✓（运行时可用） |
| **`dsh-opencode-go`** | **`0.1.6-alpha.1`（精确 pin）** | **✗** | **✓** |
| `dsh-connect-trae` | `>=0.1.5-0 <0.2.0-0` | ✓ | ✓（运行时可用） |
| `dsh-workbuddy-quota` | 无 | ✓ | ✓ |
| `dsh-receipt` | 无 | ✓ | ✓ |

**结论：整批插件必须以 `0.1.6-alpha.1` 为运行时基线。**

> 关于 `dsh-workbuddy-connect`（`^0.1.5-rc.1`）和 `dsh-connect-trae`
> （`>=0.1.5-0 <0.2.0-0`）：按 semver 的预发布规则，`0.1.6-alpha.1` 严格来说
> 不在这两个范围里，pnpm 会打 peer 警告 —— 但**这只是警告**，
> 因为 `autoInstallPeers: false` 本来就不装 peer。实测在 0.1.6-alpha.1 上，
> 这两个插件与 `@dsh-market/plugin`、`dsh-workbuddy-quota`、`dsh-receipt`
> 一起正常加载（6/6，无致命错误）。

### 影响面：会连带影响**使用全局 dsh 的其他程序**

这台机器上 `deepseek-harness-desktop-zh`（Electron 桌面壳）的运行时解析顺序是
`本机全局安装 → 应用内置副本 → npx`，且 `vendor/dsh/` 默认是空的 ——
**它会优先用全局 dsh**。把它升到 alpha 后，那个应用也会跟着用 alpha，
而它的 `docs/COMPATIBILITY.md` 是照 `0.1.5-rc.1` 验证的。

隔离办法（用它自己支持的机制，不碰全局）：

```bash
cd <desktop-zh 仓库>
# 1) 把 0.1.5-rc.1 内置进 vendor/dsh（自包含，不依赖全局安装）
node scripts/fetch-dsh.mjs --version 0.1.5-rc.1

# 2) 把运行时模式切成「仅内置」
#    写 %APPDATA%\DeepSeek Harness Desktop\settings.json：
#    { "runtimeMode": "bundled" }
#    runtimeMode 合法值：auto | local | bundled | npx
```

这样 CLI 用 alpha 跑插件、桌面壳用自带的 0.1.5-rc.1，两边互不干扰。

---

## 附录 A：完整校验清单（照抄即可）

```bash
export PATH="$APPDATA/npm:$PATH"

# ⓪ ★ dsh 版本（最先查！错了后面全白搭，见坑 7）
dsh --version                              # 必须是 0.1.6-alpha.1

# ① 依赖层
dsh plugin --profile web list              # 期望 6 packages

# ② 注册表层：bundles 必须 8 项且顺序正确
cat ~/.dsh/profiles/web/package.json

# ③ ★ 装配层（只打配置树、**不 import 模块**，所以查不出坑 7）
dsh --profile web --dump-config | grep -n '^# == '

# ④ ★ 真实启动（唯一能验证「模块能不能 import」的办法，坑 7 只有这步能查出来）
dsh web --no-open --port 0 > boot.log 2>&1 &
sleep 30; cat boot.log; kill %1
#   期望：只有一行 "dsh web: http://127.0.0.1:<port>/?token=..."
#   出现 plugin tree failed to load / SyntaxError / does not provide an export → 回坑 7

# ⑤ tarball 路径有效性
grep -o 'file:[^"]*' ~/.dsh/profiles/web/package.json

# ⑥ 构建脚本审批状态
cat ~/.dsh/profiles/web/pnpm-workspace.yaml    # allowBuilds 应无 "set this to true or false" 残留
```

**第 ③ 和 ④ 步的分工要分清**：`--dump-config` 只看配置树组装，
**不加载任何模块**，所以坑 7（导出缺失）在它那儿完全看不出来 —— 必须靠第 ④ 步真实启动。
反之，第 ④ 步查不出 bundles 顺序错。**两步都要做。**

---

## 附录 B：卸载 / 回滚

```bash
dsh plugin --profile web remove <包名>     # 例如 dsh-receipt
```

回滚整个 profile：把 `~/.dsh/profiles/web/` 下的 `package.json` / `pnpm-workspace.yaml` /
`cordis.patch.yml` 还原到改动前的备份即可（建议动手前先备份这 3 个文件）。
