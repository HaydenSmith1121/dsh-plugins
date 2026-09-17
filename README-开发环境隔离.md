# 开发环境隔离 — 在新设备上一边用 harness、一边开发插件

> 这份文档解决一件事：**让「日常在用的 harness」和「正在开发插件的 harness」互不影响。**
> 换设备后，clone 本仓库、跑两条命令即可复现，不需要改任何脚本。

---

## 一、为什么需要隔离

插件的开发调试会频繁写 profile：装/卸插件、改 `settings.yaml`、改 patch 层。
如果直接在默认的 `~/.dsh` 上做，会遇到三件事：

| 现象 | 原因 |
|---|---|
| 正在用的页面突然断连 | `dsh web` **不能起两次**。第二个进程抢同一端口，第一个一退出，原页面连接就断 |
| `dsh web` 起不来 | 插件树被改坏（缺导出、peer 版本不符、patch 写错） |
| 日常使用受连累 | `.credentials.yaml` / `settings.yaml` / `sessions/` 被写坏 |

根子在**共用一份主目录**。解决办法是给开发单独一份。

---

## 二、隔离靠什么：`DSH_HOME`（不是 `--profile`）

dsh 的路径解析优先级是：

```
显式配置  >  $DSH_HOME  >  ~/.dsh
```

（见 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()`）

| 手段 | 隔离了什么 | 够不够 |
|---|---|---|
| `dsh --profile dev` | **只隔离插件树**（各自的 `profiles/<name>/node_modules`） | ✗ `.credentials.yaml`、`settings.yaml`、`sessions/` **仍然共享** |
| `DSH_HOME=<另一个目录>` | **整个主目录**：profile + 插件 + 凭据 + 设置 + 会话 | ✓ 要的是这个 |

`DSH_HOME` 是 **bootstrap-only** 的：它由**进程环境变量**读取，只要在启动那个
进程时设好就生效，不写全局。所以你的日常 `dsh web` 永远走生产，不会被带偏。

### 两套环境的对照

| | 生产（日常用） | 开发（调插件用） |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | `~/.dsh-dev` |
| profile | `web` | `dev` |
| 端口 | 3080 | **3090** |
| 插件树 | 完整业务插件 | 干净的 `base` + `web-app` 骨架 |
| 凭据 / 设置 / 会话 | 自己的 | **独立副本** |

两套**可以同时跑**（端口不同）。

---

## 三、新设备上的完整流程

### 0) 前置

按 [`README-安装说明.md`](README-安装说明.md) 把 dsh 本身装好：

```bash
npm i -g @deepseek-ai/dsh@0.1.6-alpha.1    # ★ 必须带版本，否则会静默降级
dsh --version                              # 期望 0.1.6-alpha.1
```

### 1) clone 本仓库

```bash
git clone https://github.com/HaydenSmith1121/dsh-plugins.git
cd dsh-plugins
```

> 放在**持久路径**即可。本仓库的脚本不依赖任何绝对路径，放哪都行。

### 2) 创建隔离环境

```bash
node scripts/dev-env.mjs init
```

它会：

- 在 `~/.dsh-dev` 建一套独立的 harness 主目录
- 用出厂模板建一个名为 `dev` 的 profile（默认从 `web` 模板复制）
- 把生产的 `.credentials.yaml` / `settings.yaml` **复制成独立副本**

> `~` 由 Node 的 `os.homedir()` 解析，**Windows / macOS / Linux 通吃**。
> 要换位置用 `--home <path>`。

### 3) 装依赖（只需一次）

```bash
cd ~/.dsh-dev/profiles/dev
pnpm install
```

> 这一步不能省。省了的话插件树无法加载。

### 4) 启动

```bash
cd <仓库目录>
node scripts/dev-env.mjs web
```

浏览器打开 `http://127.0.0.1:3090`。你的生产环境（3080）**完全不受影响**。

---

## 四、日常怎么用

### 装/更新正在开发的插件

```bash
node scripts/dev-env.mjs install /path/to/my-plugin.tgz
```

只影响隔离环境。

> ⚠️ **`file:` 依赖会锚定 tarball 的绝对路径**。所以那个 tarball 不能删、不能挪，
> 否则以后 `pnpm install` 会挂。建议把开发产物放在仓库外的固定目录
> （如 `~/dsh-dev-builds/`），别放 `/tmp`。

### 看隔离环境的插件列表 / 装配树

```bash
node scripts/dev-env.mjs list
node scripts/dev-env.mjs config
```

### 对比两个环境

```bash
node scripts/dev-env.mjs status
```

会打印两套环境的 home / profile / 端口 / 插件数 / 凭据状态，
并且**自动揪出混进生产 profile 的开发类产物**（见下节）。

### 不想用包装脚本，直接敲 dsh

```bash
# 打印当前会话可用的环境变量
node scripts/dev-env.mjs shell
```

按提示设好后，普通 dsh 命令就落在隔离环境里（**只对当前会话生效**）：

```powershell
$env:DSH_HOME = "~\.dsh-dev"     # PowerShell
dsh --profile dev web --port 3090
```

```bash
export DSH_HOME=~/.dsh-dev       # bash / zsh
dsh --profile dev web --port 3090
```

---

## 五、自检：隔离到底成不成立

```bash
node scripts/dev-env.mjs doctor
```

逐条检查（全部通过才算隔离成立）：

| 检查项 | 含义 |
|---|---|
| 隔离 home ≠ 生产 home | 两个目录不同 |
| 隔离 profile 已初始化 | `profiles/dev/package.json` 存在 |
| 插件树独立 | 不是生产的软链 |
| 凭据是独立副本 | 比对 inode，确认不是硬链 |
| 端口不同 | 默认 3090 vs 3080 |
| `~` 解析正确 | 路径展开无误 |
| **生产 profile 无开发类产物** | 见下节 |

---

## 六、★ 最常见的坑：开发产物混进生产 profile

**症状**：一开发插件，日常在用的 harness 就断 / 起不来。

**原因**：开发中的 tarball 被直接装进了生产 profile：

```jsonc
// ~/.dsh/profiles/web/package.json
"dependencies": {
  "dsh-opencode-go-plus": "file:D:/deepseek/_probe/pack-plus/....tgz"   // ← 探测目录里的开发件
}
```

`_probe/`、`pack-*`、临时构建目录这类路径都是**开发件**的特征。

**怎么发现**：

```bash
node scripts/dev-env.mjs status     # 会直接列出来
grep -oE '"file:[^"]*"' ~/.dsh/profiles/web/package.json   # 手动查
```

还要一并查 patch 层（开发探针也常挂在这里）：

```bash
cat ~/.dsh/profiles/web/cordis.patch.yml
```

**怎么处理**：把开发件从生产 profile 卸掉，改装到隔离环境：

```bash
# 1) 从生产卸下
dsh plugin --profile web remove <包名>

# 2) 装进隔离环境
node scripts/dev-env.mjs install /path/to/that-plugin.tgz
```

> 另外注意**同族插件不要同时加载**（例如原版与 plus 版并存），
> 它们可能争抢同一个 provider / adapter id。开发版应该放在隔离环境里替着跑。

---

## 七、平台说明

### 三个薄壳入口

| 平台 | 入口 |
|---|---|
| 任意平台（Node 直接跑） | `node scripts/dev-env.mjs <命令>` |
| macOS / Linux / Git Bash | `./scripts/dev-env.sh <命令>` |
| Windows PowerShell | `.\scripts\dev-env.ps1 <命令>` |
| Windows cmd | `scripts\dev-env.cmd <命令>` |

逻辑只有一份（`dev-env.mjs`），薄壳只负责「找到 node 并转发」——
这样三个平台不会行为漂移。

### 为什么脚本里没有任何硬编码盘符

可移植性的关键点，换设备才不用改脚本：

| 项 | 怎么取的 |
|---|---|
| 隔离 home | `os.homedir()` + `.dsh-dev`，可用 `--home` 覆盖 |
| 生产 home | `$DSH_HOME`（非空）→ 否则 `os.homedir()/.dsh` |
| `dsh` 可执行文件 | 从 `PATH` 里找（Windows 自动补 `PATHEXT`） |
| 路径分隔符 | 一律用 `node:path`，不手写 `/` 或 `\` |
| `~` 展开 | 与 dsh 自身的 `expandHomePath` 行为对齐 |

### Git Bash / MSYS 注意

Git Bash 下 `pwd` 返回 POSIX 路径（`/d/foo`），而 `node` 是原生程序，
会误解析成 `D:\d\foo`。`dev-env.sh` 里已用 `cygpath` 处理（有则转换）。
自己写包装时要留意同一问题。

### PowerShell 执行策略

报「禁止运行脚本」时用 `.cmd` 入口，它会以 Bypass 策略拉起 `.ps1`。

> `.ps1` 文件必须带 **UTF-8 BOM**，否则 PowerShell 5.1 按 ANSI 解析 → 中文乱码。
> 本仓库的 `.ps1` 都已加（前 3 字节 `ef bb bf`）。

---

## 八、清理 / 回滚

隔离环境是**纯新增**的，删掉它对生产毫无影响：

```bash
# 先确认你在删哪个
node scripts/dev-env.mjs status

# Windows PowerShell
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh-dev"

# macOS / Linux
rm -rf ~/.dsh-dev
```

**不要**删 `~/.dsh` —— 那是生产环境（含凭据与会话）。

---

## 九、命令速查

```bash
node scripts/dev-env.mjs init                 # 创建隔离环境（幂等）
node scripts/dev-env.mjs status               # 两环境对比（默认命令）
node scripts/dev-env.mjs doctor               # 自检隔离是否成立
node scripts/dev-env.mjs web                  # 启动隔离环境
node scripts/dev-env.mjs install <tgz...>     # 往隔离环境装插件
node scripts/dev-env.mjs list                 # 隔离环境的插件列表
node scripts/dev-env.mjs config               # 隔离环境的装配树
node scripts/dev-env.mjs shell                # 打印隔离环境变量
node scripts/dev-env.mjs help                 # 完整帮助

# 常用选项
--home <path>       隔离 home（默认 ~/.dsh-dev）
--profile <name>    隔离 profile 名（默认 dev）
--port <n>          隔离端口（默认 3090）
--from <name>       出厂模板（默认 web）
--json              机器可读输出
```

退出码：`0` 成功 · `1` 用法错误 · `2` 环境不满足 · `3` 执行出错。
