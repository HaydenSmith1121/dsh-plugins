# dsh-memory — 实测记录

本文件记录的是**分发版**（tarball）在真实 harness 上的实测，不是源码仓库里的
设计意图。复现步骤见文末。

## 一、环境

| 项 | 值 |
|---|---|
| dsh | `0.1.6-alpha.1`（= `compatibility.json` 的 supported 运行时） |
| Node | `24.14.0` |
| pnpm | `12.4.2` |
| OS | Windows |
| 隔离 home | `C:\Users\Administrator\.dsh-memory-lab`（`node scripts/dev-env.mjs init --home … --port 3091`） |
| 隔离端口 | `3091`（生产 `3080` 全程未参与） |

隔离环境里还装了 `dsh-opencode-go-plus@0.2.1`，用途只有一个：让
`agent-default-model`（`opencode-go` / `deepseek-v4.1-flash`）能解析出真实路由。
蒸馏本身走的是标准 `ctx.llm.stream()`，不依赖任何特定 provider。

---

## 二、四步校验

仓库的 `scripts/verify.mjs` 第 ② 步会拿 `compatibility.json` 的**全量**插件清单
比对，因此在只有两个插件的隔离 profile 上不适用。四步按同样的分层单独跑了一遍：

### ① 版本

```console
$ dsh --version
0.1.6-alpha.1
```

受支持版本，无需降级或升级。

### ② 依赖层

```console
$ DSH_HOME=…\.dsh-memory-lab dsh plugin --profile web list
dsh-profile-web C:\Users\Administrator\.dsh-memory-lab\profiles\web (PRIVATE)
│   dependencies:
├── dsh-memory@0.1.0
└── dsh-opencode-go-plus@0.2.1
2 packages
```

`dsh.profile.bundles` 已被 dsh 追加（说明 `dsh.bundle.patch` 声明被正确识别）：

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
 "dsh-opencode-go-plus", "dsh-memory"]
```

### ③ 装配层

```console
$ DSH_HOME=… dsh --profile web --dump-config | grep '^# == ' | tail -3
# == @deepseek-ai/dsh-web-app
# == dsh-opencode-go-plus
# == dsh-memory
```

`--dump-config` 只打配置树、不 import 任何模块，所以这一步只证明**行被挂上**了。

### ④ 真实启动

```console
$ DSH_HOME=… dsh web --port 3091 --no-open
dsh web: http://127.0.0.1:3091/?token=…
```

零 `plugin tree failed to load` / `does not provide an export` / `SyntaxError`。

**插件确实激活了**，而不只是被装配：`apply()` 会创建记忆根目录。

```console
$ ls …\.dsh-memory-lab\memory
journal  workspaces
```

---

## 三、冒烟测试

```console
$ node test/smoke.mjs
  ✓ dsh-memory smoke test passed
```

覆盖：提示段注册（name / order=850）、召回为空时不注入、合成消息被过滤、
蒸馏落盘（全局 / 工作区 / journal）、工作区键 `<slug>-<hash8>` 格式、
喂给模型的正文不含召回段本身、重复条目不重复追加。

---

## 四、端到端（headless，同一隔离 home）

用 `dsh --profile headless "<task>"`，因为在它上面能确定性地观察「turn 关闭前
记忆是否已落盘」——这正是选 `agent/turn-stopping`（serial，会被 await）而不是
空闲防抖的原因。

### 4.1 闸门：短轮次零写入

先跑一个一轮就结束的短任务（默认 `MIN_CHARS=600`、`MIN_INTERVAL_MS=60000`）：

```console
$ cd D:\deepseek\_probe\memory-e2e
$ dsh --profile headless "Reply with exactly this token and nothing else: ROUTE-OK-1234"
ROUTE-OK-1234

$ ls …\memory  →  只有 journal/ 与 workspaces/ 两个空目录，无任何记忆文件
```

**结论**：闸门生效，普通短轮次不产生蒸馏开销。这同时也证明了模型路由在该
隔离环境里可用（否则这个任务根本答不出来）。

### 4.2 蒸馏：落盘

```console
$ DSH_MEMORY_MIN_CHARS=1 DSH_MEMORY_MIN_INTERVAL_MS=0 \
  dsh --profile headless "请记住这些关于我的长期设定：我叫老张，习惯用中文交流；我所有项目都用 pnpm 不用 npm；我偏好极简风格的代码，不喜欢过度抽象；我的机器是 Windows，shell 用 PowerShell 而不是 bash；我讨厌在提交信息里写 emoji。请用一句话确认。"
收到，老张：你习惯用中文、所有项目用 pnpm、偏好极简不喜过度抽象、机器是 Windows + PowerShell、提交信息里不写 emoji——这些长期设定我记住了。
```

`memory/MEMORY.md` 内容：

```markdown
# Memory

<!-- Maintained by dsh-memory. Safe to hand-edit: entries are plain lines, and
     duplicates are skipped on append. Oldest entries are dropped past the size cap. -->

- 2026-09-17 16:54 · 用户叫老张，习惯用中文交流。
- 2026-09-17 16:54 · 老张所有项目都用 pnpm，不用 npm。
- 2026-09-17 16:54 · 老张偏好极简风格的代码，不喜欢过度抽象。
- 2026-09-17 16:54 · 老张的机器是 Windows，shell 用 PowerShell 而不是 bash。
- 2026-09-17 16:54 · 老张讨厌在提交信息里写 emoji。
```

**结论**：`agent/turn-stopping` 确实被 await 了（进程在 turn 关闭后才退出，
记忆已经落盘）；`llm.stream` 的 option 形状被接受；模型回复裹了 ``` 代码块，
解析仍正确。模型把 5 条都判成了 global、`workspace` 与 `summary` 为空数组 /
空串，因此没有生成工作区文件和 journal 段落 —— 这是空返回时的正确行为
（不写空文件），不是缺陷。

### 4.3 召回：全局，跨工作区

换一个**全新目录**（`memory-e2e-2`，内存中不存在任何工作区记忆）：

```console
$ cd D:\deepseek\_probe\memory-e2e-2
$ dsh --profile headless "我叫什么？我的项目用什么包管理器？我的 shell 是什么？请直接回答，不要解释。"
```

模型 reasoning 原文：

```none
From memory: 老张, pnpm, PowerShell.
```

**结论**：作用域提示段确实进入了模型上下文，且全局记忆与工作区无关。

### 4.4 反向验证：工作区隔离

只往 `memory-e2e` 的工作区文件里塞一个独有暗号：

```console
$ …\memory\workspaces\memory-e2e-db9f62a8\MEMORY.md
- 2026-09-17 16:55 · 本项目的工作区暗号是 ZEBRA-7741。
```

同一个 prompt，两个目录：

| cwd | 回答 |
|---|---|
| `memory-e2e`（有暗号） | `ZEBRA-7741` |
| `memory-e2e-3`（全新目录） | `UNKNOWN` |

在 `memory-e2e-3` 里模型的 reasoning 明确说「the memory system gave me notes —
none contain a passphrase」，然后才答 `UNKNOWN`。

**结论**：这是本次最有价值的一条 —— 同一个 prompt、不同 cwd、不同答案，
说明 4.3 的召回**确实是提示段带来的，不是模型顺着问句编的**。工作区桶之间
也确实互不可见。

---

## 五、复现步骤

```bash
# 1) 隔离环境（不碰生产 ~/.dsh）
node scripts/dev-env.mjs init --home ~/.dsh-memory-lab --port 3091

# 2) 装本包（另需一个能用的模型路由，见第一节）
dsh plugin --profile web  add <tarball>     # DSH_HOME 指向隔离 home
dsh plugin --profile headless add <tarball>

# 3) 冒烟
node test/smoke.mjs

# 4) 真实启动
DSH_HOME=~/.dsh-memory-lab dsh web --port 3091 --no-open

# 5) 端到端见第四节；跑完删掉隔离 home 即可，生产毫无影响
```

> ⚠️ 往**全新** `--home` 跑 `dev-env.mjs init` 会在复制凭据那一步崩
> （`ENOENT … copyFileSync`）：`devProfile === templateName === 'web'` 时脚本
> 跳过了 profile 初始化步骤，于是 `devHome` 目录自始至终没人创建。先
> `mkdir` 那个 home 再 `init` 即可。这是 `scripts/dev-env.mjs` 的一个
> 未修 bug，与本插件无关。

---

## 六、未覆盖的部分

- **空闲防抖**：0.1.0 没有这条路径（见 README 第六节）。
- **工具与斜杠命令**：本版不提供。
- **长时间运行的 Web 会话**：端到端跑的是 headless；Web 剖面只验证到
  「真实启动 + `apply()` 激活」为止，没有在浏览器里驱动多轮对话。
- **`memory/` 体积增长到上限后的裁剪**：只在冒烟测试里以逻辑覆盖，
  没有做几千条量级的实测。
