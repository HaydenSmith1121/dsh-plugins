# my-dsh-plugins

我的 DeepSeek Harness (dsh) 插件离线仓库。每个插件独立放在 `plugins/<插件名>/` 下，
便于以后新增插件时增量添加，互不干扰。

> 私有仓库，仅限本人使用。来源机器导出于 Windows，dsh 版本 `0.1.5-rc.1`。

---

## 一、目录结构

```
my-dsh-plugins/
├─ README.md                       # 本文件：插件总览 + 批量安装 + 新增插件指南
├─ README-安装说明.md               # 详细安装步骤（含逐条命令与排错）
├─ .gitignore
├─ plugins/                        # 每个插件一个目录
│  ├─ dsh-market-plugin/
│  │  └─ dsh-market-plugin-0.4.8.tgz
│  ├─ dsh-workbuddy-connect/
│  │  └─ dsh-workbuddy-connect-0.5.3.tgz
│  ├─ dsh-opencode-go/
│  │  └─ dsh-opencode-go-0.1.2.tgz     # 含 13 处本地源码优化（已构建进 lib）
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

## 二、插件清单

| 目录 | 包名 | 版本 | tarball | 说明 |
|---|---|---|---|---|
| `plugins/dsh-market-plugin/` | `@dsh-market/plugin` | 0.4.8 | dsh-market-plugin-0.4.8.tgz | dsh 插件市场 |
| `plugins/dsh-workbuddy-connect/` | `dsh-workbuddy-connect` | 0.5.3 | dsh-workbuddy-connect-0.5.3.tgz | WorkBuddy 连接 |
| `plugins/dsh-opencode-go/` | `dsh-opencode-go` | 0.1.2 | dsh-opencode-go-0.1.2.tgz | OpenCode Go 模型供应商（**含本地优化**） |
| `plugins/dsh-connect-trae/` | `dsh-connect-trae` | 2.0.1 | dsh-connect-trae-2.0.1.tgz | Trae 模型接入 |
| `plugins/dsh-workbuddy-quota/` | `dsh-workbuddy-quota` | 0.2.0 | dsh-workbuddy-quota-0.2.0.tgz | WorkBuddy 额度显示 + token 用量统计（private 包） |
| `plugins/dsh-receipt/` | `dsh-receipt` | 0.1.0 | dsh-receipt-0.1.0.tgz | 凭证/收据 |

**安装顺序**（即 dsh bundle 层级顺序，见 `profile-config/profile-bundles.yaml`）：

```
@dsh-market/plugin → dsh-workbuddy-connect → dsh-opencode-go
→ dsh-connect-trae → dsh-workbuddy-quota → dsh-receipt
```

---

## 三、新机批量安装

前置：新机已装 Node ≥ 22.19、pnpm、`npm i -g @deepseek-ai/dsh`（版本与来源机一致或更新）。

```powershell
# clone 本仓库（私有，需 gh 登录）
gh repo clone HaydenSmith1121/my-dsh-plugins
cd my-dsh-plugins

# 1) 还原 settings.yaml（可选）
Copy-Item .\settings\settings.yaml "$env:USERPROFILE\.dsh\settings.yaml" -Force

# 2) 按顺序安装全部插件
dsh plugin --profile web add .\plugins\dsh-market-plugin\dsh-market-plugin-0.4.8.tgz
dsh plugin --profile web add .\plugins\dsh-workbuddy-connect\dsh-workbuddy-connect-0.5.3.tgz
dsh plugin --profile web add .\plugins\dsh-opencode-go\dsh-opencode-go-0.1.2.tgz
dsh plugin --profile web add .\plugins\dsh-connect-trae\dsh-connect-trae-2.0.1.tgz
dsh plugin --profile web add .\plugins\dsh-workbuddy-quota\dsh-workbuddy-quota-0.2.0.tgz
dsh plugin --profile web add .\plugins\dsh-receipt\dsh-receipt-0.1.0.tgz

# 3) 启动验证
dsh web
```

详细排错见 `README-安装说明.md`。

---

## 四、以后怎么往仓库里加新插件

新增一个插件只需 3 步，**不会动到其他插件目录**：

### 1) 打 tarball

在来源机该插件的目录下：

```powershell
# 把缓存指到工作区，避免 npm 写 AppData\Local\npm-cache 被沙箱拦
npm pack --ignore-scripts --pack-destination <导出临时目录> `
         --cache <导出临时目录>\.npm-cache
```

得到的 tarball 文件名形如 `<包名>-<版本>.tgz`。

### 2) 放进仓库

```powershell
# 仓库根
$repo = "D:\data\data_harness\test\dsh-plugins-export"

# 新建插件目录（目录名 = 包名去掉 scope 前缀，如 @dsh-market/plugin → dsh-market-plugin）
$dir = "$repo\plugins\<新插件目录名>"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# 把 tarball 拷进去
Copy-Item "<导出临时目录>\<包名>-<版本>.tgz" $dir
```

### 3) 更新清单并提交

1. 在本文件「二、插件清单」表格里加一行；
2. 如果该插件要进 web profile 的 bundle 层，在 `profile-config/profile-bundles.yaml` 的 `userBundles` / `finalBundles` 里追加（顺序即层级顺序）；
3. 在「三、新机批量安装」里加一条对应的 `dsh plugin add` 命令；
4. 提交并推送：

```powershell
git -C $repo add -A
git -C $repo commit -m "feat: add <新插件名> <版本>"
# 推送（本机 git sslBackend=openssl，需带认证；用 gh token 一次性嵌入）
$token = (gh auth token).Trim()
git -C $repo push "https://HaydenSmith1121:$token@github.com/HaydenSmith1121/my-dsh-plugins.git" main
```

> 一次性推送后，token 不会留在 remote URL 里（remote 仍是干净的 HTTPS）。
> 若嫌每次手动塞 token 麻烦，跑一次 `gh auth setup-git` 让 gh 接管 git 凭据即可。

---

## 五、tarball 校验信息（来源机打包时）

每个 tarball 均已验证含 `package.json` + `cordis.patch.yml` + `lib/`：

| 插件 | 版本 | tarball 内文件数 | 含 cordis.patch.yml | 含 lib |
|---|---|---|---|---|
| @dsh-market/plugin | 0.4.8 | 7 | ✓ | ✓ |
| dsh-workbuddy-connect | 0.5.3 | 11 | ✓ | ✓ |
| dsh-opencode-go | 0.1.2 | 30 | ✓ | ✓ |
| dsh-connect-trae | 2.0.1 | 12 | ✓ | ✓ |
| dsh-workbuddy-quota | 0.2.0 | 5 | ✓ | ✓ |
| dsh-receipt | 0.1.0 | 16 | ✓ | ✓ |
