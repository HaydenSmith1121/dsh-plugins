# 收录规范（Collection Specification）

> **规范性文档。** 本文件定义 `collection/` 目录的**强制**收录规则。
> 与本文冲突的做法一律不予合入；确有必要例外时，必须在 PR 里写明理由并由维护者批准。
>
> 范围：**只约束 `collection/`**。自研插件的开发与 `plugins/` 目录规范见
> [`CONTRIBUTING.md`](../CONTRIBUTING.md)。

---

## 一、这份规范解决什么问题

插件市场安装的是「**收录当时那一版**」的 tarball。上游一旦发布新版，会连带发生这些事：

| 上游发生的动作 | 对用户的后果 |
|---|---|
| 撤回旧版本（unpublish） | 老用户重装时装不回来 |
| 用同一版本号重新发布不同内容 | 装到的东西和当初验证过的不是同一份 |
| 收紧 `peerDependencies` | 原本可用的 dsh 版本突然装不上 |
| 改动包结构（挪 `lib/`、去掉 `cordis.patch.yml`） | 装上了但 GUI 里没有 |

这些都不是用户能预判的。**收录快照的存在，就是让「当时验证过的那一份」永久可复现**，
不再取决于上游此刻发布了什么。

因此本规范的第一原则是：

> ### ★ 收录的是「验证过的那个字节」，不是「上游的最新版」。

---

## 二、目录结构（强制）

```none
collection/
├─ README.md                  # 收录介绍：面向用户的说明
├─ SPEC.md                    # 本文件：面向贡献者的规范
├─ manifest.json              # 机器可读清单，由 generate 生成，禁止手写
├─ collection-notes.json      # 唯一人工维护的文件：版本核实结论与收录理由
└─ snapshots/
   └─ <目录名>/               # 包名去掉 scope，如 @dsh-market/plugin → dsh-market-plugin
      └─ <插件版本>/          # ★ 插件版本，不是 dsh 版本（与 plugins/ 的约定相反，见下）
         └─ <包名>-<版本>.tgz
```

### 2.1 与 `plugins/` 的分层规则

两个目录的**版本层含义不同**，这是刻意的：

| 目录 | 版本层 | 含义 | 谁的内容 |
|---|---|---|---|
| `plugins/<目录名>/<dsh 版本>/` | dsh 运行时版本 | 这套包适配哪个 dsh | **自研**插件（工作副本） |
| `collection/snapshots/<目录名>/<插件版本>/` | **插件版本** | 收录的是哪个插件版本 | 自研 + 第三方（**不可变快照**） |

> `plugins/` 的那一层答的是「该装哪一套」；
> `collection/` 的这一层答的是「当时收录的是哪一版」。
> 两者的变更频率和不可变性完全不同，因此不合并。

### 2.2 目录名与文件名（强制）

- **`<目录名>`** = 包名去掉 scope。`@dsh-market/plugin` → `dsh-market-plugin`
- **`<插件版本>`** = 包内 `package.json` 的 `version`，**原样照抄**，不做任何规范化
- **tarball 文件名** = `npm pack` 的默认产物名，scope 里的 `/` 换成 `-`

### 2.3 不可变性（强制）

已收录的快照目录 **一律不得修改、覆盖或删除**：

- ❌ 不要用新版覆盖旧版的同版本目录
- ❌ 不要「原地更新」一个已收录的 tarball
- ✅ 上游发新版 → **新增**一个版本目录，旧目录原样保留

> 快照被改动就意味着 sha256 失效，而 sha256 正是「装回来的还是当初那一份」的
> 唯一保证。改快照等于把这条保证作废。

### 2.4 自引用产物的例外（`dsh-plugins-market`）

引导插件 `dsh-plugins-market` 的 tarball **就是本仓库的构建产物**：每次
`node plugins-src/dsh-plugins-market/build.mjs` 都会重新生成它，sha256 随之变化。

因此它的快照**不是**「永远冻结」的，而是「**随构建同步刷新**」：

- 重新构建市场之后，**必须**重新运行 `node scripts/build-collection.mjs`
- 刷新前请确认该快照**尚未提交**，或在 PR 里说明为什么刷新它
- 其余所有插件**没有这个例外** —— 它们的快照一律不可变

> 生成脚本会在 sha256 对不上时直接报错并给出明确提示，不会静默覆盖。
> 这是刻意的：**刷新自引用快照必须是一个有意识的动作**，不能悄悄发生。

---

## 三、收录流程（强制）

### 第 1 步：确认真实来源

按可信度依次核实，**不要跳过第 2 条**：

1. 包内 `package.json` 的 `author` / `repository`
2. **包内 `README.md` / `LICENSE` / `NOTICE` 声明的上游**
3. npm 包页面：`npm view <包名> repository homepage author`
4. 都查不到 → 标注「**未注明**」，并在 `collection-notes.json` 里写明核实过哪些地方

> **真实案例**：`@dsh-market/plugin` 的 `package.json` 没有 `author` 和 `repository`，
> 一度被误标为自研。真实上游是在它包内 `README.md` 里找到的。
> 第 2 条是必须走的。

**硬性要求**：以下四项信息**必须齐全**，缺一不予收录。

| 字段 | 要求 |
|---|---|
| 版本号 | 包内 `package.json` 的实际版本，禁止凭印象填 |
| 作者 | 查不到写「未注明」，**不要留空、不要猜** |
| 上游仓库 | 第三方必须有 URL；确实无法定位写「无法定位」并说明核实过程 |
| 许可 | 按 `package.json` 的 `license`；没有就写「未声明」 |

**许可准入**：只收录**明确允许再分发**的许可（MIT / Apache-2.0 / BSD 等）。
无许可声明或明确禁止再分发的，**不予收录**。

### 第 2 步：真机验证

**静态探测替代不了这一步。**

```bash
# 在隔离环境（~/.dsh-dev）里真实装一次并启动
node scripts/dev-env.mjs install <tarball 绝对路径>
node scripts/dev-env.mjs web
```

必须记录：

- dsh / node / pnpm 版本
- tarball 路径与 sha256
- 启动输出里的关键行（有无 `plugin tree failed to load` / `does not provide an export`）
- peer 约束是否与本仓库基线兼容
- 有无副作用（写全局配置、起后台进程、需要联网 / 登录 / API Key）

### 第 3 步：登记（四处，缺一处即视为未完成）

#### ① 放进 `collection/snapshots/`

```bash
dir=<目录名>            # 包名去掉 scope
ver=<插件版本>          # 包内 package.json 的 version
mkdir -p "collection/snapshots/$dir/$ver"
cp "$tgz" "collection/snapshots/$dir/$ver/"
```

#### ② 登记进 `compatibility.json`

在对应 runtime 的 `plugins` 数组里**按 bundle 顺序**插入一项。字段含义见
[`CONTRIBUTING.md`](../CONTRIBUTING.md) 第四节。

#### ③ 写 `collection/collection-notes.json`

这是**唯一需要人工维护**的文件，必须填写：

```json
{
  "<包名>": {
    "isLatest": false,
    "latestKnown": "<你实际查到的最新版号>",
    "latestCheckedAt": "YYYY-MM-DD",
    "note": "<收录理由 / 注意事项；来源存疑时说明核实过程>"
  }
}
```

- `isLatest` / `latestKnown` / `latestCheckedAt` 三项**必须真的查过**才能填
- **没查就留 `null`** —— 文档与界面会显示「未核实」
- ❌ **禁止凭印象填 `true`** —— 那会让「收录的不一定是最新版本」这条提示失去意义

#### ④ 重新生成 manifest

```bash
node scripts/build-collection.mjs
```

> `manifest.json` **由脚本从事实反推生成，禁止手写。**
> 脚本会读 `compatibility.json` + 各 tarball 的 `package.json` + 实际字节，
> 算出 sha256 并逐个核对。手写清单会和事实脱节，脚本生成的不会。

### 第 4 步：提交前自检

```bash
node scripts/build-collection.mjs --check   # 必须通过
```

> **改了市场源码的话**（`plugins-src/dsh-plugins-market/`）：
> 市场 tarball 会被重新构建，此时需按 [2.4](#24-自引用产物的例外dsh-plugins-market) 刷新它自己的快照：
>
> ```bash
> node plugins-src/dsh-plugins-market/build.mjs   # 重建市场 tarball
> node scripts/build-collection.mjs               # 同步刷新自引用快照
> node scripts/build-collection.mjs --check
> ```

---

## 四、强制字段清单

`manifest.json` 里每条记录的字段（脚本自动生成，此处列出以便核对）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `package` / `version` | 包内 `package.json` | 与清单交叉核对，不一致即报错 |
| `author` | `compatibility.json` → 包内 → 人工标注 | 三级回退 |
| `authorSource` | 自动判定 | 标明作者信息来自哪一级，便于审计 |
| `upstream` | `compatibility.json` → `repository` | 上游仓库 URL |
| `license` / `licenseFileInTarball` | `package.json` / 实际扫描 | 许可与正文是否随包分发 |
| **`sha256`** | **实际字节计算** | ★ 快照完整性的唯一依据 |
| `bytes` / `fileCount` | 实际计算 | 体积与文件数 |
| `runtimeVersion` | `compatibility.json` | 收录时对应的 dsh 基线 |
| `peerRuntimePin` / `peerVerdict` | `compatibility.json` | peer 约束与实测结论 |
| `isLatest` / `latestKnown` / `latestCheckedAt` | **人工核实** | 未核实为 `null` |
| `collectedFile` / `sourcePath` | 自动生成 | 快照路径 / 原始路径 |

---

## 五、对「收录的不一定是最新版本」的解释

这是本仓库的**设计意图**，不是缺陷，所以必须在面向用户的文档里说明白：

- **收录标准**是「在真机上验证过、装得上、跑得起来」，**不是「追平上游」**
- 上游最新版可能改了 peer 约束、改了包结构，**反而装不上**
- 旧快照的价值恰恰在于：等上游发新版之后，**这一版还能原样装回去**
- 需要最新版时：先按第 2 步真机验证，再**新增**一套快照，**不覆盖旧版**

因此 `collection/README.md` **必须**显式写出这条声明，且不得只用小字脚注带过。

---

## 六、PR 检查清单（强制）

提交前逐项确认：

- [ ] 快照放在 `collection/snapshots/<目录名>/<插件版本>/<包名>-<版本>.tgz`
- [ ] 目录名、文件名符合 [2.2](#22-目录名与文件名强制) 规则
- [ ] **未修改、未覆盖、未删除任何已收录的快照**
- [ ] **版本号 / 作者 / 上游仓库 / 许可**四项信息齐全（查不到已如实标注）
- [ ] 许可明确允许再分发
- [ ] 已在隔离环境真机装过并启动成功，证据已记录
- [ ] `compatibility.json` 已更新，且 `bundles` 顺序与 `plugins` 顺序自洽
- [ ] `collection-notes.json` 已填写；`isLatest` 等三项**真的查过**，没查则留 `null`
- [ ] `node scripts/build-collection.mjs` 已重新运行
- [ ] `node scripts/build-collection.mjs --check` 通过
- [ ] `node scripts/verify.mjs` 四步全绿
- [ ] commit message 说明收录了什么、版本号、以及为什么收这一版

---

## 七、本规范自身的变更

修改本文件属于**规范变更**，需要：

1. 在 PR 描述里说明动机与实际踩到的坑
2. 同步检查 `collection/README.md` 是否仍然准确
3. 若是收紧规则，检查存量快照是否需要补齐信息
4. 同步检查 [`docs/收录说明.md`](../docs/收录说明.md)（面向用户的收录说明）是否需要跟着改
