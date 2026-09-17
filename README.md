# dsh-plugins

DeepSeek Harness（dsh）插件仓库。每个插件独立放在 `plugins/<插件名>/` 下，
便于增量添加、互不干扰。

**内容构成**：部分是自研插件，部分是收集整理的他人开源插件。
所有插件均为 **MIT** 许可；第三方插件的版权归原作者所有，来源与许可见
[二、插件来源与许可](#二插件来源与许可)。

> 导出环境：Windows。**运行时基线：dsh `0.1.6-alpha.1`**（alpha 频道 —— 见下方警告）。
> 仓库内含离线 tarball，可在新机上完整复现。
> 安装遇到问题先看 **[`README-排错.md`](./README-排错.md)** —— 里面是实际踩过的坑。

> ⚠️ **dsh 版本必须对上，否则 `dsh web` 完全起不来。**
> `dsh-opencode-go` 的 `peerDependencies` 把整套 `@deepseek-ai/*` 精确 pin 在
> `0.1.6-alpha.1`，而 npm 的 `latest` 通道是 `0.1.5-rc.1` —— **默认装的那个版本不够用**。
> 必须显式安装：
>
> ```bash
> npm i -g @deepseek-ai/dsh@0.1.6-alpha.1
> ```
>
> ⚠️ 以后跑**不带版本**的 `npm i -g @deepseek-ai/dsh` 会**静默降级**回 `0.1.5-rc.1`，
> 插件立刻又炸。详见 [`README-排错.md` 坑 7](./README-排错.md)。

---

## 一、目录结构

```none
dsh-plugins/
├─ README.md                       # 本文件：总览 + 来源 + 批量安装 + 新增插件指南
├─ README-安装说明.md               # 详细安装步骤（逐条命令）
├─ README-排错.md                   # ★ 踩坑与排错记录（出错先看这个）
├─ .gitignore
├─ plugins/                        # 每个插件一个目录
│  ├─ dsh-market-plugin/
│  │  └─ dsh-market-plugin-0.4.8.tgz
│  ├─ dsh-workbuddy-connect/
│  │  └─ dsh-workbuddy-connect-0.5.3.tgz
│  ├─ dsh-opencode-go/
│  │  └─ dsh-opencode-go-0.1.2.tgz        # 含 13 处本地源码优化（已构建进 lib）
│  ├─ dsh-connect-trae/
│  │  └─ dsh-connect-trae-2.0.1.tgz
│  ├─ dsh-workbuddy-quota/
│  │  └─ dsh-workbuddy-quota-0.2.0.tgz
│  └─ dsh-receipt/
│     └─ dsh-receipt-0.1.0.tgz
├─ profile-config/
│  └─ profile-bundles.yaml         # web profile 的 bundles 顺序清单
└─ settings/
   └─ settings.yaml                 # 默认模型 / trae 模型目录（不含密钥）
```

---

## 二、插件来源与许可

以各插件 `package.json` 的 `author` / `repository` 字段为准：

| 包名 | 版本 | 来源 | 原作者 | 上游仓库 | 许可 |
|---|---|---|---|---|---|
| `@dsh-market/plugin` | 0.4.8 | 本仓库自研 | — | — | MIT |
| `dsh-workbuddy-quota` | 0.2.0 | 本仓库自研 | — | — | MIT |
| `dsh-workbuddy-connect` | 0.5.3 | 第三方收集 | corrinehu | [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | MIT |
| `dsh-opencode-go` | 0.1.2 | 第三方收集 | — | [Duskriver/dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go) | MIT |
| `dsh-connect-trae` | 2.0.1 | 第三方收集 | dingminhua | [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) | MIT |
| `dsh-receipt` | 0.1.0 | 第三方收集 | — | [deronendless/dsh-receipt](https://github.com/deronendless/dsh-receipt) | MIT |

> **关于 `dsh-opencode-go`**：本仓库这份是**在上游基础上改过 13 处源码后重新构建**的版本
> （改动在 `src/`，已编译进 `lib/`），与上游 npm 发布版**不完全一致**。详见
> [`README-安装说明.md` 第四节](./README-安装说明.md)。

**第三方插件的版权归各自原作者所有**，本仓库仅做离线打包与索引，未修改其许可声明。
各 tarball 内的 `LICENSE` / `THIRD_PARTY_NOTICES.md` 均已保留。

---

## 三、插件清单

| 目录 | 包名 | 版本 | tarball | 说明 |
|---|---|---|---|---|
| `plugins/dsh-market-plugin/` | `@dsh-market/plugin` | 0.4.8 | dsh-market-plugin-0.4.8.tgz | dsh 插件市场 |
| `plugins/dsh-workbuddy-connect/` | `dsh-workbuddy-connect` | 0.5.3 | dsh-workbuddy-connect-0.5.3.tgz | WorkBuddy 连接 |
| `plugins/dsh-opencode-go/` | `dsh-opencode-go` | 0.1.2 | dsh-opencode-go-0.1.2.tgz | OpenCode Go 模型供应商（**含本地优化**） |
| `plugins/dsh-connect-trae/` | `dsh-connect-trae` | 2.0.1 | dsh-connect-trae-2.0.1.tgz | Trae 模型接入 |
| `plugins/dsh-workbuddy-quota/` | `dsh-workbuddy-quota` | 0.2.0 | dsh-workbuddy-quota-0.2.0.tgz | WorkBuddy 额度显示 + token 用量统计 |
| `plugins/dsh-receipt/` | `dsh-receipt` | 0.1.0 | dsh-receipt-0.1.0.tgz | 凭证/收据 |

**安装顺序**（即 dsh bundle 层级顺序，见 `profile-config/profile-bundles.yaml`）：

```none
@dsh-market/plugin → dsh-workbuddy-connect → dsh-opencode-go
→ dsh-connect-trae → dsh-workbuddy-quota → dsh-receipt
```

### 运行时版本兼容矩阵

照各包 `package.json` 的 `peerDependencies` 实测（**这是选 dsh 版本的唯一依据**）：

| 插件 | 要求的 `@deepseek-ai/dsh-llm` | 0.1.5-rc.x | 0.1.6-alpha.1 |
|---|---|---|---|
| `@dsh-market/plugin` | 无 `@deepseek-ai` peer | ✓ | ✓ |
| `dsh-workbuddy-connect` | `^0.1.5-rc.1` | ✓ | ✓ |
| **`dsh-opencode-go`** | **`0.1.6-alpha.1`（精确 pin）** | **✗** | **✓** |
| `dsh-connect-trae` | `>=0.1.5-0 <0.2.0-0` | ✓ | ✓ |
| `dsh-workbuddy-quota` | 无 | ✓ | ✓ |
| `dsh-receipt` | 无 | ✓ | ✓ |

→ **整批插件以 `0.1.6-alpha.1` 为基线。** `dsh-opencode-go` 没有任何兼容 0.1.5 的
发布版本（`0.1.0` / `0.1.1` / `0.1.2` 全都要求 alpha），所以只能升 dsh，不能退插件。

---

## 四、新机批量安装

前置：新机已装 Node ≥ 22.19、pnpm、以及 **`@deepseek-ai/dsh@0.1.6-alpha.1`**。

```bash
# ★ 必须带版本号！不带版本的 `npm i -g @deepseek-ai/dsh` 装的是 latest=0.1.5-rc.1，
#   不够用，且以后会静默降级。
npm i -g @deepseek-ai/dsh@0.1.6-alpha.1
dsh --version        # 必须显示 0.1.6-alpha.1
```

> ⚠️ **pnpm 必须装在「dsh 所在的那个 Node」上**。多 Node 环境（如 nvm / 便携版 Node 并存）
> 极易装错位置，表现为 `dsh plugin` 报 `'pnpm' 不是内部或外部命令`。
> 完整排查见 [`README-排错.md` 坑 1](./README-排错.md)。

```bash
# clone 本仓库
gh repo clone HaydenSmith1121/dsh-plugins
cd dsh-plugins

# 1) 还原 settings.yaml —— ★ 先 diff 再决定，不要盲目覆盖
#    不同机器的 settings.yaml 可能不同代，直接覆盖会丢掉本机的 provider 配置。
#    见 README-排错.md 坑 5
diff ./settings/settings.yaml ~/.dsh/settings.yaml

# 2) 按顺序安装全部插件（顺序 = bundle 层级顺序，别乱）
dsh plugin --profile web add ./plugins/dsh-market-plugin/dsh-market-plugin-0.4.8.tgz
dsh plugin --profile web add ./plugins/dsh-workbuddy-connect/dsh-workbuddy-connect-0.5.3.tgz
dsh plugin --profile web add ./plugins/dsh-opencode-go/dsh-opencode-go-0.1.2.tgz
dsh plugin --profile web add ./plugins/dsh-connect-trae/dsh-connect-trae-2.0.1.tgz
dsh plugin --profile web add ./plugins/dsh-workbuddy-quota/dsh-workbuddy-quota-0.2.0.tgz
dsh plugin --profile web add ./plugins/dsh-receipt/dsh-receipt-0.1.0.tgz

# 3) 启动验证
dsh web          # 默认 http://127.0.0.1:3080
```

> **`file:` 依赖会锚定 tarball 的绝对路径** —— 这个仓库目录不能删、不能挪，
> 否则以后 `pnpm install` 会失败。见 [`README-排错.md` 坑 3](./README-排错.md)。

安装完成后务必跑一次完整校验：

```bash
dsh --version                                        # ⓪ 必须是 0.1.6-alpha.1（见坑 7）
dsh plugin --profile web list                        # ① 依赖层：期望 6 packages
cat ~/.dsh/profiles/web/package.json                 # ② 注册表层：bundles 应为 8 项

# ③ 装配层：只打配置树，不加载模块，查不出坑 7
dsh --profile web --dump-config | grep -n '^# == '

# ④ ★ 真实启动：唯一能验证模块能否 import 的办法
dsh web --no-open --port 0 > boot.log 2>&1 & sleep 30; cat boot.log; kill %1
```

⚠️ **③ 和 ④ 不能互相替代**：`--dump-config` 不 import 任何模块，所以坑 7
（导出缺失导致插件树加载失败）**只有第 ④ 步能查出来**。

详见 [`README-排错.md` 附录 A](./README-排错.md)。

---

## 五、踩坑与排错

**`README-排错.md`** 记录了实际安装中撞到的全部坑，包括：

| # | 坑 | 关键点 |
|---|---|---|
| 1 | 本机没有 pnpm | 多 Node 环境下装错位置 |
| 2 | **`ERR_PNPM_IGNORED_BUILDS`** | 最坑的安装期问题：包已装好、`dependencies` 已写，**但 `bundles` 没追加** → GUI 里看不见 |
| 3 | `file:` 依赖锚定绝对路径 | 仓库目录不能挪（含万一要挪的正确三步） |
| 4 | `grep bundles` 永远返回空 | `--dump-config` 用 `# == <bundle>` 做头，没有 "bundles" 字面词 |
| 5 | `settings.yaml` 盲目覆盖 | 不同代配置，会丢 provider 清单 |
| 6 | 凭据/登录态不随包迁移 | `.credentials.yaml` 不在包内，trae 需重登 |
| **7** | **dsh 版本不对 → 整个插件树加载失败** | **最严重的启动期问题**：`dsh-opencode-go` 要 `0.1.6-alpha.1`，`latest` 是 `0.1.5-rc.1` → `dsh web` 完全起不来；且不带版本的 npm 升级会静默降级 |

---

## 六、以后怎么往仓库里加新插件

新增一个插件只需 3 步，**不会动到其他插件目录**：

### 1) 打 tarball

在插件项目目录下：

```bash
# 把缓存指到工作区，避免 npm 写 AppData\Local\npm-cache 被沙箱拦
npm pack --ignore-scripts --pack-destination <导出临时目录> \
         --cache <导出临时目录>/.npm-cache
```

得到的 tarball 文件名形如 `<包名>-<版本>.tgz`。

### 2) 放进仓库

```bash
# 仓库根
repo=~/dsh-plugins

# 新建插件目录（目录名 = 包名去掉 scope 前缀，如 @dsh-market/plugin → dsh-market-plugin）
mkdir -p "$repo/plugins/<新插件目录名>"

# 把 tarball 拷进去
cp "<导出临时目录>/<包名>-<版本>.tgz" "$repo/plugins/<新插件目录名>/"
```

### 3) 更新清单并提交

1. 在「三、插件清单」表格里加一行；
2. **在「二、插件来源与许可」里补上来源**（自研 / 第三方，第三方要写上原作者与上游仓库）——
   这部分不能漏，第三方插件的版权归原作者；
3. 如果该插件要进 web profile 的 bundle 层，在 `profile-config/profile-bundles.yaml` 的
   `userBundles` / `finalBundles` 里追加（顺序即层级顺序）；
4. 在「四、新机批量安装」里加一条对应的 `dsh plugin add` 命令；
5. 提交并推送：

```bash
git add -A
git commit -m "feat: add <新插件名> <版本>"
git push origin main
```

---

## 七、tarball 校验信息（导出机打包时）

每个 tarball 均已验证含 `package.json` + `cordis.patch.yml` + `lib/`：

| 插件 | 版本 | tarball 内文件数 | 含 cordis.patch.yml | 含 lib |
|---|---|---|---|---|
| @dsh-market/plugin | 0.4.8 | 7 | ✓ | ✓ |
| dsh-workbuddy-connect | 0.5.3 | 11 | ✓ | ✓ |
| dsh-opencode-go | 0.1.2 | 30 | ✓ | ✓ |
| dsh-connect-trae | 2.0.1 | 12 | ✓ | ✓ |
| dsh-workbuddy-quota | 0.2.0 | 5 | ✓ | ✓ |
| dsh-receipt | 0.1.0 | 16 | ✓ | ✓ |

自查命令：

```bash
for f in plugins/*/*.tgz; do
  printf "%-60s files=%s cordis=%s lib=%s\n" "$f" \
    "$(tar -tzf "$f" | grep -vc '/$')" \
    "$(tar -tzf "$f" | grep -c 'cordis.patch.yml')" \
    "$(tar -tzf "$f" | grep -c 'package/lib/')"
done
```
