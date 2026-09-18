# 贡献指南

本仓库是 **dsh 插件的市场**：目录（`catalog/`）、安装入口（市场面板插件 + 引导脚本）、
以及让目录保持新鲜的每日采集。**插件的字节在另一个仓库** ——
[`HaydenSmith1121/dsh-plugin-collection`](https://github.com/HaydenSmith1121/dsh-plugin-collection)。

因此这里的「贡献」比一般开源项目宽得多 —— **你不需要从零写一个插件也能帮上忙。**

| 优先级 | 类型 | 说明 |
|---|---|---|
| ★★★ | **补齐新 dsh 版本的适配结论** | dsh 迭代很快，仓库最容易过时的地方就是这里。见[第五节](#add-runtime) |
| ★★ | **修正采集结果与兼容信息** | 某个配置文件的版本 / star / 安装方法不对，或 `compatibility.json`、版本矩阵有错 |
| ★★ | **给第三方插件补一份实测记录** | 真机装一次、留下证据。见[第四节 B](#review-flow) |
| ★ | **改进采集脚本、市场面板与文档** | `scripts/sync-catalog.mjs`、`plugins-src/dsh-plugins-market/`、`docs/` |

**没把握就先开 Issue 问，不要卡在自己猜。**
发现上游插件的新版本、新 dsh 版本发布，也欢迎直接开 Issue 告知。

---

<a name="install-mode"></a>

## 〇、安装方式与它带来的三条规矩

一键安装脚本（`scripts/install.ps1` / `install.sh`，Windows 还可用 `scripts/install.cmd`
绕开执行策略）远程一条命令即可跑完，用户不需要先 clone：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main/scripts/install.ps1).TrimStart([char]0xFEFF)))
```

```bash
curl -fsSL https://raw.githubusercontent.com/HaydenSmith1121/dsh-plugins/main/scripts/install.sh | sh
```

**脚本只装一个插件：引导插件 `dsh-plugins-market`（市场面板本身）。**
「一键装全套」这条路自 0.4.0 起已经没有了 —— 插件的字节不在本仓库，装哪个插件、怎么装
是市场面板的职责（自动安装失败自动回滚，手动安装随时可选）。
`-BootstrapOnly` / `--bootstrap-only` 仍然接受，含义与默认行为一致。

由此有三条规矩：

1. **要进本仓库的插件产物只有一个：市场插件自己**（`plugins/dsh-plugins-market/<dsh 版本>/`）。
   其余插件请提到集合仓库，见[第四节 A](#add-plugin)。
2. **`catalog/plugins/*.json` 与 `catalog/index.json` 是生成物，不要手写**：
   `node scripts/sync-catalog.mjs` 生成，CI 的 `--check` 逐字节比对。
3. **只有 `catalog/overrides/*.json` 需要人写**：`curated.json`（人工核对过的第三方条目）
   与 `self.json`（市场插件自己那一行）。

**目录不分级**（0.5.0 起）—— 曾经有三个信任层级（`verified` / `reviewed` / `community`），
现在是**一份平铺列表**，每条记录按**来源**决定优先级：

| 来源 `source.kind` | 谁维护 | 怎么进目录 |
|---|---|---|
| `self` | 本仓库 | 市场插件自己那一行；版本与 sha256 从源码 / 构建产物反推。改 `catalog/overrides/self.json` |
| `collection` | 插件集合仓库 | 那边放 tarball + 改 `plugins/<id>/plugin.json` + `node scripts/build-manifest.mjs`；本仓库下一轮每日采集自动跟随 |
| `manual` | 维护者人工核对 | 跑 `node scripts/market-review.mjs <owner/repo>` 产出草稿 → 真机验证 → 写进 `catalog/overrides/curated.json` → `node scripts/sync-catalog.mjs`。见[第四节 B](#review-flow) |
| `public-index` | 公开索引自动同步 | 无需贡献；由采集脚本写入 |

> 为什么要去掉分级、以及现在怎么决定「装不装」，见
> [README 的「不分级的目录」](./README.md#tiers)。一句话：市场不判定任何插件能不能装
> （0.6.0 起所有插件都可装），它只把知道的事实列出来，自动还是手动由用户在安装方案页自己选。

---

<a name="requirements"></a>

## 一、插件的准入要求

以下 4 条适用于**任何要进目录的插件**。每一条都对应一个实际踩过的坑。
其中第 1、2、4 条也是市场静态探测会列出来的**事实**（没声明 `dsh.bundle.patch`、声明了
patch 却没有那个文件、peer 精确 pin 到比本机更新的版本……）—— 但它们是安装前的提示，
不拦安装：0.6.0 起市场不判定任何插件能不能装。静态探测也代替不了第 3 条 ——
**它不启动 harness**，真实启动只能在真机上跑。

### 1. 包内必须声明 `dsh.bundle`

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

这是 dsh 识别插件的依据。没有它，`dsh plugin add` 会装进 `node_modules`
但**不会把包追加进 `dsh.profile.bundles`** —— 表现就是「装上了但 GUI 里没有」。
同时 `cordis.patch.yml` 文件必须真实存在并被打进 tarball（声明了却没有这个文件，装上后启动会失败；
市场会在安装前把这条列成提示，但不拦你）。

### 2. 必须说明适配的 dsh 版本范围

必须给出 `peerDependencies` 里对 `@deepseek-ai/*` 的约束。这是判断
「这份产物适配哪个 dsh 版本」的**唯一依据**。

```json
"peerDependencies": {
  "@deepseek-ai/dsh-llm": "0.1.6-alpha.1"
}
```

> ⚠️ **精确 pin 和窄范围都要如实登记。** 精确 pin（如 `0.1.6-alpha.1`）意味着
> dsh 换版本就会崩；窄范围（如 `^0.1.5-rc.1`）可能只是 peer 警告。
> 两者对用户的影响完全不同，不能混为一谈。
>
> 特别注意 semver 的**预发布规则**：`^0.1.5-rc.1` 的上界是裸 `0.2.0`，
> 所以它**不包含** `0.1.6-alpha.1`；而 `>=0.1.5-0 <0.2.0-0` 两端都带 `-0`，
> 是**包含**预发布版的。别凭感觉判断，用 `pnpm peers check` 或实际装一遍验证。

### 3. 必须通过真实启动验证

**`--dump-config` 通过 ≠ 能启动。** `--dump-config` 只打配置树、不 import 任何模块，
所以「导出缺失」这类问题它完全查不出来。

```bash
node scripts/verify.mjs      # 四步校验，第 ④ 步会真实启动一次
```

要求：**四步全绿**，特别是第 ④ 步（真实启动）没有
`plugin tree failed to load` / `does not provide an export` / `SyntaxError`。

### 4. tarball 内必须含 `package.json` + `cordis.patch.yml` + `lib/`

且**不得包含** `node_modules/`、源码缓存、`.env`、凭据文件。

---

<a name="sources"></a>

## 二、来源标注义务 ★

**这是本仓库最看重的一条。** 我们记录别人的代码出处，就必须把出处写准。

每一条进入目录的插件，**必须**把这几项填清楚 —— 它们在
`catalog/plugins/<slug>.json`（生成物，由采集或覆盖层提供）里就是
`author` / `repo` / `license` / `source.url`：

| 字段 | 要求 |
|---|---|
| **来源** | 自研插件（集合仓库 `origin: self`）或第三方（覆盖层 / 公开索引），二选一 |
| **原作者** `author` | 第三方填作者名；查不到就写「**未注明**」，**不要留空、不要猜** |
| **上游仓库** `repo` | 第三方必须给出 URL；确实无法定位就写「**无法定位**」 |
| **许可** `license` | 按 `package.json` 的 `license` 字段填；没有就写「**未声明**」 |

对人工核对过的条目，来源与核实过程写进 `catalog/overrides/curated.json` 对应条目的
`evidence`（记**验证时的 commit**）与 `notes`。

### 怎么核实来源（按可信度排序）

1. `package.json` 的 `author` / `repository` 字段 —— 最权威
2. **包内 `README.md` / `LICENSE` / `NOTICE` 里声明的上游** —— 次之
3. npm 上的包页面（`npm view <包名> repository homepage author`）
4. 都查不到 → 按「未注明」登记，并在同一条目里**说明你核实过哪些地方**

> **真实案例**：`@dsh-market/plugin` 最初被标成了「自研」。
> 原因就是它的 `package.json` **没有** `author` 和 `repository` 字段。
> 后来在它的包内 `README.md` 里才找到了上游 `2BingLing/dsh-market`。
> —— 所以**第 2 条核实途径不能跳过**。

### 许可文件

第三方插件的 tarball 里应当保留 `LICENSE` 正文。入库时请一并检查：

```bash
tar -tzf <tarball> | grep -iE 'LICENSE|NOTICE|COPYING'
```

如果上游确实没有附许可文件，**如实登记，不要伪造**，并考虑提一个 PR 给上游补上。

---

<a name="naming"></a>

## 三、目录结构与命名

本仓库只剩市场插件一个产物：

```none
plugins/
└─ dsh-plugins-market/
   └─ <dsh 版本>/                       # ★ dsh 运行时版本，如 0.1.6-alpha.1
      ├─ dsh-plugins-market-<版本>.tgz
      └─ dsh-plugins-market-<版本>.tgz.sha256
```

其余插件沿用**同一套命名约定**，只是落在集合仓库里：

```none
plugins/<id>/<dsh 版本>/<包名>-<版本>.tgz      # 那一层是 dsh 运行时版本（该装哪一套）
snapshots/<id>/<插件版本>/<包名>-<版本>.tgz    # 那一层是插件版本（当时收录的是哪一版），不可变
```

规则：

- **`<id>` / `<目录名>`** = 包名去掉 scope。`@dsh-market/plugin` → `dsh-market-plugin`；
  `dsh-plugins-market` → `dsh-plugins-market`
- **`<dsh 版本>`** = 这套 tarball 适配的 **dsh 运行时版本**，不是插件版本。
  用的是 dsh 的完整版本串，含预发布号（`0.1.6-alpha.1`，不写 `0.1.6`）
- **tarball 文件名** = `npm pack` 的默认产物名，即 `<包名>-<版本>.tgz`，
  scope 里的 `/` 换成 `-`（`@dsh-market/plugin` → `dsh-market-plugin-0.4.8.tgz`）

> ⚠️ **两层的含义相反，别写错**：`plugins/` 下按 **dsh 版本**分层（答「该装哪一套」），
> `snapshots/` 下按**插件版本**分层（答「当时收录的是哪一版」）。
>
> **同一个插件可以、也应该有多个版本目录**：为适配不同 dsh 版本发布了不同构建产物时，
> 各放一处，互不影响；同一个插件的多个插件版本则各有一套快照，**新的不覆盖旧的**。

---

<a name="add-plugin"></a>

## 四、新增 / 更新插件

### A. 自研插件（在集合仓库做）

**本仓库不用动。** 那边的流程（详见集合仓库
[`README.md`](https://github.com/HaydenSmith1121/dsh-plugin-collection/blob/main/README.md)
与 [`docs/收录规范.md`](https://github.com/HaydenSmith1121/dsh-plugin-collection/blob/main/docs/收录规范.md)）：

1. 打包，并把 tarball 放到 `plugins/<id>/<dsh 版本>/` —— **绝不覆盖已发布的字节**
2. 改 `plugins/<id>/plugin.json`：`versions[]` 追加一条（版本 / dsh 版本 / tarball / sha256 /
   bytes / files / status / verifiedAt），上一条改成 `superseded` 并写清原因；
   顶层字段同步到最新那条
3. 新增一套快照 `snapshots/<id>/<插件版本>/`
4. `node scripts/build-manifest.mjs`（sha256 对不上会直接报错）
5. 提交。**本仓库下一轮每日采集会自动把版本与 sha256 跟过来**；想立刻生效就在本仓库跑一次
   `node scripts/sync-catalog.mjs`（或等 02:00 的定时任务）

打包后先自查：

```bash
tgz=<临时目录>/<包名>-<版本>.tgz
tar -tzf "$tgz" | grep -c 'package/lib/'         # > 0，确认 lib 进来了
tar -tzf "$tgz" | grep -c 'cordis.patch.yml'     # 应为 1
tar -tzf "$tgz" | grep -iE 'LICENSE|NOTICE'      # 第三方应有
tar -tzf "$tgz" | grep -E 'node_modules|\.env'   # 应为空
```

<a name="review-flow"></a>

### B. 第三方插件 → 补一份实测记录

**本仓库的职责就是这一条。** 门槛是「真机验证过 + 留下证据」，静态探测替代不了。

> ★ 它**不会**把插件提升成什么层级 —— 分级已经没有了。补的是一份**事实记录**：
> 干净的安装规格、peer 结论、当时怎么验的。这些东西公开索引里查不到。

```bash
# ① 探测候选包，产出一份草稿（别凭印象手写）
node scripts/market-review.mjs <owner/repo | npm 包名 | 插件 id>
node scripts/market-review.mjs <owner/repo | npm 包名 | 插件 id> --write   # 直接追加进 overrides/curated.json

# ② 在隔离环境真机装一次并启动（DSH_HOME=~/.dsh-dev，日常 3080 不受影响）
node scripts/dev-env.mjs install <tarball 或先 dsh plugin --profile web add <spec>>
node scripts/dev-env.mjs web
node scripts/dev-env.mjs doctor

# ③ 复核并补全草稿：notes / evidence / peer* 字段一个都不能留 null
#    （evidence 必须写清环境与判据 —— 「装上了」不算，要写退出码与装配树里的那一行）

# ④ 重新生成目录（必须！）
node scripts/sync-catalog.mjs

# ⑤ 提交前自检（CI 会跑同一件事）
node scripts/sync-catalog.mjs --check
```

核对一条的**最低要求（缺一不可）**、「不分发字节」的含义与结论怎么写，
见 [`docs/目录同步.md` §七](./docs/目录同步.md#add-reviewed) 与
`catalog/overrides/curated.json` 顶部的 `_comment`。

<a name="market-version"></a>

### C. 市场插件自己发新版

市场插件是本仓库唯一托管产物的插件，流程与别的插件**不同**（它的版本号、sha256 与目录条目
都从源码与产物**反推**，不手写）：

```bash
# ① 改源码后重新构建（会重打 tarball 到 plugins/dsh-plugins-market/<dsh 版本>/）
node plugins-src/dsh-plugins-market/build.mjs

# ② 重新生成目录（市场自己那一行由 catalog/overrides/self.json 声明，
#    版本号取自 plugins-src/dsh-plugins-market/package.json，sha256 由脚本实测 tarball）
node scripts/sync-catalog.mjs

# ③ 提交前自检
node scripts/sync-catalog.mjs --check
node plugins-src/dsh-plugins-market/build.mjs --check
cd plugins-src/dsh-plugins-market && node test/run.mjs
```

> **为什么必须先构建再采集**：`build.mjs` 是确定性的（同输入必得同字节），
> 而 `catalog/overrides/self.json` 只声明「版本从哪个 `package.json` 取、tarball 模板长什么样」。
> 只改源码不构建 → `plugins/` 下还是旧产物；只构建不采集 → 配置文件里还是旧版本号。
> `build.mjs` 自己也会校验 `catalog/index.json` 里市场那条的版本与源码一致，不一致直接报错。

---

<a name="add-runtime"></a>

## 五、新增一个 dsh 运行时版本

**这是最受欢迎的一类贡献。** 当 dsh 发布新版本时，需要补齐两件事：**产物**（集合仓库）
与**结论**（本仓库的 `compatibility.json`）。

### 步骤

1. **确认新版 dsh 的版本号与通道**

   ```bash
   npm view @deepseek-ai/dsh dist-tags
   ```

2. **安装该版本 dsh，实测现有插件是否可用**

   ```bash
   npm i -g @deepseek-ai/dsh@<新版本>
   node scripts/verify.mjs
   ```

3. **分情况处理**：

   - **现有 tarball 直接可用** → 在集合仓库新增一个 dsh 版本目录，把现有 tarball 复制过去
     （或软链接），并更新对应 `plugin.json`
   - **需要重新构建** → 拿到插件源码，按新版 dsh 的 peer 要求重新构建、重新打包，
     放进新的版本目录
   - **某个插件确实无法适配**（上游没有对应版本） → 明确记下来，让预检与安装前的提示把话说明白，
     而不是让用户装上一个会崩的组合

4. **在本仓库 `compatibility.json` 里新增 runtime 条目**（注意：**这里已经不再有
   `plugins` 数组**，逐插件事实在目录与集合仓库里）：

   ```json
   {
     "dshVersion": "<新版本>",
     "distTag": "<latest | next | alpha>",
     "status": "supported",
     "recommended": true,
     "verifiedAt": "<YYYY-MM-DD>",
     "verifiedOn": { "os": "...", "node": "...", "pnpm": "...", "result": "..." },
     "installCommand": "npm i -g @deepseek-ai/dsh@<新版本>",
     "bundles": [ "..." ]
   }
   ```

   同时把**上一个版本**的 `recommended` 改成 `false`。

5. **让目录跟上**：`node scripts/sync-catalog.mjs`（`dshVersion` 字段取自
   `compatibility.json` 里 status 为 `supported` 且 `recommended` 的那一条 runtime）

6. **更新文档里的版本矩阵**（[`docs/版本兼容矩阵.md`](./docs/版本兼容矩阵.md) 第三节、
   [`README-安装说明.md` 第三节](./README-安装说明.md#ch3)）

7. **如实填写 `verifiedOn`** —— 在什么机器、什么 Node/pnpm 版本上验证的，结果如何。
   **没实测过就不要写 supported**，宁可在 Issue 里讨论。

> ⚠️ **特别注意 npm 的 `latest` 通道**。`npm i -g @deepseek-ai/dsh` 不带版本
> 装的是 `latest`，它常常**落后于**插件要求的版本。更新时要一并检查
> `distTags` 是否变化，以及「静默降级」这个陷阱是否仍然存在。

---

<a name="checklist"></a>

## 六、PR 检查清单

提交前请逐项确认（按你改动的内容勾）：

**改了目录 / 覆盖层 / 采集脚本**

- [ ] `node scripts/sync-catalog.mjs` 已经跑过，生成物与源码一致
- [ ] `node scripts/sync-catalog.mjs --check` 通过
- [ ] `catalog/plugins/*.json` 与 `catalog/index.json` **没有手工编辑痕迹**
      （字段顺序、缩进、时间戳都由脚本决定）
- [ ] 新补的实测记录里 `curatedAt` 已填，`evidence` 说清了环境、装法与验证结论，
      `notes` 写清了结论（可用 / 可用但有注意事项 / 不可用）
- [ ] **第三方插件已标注原作者与上游仓库**；查不到就明确写「未注明」并说明核实过程
- [ ] 该插件确实走 `github:` / npm 规格安装 —— **本仓库不再分发第三方插件的字节**

**改了市场插件（`plugins-src/dsh-plugins-market/`）**

- [ ] `cd plugins-src/dsh-plugins-market && node test/run.mjs` 通过
- [ ] `node plugins-src/dsh-plugins-market/build.mjs` 已跑，产物已提交
      （CI 会再跑一次并 `git diff --quiet -- plugins/`，源码与产物不一致就红）
- [ ] `node plugins-src/dsh-plugins-market/build.mjs --check` 通过
- [ ] 改了源码版本号时，已重跑 `node scripts/sync-catalog.mjs`
      （`catalog/plugins/dsh-plugins-market.json` 的版本要与源码一致）

**改了运行时矩阵 / 文档**

- [ ] `compatibility.json` 合法、`bundles` 顺序与文档描述自洽
- [ ] `node scripts/verify.mjs` 四步全绿（含真实启动）
- [ ] 文档里的版本号、路径、命令**逐条对着代码核过**，没有指向已删除的文件
- [ ] commit message 说明改了什么、为什么

**跨仓库改动**（插件本体）

- [ ] 在集合仓库跑了 `node scripts/build-manifest.mjs`（`--check` 通过），
      新 tarball 未覆盖任何已发布字节，快照是**新增**而不是覆盖

---

<a name="license"></a>

## 七、许可

- 本仓库**自身的**代码与文档：MIT
- **第三方插件的版权归各自原作者所有。** 自 0.4.0（市场与插件分离）起，本仓库
  **不再分发**第三方插件的字节，也不重新打包自研插件：目录里只记录元数据与安装方法
- 给第三方插件补实测记录**不涉及再分发**（用户从上游装），但仍请确认该插件
  的许可允许它被这样索引与推荐；无许可声明或明确禁止分发的项目请不要提交
- 如你是某个插件的原作者，希望本仓库移除或调整收录方式，
  请开 Issue 或直接联系，我们会立即处理
