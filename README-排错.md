# dsh 插件安装 — 踩坑与排错记录

本文件记录**实际安装过程中撞到的坑**，每条含：现象 → 根因 → 修法 → 验证方式。
比 `README-安装说明.md` 更侧重「出错了怎么办」。

- 环境：Windows，dsh `0.1.5-rc.1`，pnpm `12.4.2`，Node `24.14.0`（system）
- 本记录来自一次真实的 6 插件全量还原（6/6 成功）

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

## 附录 A：完整校验清单（照抄即可）

```bash
export PATH="$APPDATA/npm:$PATH"

# ① 依赖层
dsh plugin --profile web list              # 期望 6 packages

# ② 注册表层：bundles 必须 8 项且顺序正确
cat ~/.dsh/profiles/web/package.json

# ③ ★ 装配层（最权威，前两层过了它仍可能挂）
dsh --profile web --dump-config | grep -n '^# == '

# ④ tarball 路径有效性
grep -o 'file:[^"]*' ~/.dsh/profiles/web/package.json

# ⑤ 构建脚本审批状态
cat ~/.dsh/profiles/web/pnpm-workspace.yaml    # allowBuilds 应无 "set this to true or false" 残留
```

最后一层最容易被跳过：**① 和 ② 都过了，GUI 里依然可能没有** —— 那就是坑 2 的
「bundles 没追加」。所以第 ③ 步必做。

---

## 附录 B：卸载 / 回滚

```bash
dsh plugin --profile web remove <包名>     # 例如 dsh-receipt
```

回滚整个 profile：把 `~/.dsh/profiles/web/` 下的 `package.json` / `pnpm-workspace.yaml` /
`cordis.patch.yml` 还原到改动前的备份即可（建议动手前先备份这 3 个文件）。
