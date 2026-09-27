# 贡献指南

**[← 回到首页](./README.md)**

这个仓库是**搜集器**，不是市场。所以贡献方式比一般开源项目宽得多 ——
**不需要你会写这个插件，也能帮上忙。**

---

## 一、最需要的三类贡献

### ★★★ 补上没被采到的仓库

GitHub 搜索每个查询最多返回 1000 条，公开索引也未必收得全。如果你知道某个
DSH 插件仓库没出现在面板里：

1. 打开 [`catalog/seed.json`](./catalog/seed.json)
2. 把 `owner/repo` 写进 `include`
3. 跑一次 `node scripts/collect.mjs`
4. 提交 `catalog/` 下的变化

> **不要在 seed 里写描述和 star 数。** 联网采集时它们会从 GitHub 直读，
> 手写的数字一定会过期。人工只回答「收不收」，不回答「它有多少星」。

要下架某个仓库：写进 `exclude`，无论哪一路发现了它都不会进索引。

### ★★ 补上新 dsh 版本的实测结论

装上、打开面板、确认数据出来了，然后把结论写进
[`compatibility.json`](./compatibility.json)：

```json
{
  "dshVersion": "0.1.8",
  "channel": "desktop",
  "status": "supported",
  "verifiedAt": "2026-10-01",
  "verifiedOn": {
    "os": "Windows",
    "node": "24.18.0",
    "result": "装上后侧栏出现「插件搜集」，索引载入 8800 条，搜索与复制正常。"
  }
}
```

> **只写你真的跑过的。** 没实测就写 `expected` 并说明为什么这么推断 ——
> 这一栏的价值全在「它不是猜的」。写一个假的 `supported`，
> 比空着更糟：下一个人会拿它当依据。

### ★ 改进采集器与面板

`scripts/`、`src/`、`docs/` 都欢迎。提交前请跑：

```bash
node test/run.mjs                # 全部测试（只读、不联网）
node scripts/collect.mjs --check # 索引自洽
node scripts/collect.mjs --limit 200   # 试跑一次采集（不写盘）
```

---

## 二、这个仓库的四条规矩

这些规矩不是风格偏好，每一条都对应过一次真实事故，测试里也钉住了。

| 规矩 | 为什么 |
|---|---|
| **内容没变就不动时间戳** | 每 6 小时一次的无脑刷新会让几千条记录天天显示为「已修改」，真正的变更被噪音淹没 |
| **没看过就不删** | 某个来源这一轮失败（限流、断网）时，由它发现的记录**原样保留**。把「没查到」当成「不存在」是这类采集器最容易犯的错 |
| **拿不到就是 null** | 描述取不到就写 `null`，不用仓库名凑一句看起来像描述的字符串 |
| **别猜** | 没实测的版本写 `expected`，查不到的作者写 `null`。准确性优先于表格好看 |

---

## 三、改索引格式时注意什么

`catalog/index.json` 是**天天在变的运行时数据**，所以它的序列化是刻意设计的：

- **一条记录一行**（不是整体 pretty-print）。这样 diff 里出现的恰好是
  「哪几个仓库变了」，而不是「整段重排」。
- **键顺序固定**（见 `scripts/lib/catalog-format.mjs` 的 `normalizeRecord`）。
  `JSON.stringify` 按插入顺序输出，改键顺序等于让整份索引重排一次。
- **排序只在采集端做一次**（star 降序 → id 升序）。面板不再排第二次 ——
  排序规则有两份实现，就一定会有一天不一致。
- **`catalog/snapshot.json` 是索引的稳定投影**：登记性字段一律为空、只取 star 最高的
  一批、条数有上限。它是打进插件包的，如果它随索引的日常刷洗而变，
  那么每 6 小时一次的采集都会改到包，而包内容变了版本号没变 ——
  装过的人收不到任何更新，git 里却天天多一个 diff。

改完之后 `node scripts/collect.mjs --check` 必须通过；它会逐字节验证
「重新序列化同一份数据」与磁盘上那一份是否相同。

---

## 四、改面板（客户端半）时注意什么

`src/client/app.js` 是一个 **classic script**，不是 ES module。写错一处的症状是
**整页白屏或面板根本不出来**，而且不会有任何编译期报错：

| 不能做的事 | 后果 |
|---|---|
| 写 `import` / `export` | SyntaxError，宿主报 “bundle ... loaded without registering” |
| 写顶层 `await` | 同上 |
| 改 `load({ id })` 里的 id | 它必须严格等于包名，也是 boot 图的行 id |
| `require` 除 `react` 以外的东西 | 依赖面一大，跨版本就活不下来 |
| 在不 `slots.inject` 的情况下直接 `slots.register` | 注册不会生效 |
| 让 `inject` 多声明服务 | 声明的服务没就绪会让**整页 boot 失败** |

这些约束都在 `test/bundle.test.mjs` 里有对应断言，跑一次测试就知道有没有踩到。

---

## 五、提交前的检查清单

- [ ] `node test/run.mjs` 全绿
- [ ] `git diff` 里没有 `.cache/`、没有构建产物
- [ ] 如果改了采集逻辑：`catalog/index.json` 的 diff 里**只有**实质变化的那些行
      （如果出现整段重排，说明序列化或排序被动过了）
- [ ] 如果改了面板：在真实的 harness 里打开过一次，不只是跑了测试
- [ ] 如果改了 `compatibility.json`：只写你真的跑过的结论，并写清楚验证方式

---

## 六、推送时的一个坑：`.github/workflows/` 需要 `workflow` 权限

改了 `.github/workflows/` 下的任何文件（新增、修改、**删除都算**）时，推送可能被拒：

```none
! [remote rejected] main -> main (refusing to allow an OAuth App to create or
  update workflow `.github/workflows/collect.yml` without `workflow` scope)
```

这不是仓库坏了，是**凭据的问题**：GitHub 要求任何对 `.github/workflows/` 的改动
都必须由带 `workflow` 权限的凭据发起，而 `gh` CLI 默认的 OAuth token
只有 `repo` / `gist` / `read:org` 这些，**不含 `workflow`**。
（实测踩到过一次：推送整个 1.0.0 改造时被拒，因为其中包含工作流的新增与删除。）

两个办法，任选其一：

```bash
# ① 给 gh 的 token 补上 workflow 权限（推荐：一次就好，之后 HTTPS 也能推）
gh auth refresh -h github.com -s workflow

# ② 或者改用 SSH 推送 —— SSH 用密钥认证，不受 token scope 这条限制
git remote set-url origin git@github.com:<owner>/<repo>.git
```

> 想确认自己当前走的是哪条路：
> `gh auth status` 看 token 的 scope，`git remote -v` 看协议（`https://` 还是 `git@`）。
> 另外注意：`git push --dry-run` **测不出**这个问题 —— 这个检查发生在服务端
> 更新引用的时候，而不是协商阶段。

---

## 七、遇到问题

开 Issue，尽量带上：

- `dsh --version`（或桌面版版本号）与操作系统
- 面板「关于」里那一段运行环境信息（它包含版本、通道、能力探测结果）
- 如果是数据问题：仓库地址，以及你看到的字段与实际不符的地方

作者会尽快回复。如果某个项目的作者希望移除收录，请直接说明，我们会立即处理。
