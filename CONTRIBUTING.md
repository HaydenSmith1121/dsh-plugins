# 贡献指南

本仓库是一个 **dsh 插件分发与兼容性仓库**，不是某个插件的源码仓库。
因此这里的「贡献」比一般开源项目宽得多 —— **你不需要从零写一个插件也能帮上忙。**

欢迎以下三类贡献，按当前最缺的程度排序：

| 优先级 | 类型 | 说明 |
|---|---|---|
| ★★★ | **补齐新 dsh 版本的适配包** | dsh 迭代很快，仓库最容易过时的地方就是这里。见[第五节](#五新增一个-dsh-运行时版本) |
| ★★ | **修正兼容性信息** | 发现 `compatibility.json`、版本矩阵或文档有错，直接改、直接提 |
| ★★ | **提交新插件** | 自研的或收集到的都可以。见[第四节](#四新增一个插件) |
| ★ | 改进脚本与文档 | `scripts/` 下的检测、安装、校验逻辑，或安装教程 |

**没有把握就先进 Issue 问，不要卡在自己猜。**
发现上游插件的新版本、新 dsh 版本发布，也欢迎直接开 Issue 告知。

---

## 〇、安装方式：只有插件市场这一条路

自 2026-09 起，本仓库的插件**一律通过 GUI 里的「插件市场」面板安装**
（`dsh-plugins-market`）。命令行只保留一条最小引导路径：装市场自己。

这对贡献者有两层含义：

1. **新增插件必须登记进 `compatibility.json` 的对应 runtime**，否则它不会出现在
   市场的「已验证」层里，用户也就装不到它 —— 光把 tarball 放进 `plugins/` 是不够的。
2. **`plugins/<包名>/<dsh 版本>/<tarball>` 是市场点装时真正读取的位置**，
   路径写错、tarball 缺失，市场会在装前检查里直接拦住（而不是装完才发现）。

三类目录与收录门槛：

| 层 | 谁维护 | 入库方式 |
|---|---|---|
| **已验证** | 本仓库 | 按[第四节](#四新增一个插件)入库 + 登记 `compatibility.json`，市场自动读取（含 sha256） |
| **已审核** | 维护者人工审核 | 跑 `node scripts/market-review.mjs <owner/repo>` 产出草稿，真机验证后写进 `catalog/curated.json`（含审核证据） |
| **未审核** | 公共索引自动同步 | 无需贡献；由市场在运行时拉取并强制提示风险 |

> 想让某个第三方插件从「未审核」升到「已审核」，见
> [`catalog/curated.json`](./catalog/curated.json) 顶部的收录标准 ——
> 核心是**必须在真机上装一次并启动成功**，静态探测替代不了这一步。

---

## 一、插件入库的最低要求

一个插件要进本仓库，必须**同时**满足以下 4 条。
这不是形式主义 —— 每一条都对应一个实际踩过的坑。

### 1. 包内必须声明 `dsh.bundle`

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

这是 dsh 识别插件的依据。没有它，`dsh plugin add` 会装进 `node_modules`
但**不会把包追加进 `dsh.profile.bundles`** —— 表现就是「装上了但 GUI 里没有」。

同时 `cordis.patch.yml` 文件必须真实存在并被打进 tarball。

### 2. 必须说明适配的 dsh 版本范围

必须给出 `peerDependencies` 里对 `@deepseek-ai/*` 的约束。
这是本仓库判断「该把 tarball 放在哪个版本目录下」的**唯一依据**。

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

## 二、来源标注义务 ★

**这是本仓库最看重的一条。** 我们分发别人的代码，就必须把出处写准。

每个新入库的插件，**必须**在 [`README.md` 第三节](./README.md#三插件来源与许可)
的表格里补齐这几列：

| 列 | 要求 |
|---|---|
| **来源** | 只能是「本仓库自研」或「第三方收集」，二选一 |
| **原作者** | 第三方填作者名；查不到就写「**未注明**」，**不要留空、不要猜** |
| **上游仓库** | 第三方必须给出 URL；确实无法定位就写「**无法定位**」 |
| **许可** | 按 `package.json` 的 `license` 字段填；没有就写「**未声明**」 |

### 怎么核实来源（按可信度排序）

1. `package.json` 的 `author` / `repository` 字段 —— 最权威
2. **包内 `README.md` / `LICENSE` / `NOTICE` 里声明的上游** —— 次之
3. npm 上的包页面（`npm view <包名> repository homepage author`）
4. 都查不到 → 按「未注明」登记，并在同一条目里**说明你核实过哪些地方**

> **真实案例**：本仓库的 `@dsh-market/plugin` 最初被标成了「自研」。
> 原因就是它的 `package.json` **没有** `author` 和 `repository` 字段。
> 后来在它的包内 `README.md` 里才找到了上游 `2BingLing/dsh-market`。
> —— 所以**第 2 条核实途径不能跳过**。

### 许可文件

第三方插件的 tarball 里应当保留 `LICENSE` 正文。
入库时请一并检查：

```bash
tar -tzf <tarball> | grep -iE 'LICENSE|NOTICE|COPYING'
```

如果上游确实没有附许可文件，**如实登记，不要伪造**，
并考虑提一个 PR 给上游补上。

---

## 三、目录结构与命名

```none
plugins/
└─ <目录名>/                 # 包名去掉 scope 前缀，如 @dsh-market/plugin → dsh-market-plugin
   └─ <dsh 版本>/            # ★ 适配的 dsh 运行时版本，如 0.1.6-alpha.1
      └─ <包名>-<插件版本>.tgz
```

规则：

- **`<目录名>`** = 包名去掉 scope。`@dsh-market/plugin` → `dsh-market-plugin`；
  `dsh-receipt` → `dsh-receipt`
- **`<dsh 版本>`** = 这套 tarball 适配的 **dsh 运行时版本**，不是插件版本。
  用的是 dsh 的完整版本串，含预发布号（`0.1.6-alpha.1`，不写 `0.1.6`）
- **tarball 文件名** = `npm pack` 的默认产物名，即 `<包名>-<版本>.tgz`，
  scope 里的 `/` 换成 `-`（`@dsh-market/plugin` → `dsh-market-plugin-0.4.8.tgz`）

> **同一个插件可以、也应该有多个版本目录**：当插件为适配不同 dsh 版本
> 发布了不同构建产物时，各放一处，互不影响。

---

## 四、新增一个插件

### 第 1 步：打包

在插件项目目录下：

```bash
npm pack --ignore-scripts \
  --pack-destination <临时目录> \
  --cache <临时目录>/.npm-cache
```

> `--ignore-scripts` 避免触发依赖的 install 脚本；
> `--cache` 指到临时目录，避免写用户级 npm 缓存被沙箱或权限拦。

**打包后先自查**：

```bash
tgz=<临时目录>/<包名>-<版本>.tgz
tar -tzf "$tgz" | grep -c 'package/lib/'         # > 0，确认 lib 进来了
tar -tzf "$tgz" | grep -c 'cordis.patch.yml'     # 应为 1
tar -tzf "$tgz" | grep -iE 'LICENSE|NOTICE'      # 第三方应有
tar -tzf "$tgz" | grep -E 'node_modules|\.env'   # 应为空
```

### 第 2 步：放进对应版本目录

```bash
rt=0.1.6-alpha.1                  # 该插件适配的 dsh 版本
dir=<目录名>                       # 包名去掉 scope 前缀
mkdir -p "plugins/$dir/$rt"
cp "$tgz" "plugins/$dir/$rt/"
```

### 第 3 步：登记（★ 四处都要改，缺一处脚本就不认识它）

**① `compatibility.json`** —— 在对应 runtime 的 `plugins` 数组里**按 bundle 顺序**
插入一项（顺序错会导致安装顺序错）：

```json
{
  "dir": "<目录名>",
  "package": "<包名>",
  "version": "<插件版本>",
  "tarball": "plugins/<目录名>/<dsh 版本>/<包名>-<版本>.tgz",
  "files": <tarball 内文件数>,
  "origin": "self | third-party",
  "author": "<原作者，查不到写 null>",
  "upstream": "<上游 URL，查不到写 null>",
  "license": "MIT",
  "licenseFileInTarball": true,
  "peerRuntimePin": "<peerDependencies 里对 @deepseek-ai/* 的约束>",
  "peerVerdict": "ok | warn | critical",
  "peerNote": "<为什么是这个结论，实测还是推断>"
}
```

- `peerVerdict` 的取值含义：
  - `ok` —— 不对 dsh 运行时版本设约束，或范围明确包含目标版本
  - `warn` —— 会打 peer 警告，但实测可正常加载
  - `critical` —— **版本不匹配会导致启动失败**，这一项决定整批插件的 dsh 基线
- 如果该 plugin 要进 bundle 层，记得同步更新 runtime 的 `bundles` 数组
  （`inBoxBundles` + `plugins` 的包名顺序）

**② `README.md` 第三节** —— 补上来源与许可那一行

**③ `README.md` 第四节** —— 补上插件清单那一行

**④ `profile-config/profile-bundles.yaml`** —— 若要进 web 的 bundle 层，
在 `userBundles` / `finalBundles` 里追加（**顺序即层级顺序**）

### 第 4 步：校验并提交

```bash
# 校验 compatibility.json 合法、tarball 路径存在、bundles 顺序自洽
node -e "
const fs=require('fs');
const c=JSON.parse(fs.readFileSync('compatibility.json','utf8'));
const rt=c.runtimes.find(r=>r.status==='supported');
let bad=0;
for(const p of rt.plugins){ if(!fs.existsSync(p.tarball)){console.log('MISS',p.tarball);bad++;} }
const exp=c.inBoxBundles.concat(rt.plugins.map(p=>p.package));
console.log('bundles 顺序一致:', JSON.stringify(exp)===JSON.stringify(rt.bundles));
console.log('missing:', bad);
"

# 真实验证（四步全绿才算过）
node scripts/verify.mjs

git add -A
git commit -m "feat: add <包名> <版本> (dsh <版本>)"
git push origin main
```

---

## 五、新增一个 dsh 运行时版本

**这是最受欢迎的一类贡献。** 当 dsh 发布新版本时，本仓库需要补一套适配包。

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

   - **现有 tarball 直接可用** → 只需新增一个版本目录，把现有 tarball 复制过去
     （或用软链接），并在 `compatibility.json` 里加一个 `runtime` 条目
   - **需要重新构建** → 拿到插件源码，按新版 dsh 的 peer 要求重新构建、重新打包，
     放进新的版本目录
   - **某个插件确实无法适配**（上游没有对应版本） → 在该 runtime 条目里
     **明确标注哪个插件不可用**，让安装脚本能给出清楚的提示，
     而不是让用户装上一个会崩的组合

4. **在 `compatibility.json` 里新增 runtime 条目**

   ```json
   {
     "dshVersion": "<新版本>",
     "distTag": "<latest | next | alpha>",
     "status": "supported",
     "recommended": true,
     "verifiedAt": "<YYYY-MM-DD>",
     "verifiedOn": { "os": "...", "node": "...", "pnpm": "...", "result": "..." },
     "installCommand": "npm i -g @deepseek-ai/dsh@<新版本>",
     "bundles": [ "..." ],
     "plugins": [ "..." ]
   }
   ```

   同时把**上一个版本**的 `recommended` 改成 `false`。

5. **更新文档里的版本矩阵**（`README.md` 第五节、`README-安装说明.md` 第三节）

6. **如实填写 `verifiedOn`** —— 在什么机器、什么 Node/pnpm 版本上验证的，
   结果如何。**没实测过就不要写 supported**，宁可在 Issue 里讨论。

> ⚠️ **特别注意 npm 的 `latest` 通道**。`npm i -g @deepseek-ai/dsh` 不带版本
> 装的是 `latest`，它常常**落后于**插件要求的版本。更新时要一并检查
> `distTags` 是否变化，以及「静默降级」这个陷阱是否仍然存在。

---

## 六、PR 检查清单

提交前请逐项确认：

- [ ] tarball 内含 `package.json` + `cordis.patch.yml` + `lib/`，**不含** `node_modules` / 凭据
- [ ] `package.json` 里有 `dsh.bundle` 声明
- [ ] 目录结构符合 `plugins/<目录名>/<dsh 版本>/<包名>-<版本>.tgz`
- [ ] `compatibility.json` 已更新，且 **`bundles` 顺序与 `plugins` 顺序自洽**
- [ ] `README.md` 第三节（来源与许可）已更新
- [ ] `README.md` 第四节（插件清单）已更新
- [ ] `profile-config/profile-bundles.yaml` 已更新（若进 bundle 层）
- [ ] **第三方插件已标注原作者与上游仓库**；查不到就明确写「未注明」并说明核实过程
- [ ] `node scripts/verify.mjs` 四步全绿（含真实启动）
- [ ] commit message 说明改了什么、为什么

---

## 七、许可

- 本仓库**自身的**代码与文档：MIT
- **第三方插件版权归各自原作者所有**。本仓库仅做离线打包与索引，
  不修改其许可声明，不在其之上再声明版权
- 提交第三方插件时，请确认其许可**允许再分发**（MIT / Apache-2.0 / BSD 等可以；
  无许可声明或明确禁止再分发的，请不要提交）
- 如你是某个插件的原作者，希望本仓库移除或调整收录方式，
  请开 Issue 或直接联系，我们会立即处理
