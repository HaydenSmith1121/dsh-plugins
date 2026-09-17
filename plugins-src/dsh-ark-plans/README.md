# dsh-ark-plans

把**火山方舟（Volcengine Ark）的 Agent Plan 与 Coding Plan** 接入 DeepSeek Harness：
安装后，两条套餐车道会作为 provider 出现在 harness 的模型选择器里，用来对话、跑 agent；
会话标题栏右侧还会显示**每条车道的额度用量与下次刷新时间**。

- 适配 dsh 运行时：**`0.1.6-alpha.1`**
- 形态：**组合配置 + host 半（凭据诊断 / 额度查询）+ client 半（标题栏额度 pill）**
- 许可：MIT

---

## 〇、额度显示（0.2.0 新增）

会话标题栏右侧出现一个 pill，每条车道一格：**进度条 + 已用百分比**（取当前最紧的窗口，
通常是 5 小时）。点开是每个窗口的明细：

```none
Agent Plan                    Coding Plan
▬▬▬▬▬░░░░░░░  25%             不可用
─────────────────────────────────────────────
Agent Plan · medium
5 小时      250 / 1.0k（25%）
            刷新：2026/09/17 16:00:00   3 小时后
本周        12.5k / 50.0k（25%）
            刷新：2026/09/24 00:00:00   7 天后
更新于 2026/09/17 20:00:00            刷新
```

- 颜色按已用比例分级：正常用品牌色，≥70% 转警告色，≥90% 转错误色。
- 每 5 分钟自动取一次；点开面板或按 **刷新** 会强制绕过缓存重取。
- 鼠标悬停 pill 可看到最近一次更新时间。

### 额度数据从哪来（重要）

额度**不在数据面**。本插件用的 `/api/plan/v3` 那条 OpenAI 兼容车道，所有
`/usage`、`/quota`、`/subscription` 路径实测都是 **404**。真正的额度由**控制面
（OpenTOP）**提供：

| 车道 | Action |
|---|---|
| Agent Plan | `GetAFPUsage` → `Result.AFPFiveHour / AFPWeekly / AFPMonthly` |
| Coding Plan | `GetCodingPlanUsage` → `Result.QuotaUsage[]`（**只给百分比**，没有绝对值） |

这两个 Action 用**火山 SSO/STS 或 AK-SK 签名**鉴权 —— **套餐的 API Key 调不动它们**
（API Key 是数据面凭证）。所以插件的 host 半自己签 V4，复用 `arkcli` 在这台机器上
已经建立的身份（`~/.arkcli/config.yaml` 选 profile、`identities/<key>/sts.json` 取凭证），
而不是去猜一个数据面路径。

### 拿不到额度时会怎样

插件**从不编造数字**，而是把「为什么拿不到 + 怎么办」直接显示在面板里：

| 状态 | 面板显示 | 处理 |
|---|---|---|
| `expired` | arkcli 的 SSO 凭证已过期… | 运行 `arkcli auth login volc-sso` 重新登录 |
| `no-identity` | 未找到 arkcli 身份… | 同上；额度接口需要控制面身份 |
| `not-subscribed` | 该账号下这条车道没有生效订阅 | 确认套餐是否已购买/到期 |
| `error` | 控制面拒绝签名时的原始原因 | 一般同 `expired` |

也就是说：**没登录 arkcli 时插件照常工作**，只是 pill 上那条车道显示「不可用」，
点开写明原因 —— 模型调用本身完全不受影响。

---

## 一、它是怎么接进去的

harness 官方自带 `@deepseek-ai/dsh-llm-pi-ai` 适配器，它在每个 profile 里都是
**dormant（零路由）挂载**的：哪个 provider 跑起来，由配置决定，而不是由代码决定。
两条方舟车道都实现了 OpenAI 兼容协议，所以本插件**不写协议转换**，只做一件事：

> 在 `cordis.patch.yml` 里给 `llm-pi-ai` 这一行补上两条 provider profile，
> 把端点、协议、模型清单、凭据引用一次声明清楚。

```yaml
- id: llm-pi-ai
  config:
    providers:
      ark-agent-plan:
        api: openai-completions
        baseURL: https://ark.cn-beijing.volces.com/api/plan/v3
        apiKeyEnv: ARK_AGENT_PLAN_API_KEY
        models: [ … 12 个已验证模型 … ]
      ark-coding-plan:
        api: openai-completions
        baseURL: https://ark.cn-beijing.volces.com/api/coding/v3
        apiKeyEnv: ARK_CODING_PLAN_API_KEY
        models: [ ark-code-latest ]
```

由此**免费获得**官方适配器的全部行为：SSE 流式、工具调用、重试策略、replay、
按请求解析凭据、Models 设置页里的 provider 行与 Key 输入框。

---

## 二、安装与启用

```bash
dsh plugin --profile web add dsh-ark-plans-0.1.0.tgz
# 重启该 profile（dsh web 不能同时起两次）
```

重启后：

1. 打开 **设置 → 模型**，能看到 `火山方舟 Agent Plan` 与 `火山方舟 Coding Plan` 两行；
2. 点进对应行的 **API Key** 输入框，粘贴套餐的 API Key；
3. 回到对话页，在模型选择器里选一条方舟模型即可。

**Key 存在哪**：`$DSH_HOME/.credentials.yaml` 顶层 `refs:` 下，键名就是配置里声明的
引用名（`ARK_AGENT_PLAN_API_KEY` / `ARK_CODING_PLAN_API_KEY`）。密钥**不会**进
`settings.yaml`，也**不会**被 materialize 成环境变量。解析优先级是
「启动时的环境变量 → 该文件 → 项目 `.env` → `$DSH_HOME/.env`」，
所以**如果启动 harness 时环境里已有同名变量，它会压过你在页面上填的值**（页面此时报只读）。

**Key 是每请求解析的**：填完不需要重启，下一次请求就生效。

---

## 三、两条车道的端点（实测）

| 套餐 | OpenAI 兼容 base | Anthropic 兼容 base |
|---|---|---|
| Agent Plan | `https://ark.cn-beijing.volces.com/api/plan/v3` | `https://ark.cn-beijing.volces.com/api/plan` |
| Coding Plan | `https://ark.cn-beijing.volces.com/api/coding/v3` | `https://ark.cn-beijing.volces.com/api/coding` |
| 按量 platform | `https://ark.cn-beijing.volces.com/api/v3` | — |

本插件只用 **OpenAI 兼容**那一列（`api: openai-completions`，请求打到 `{baseURL}/chat/completions`）。

---

## 四、模型清单是实测出来的，不是猜的

**Agent Plan 车道不支持模型发现**：`GET /api/plan/v3/models` 返回 **404**（不是权限问题，
是这条路不存在）。所以清单必须内置，而内置清单的正确性只能靠**打真实请求**确认。
本包内置的 12 个 id 全部来自一次逐 id 探测（`max_tokens=1`，`200` 才收录，
`404 UnsupportedModel` 一律剔除），并在探测时记录了它们解析到的真实版本：

| 选择器里的 id | 实测解析到 | contextWindow |
|---|---|---|
| `ark-code-latest` | 智能路由（探测时路由到 `glm-5.3`） | 262144 |
| `doubao-seed-evolving` | `doubao-seed-evolving` | 262144 |
| `doubao-seed-2-1-turbo` | `doubao-seed-2-1-turbo-260628` | 262144 |
| `doubao-seed-2-0-lite` | `doubao-seed-2-0-lite-260215` | 262144 |
| `doubao-seed-2-0-mini` | `doubao-seed-2-0-mini-260215` | 262144 |
| `glm-5.3` | `glm-5.3` | 1048576 |
| `glm-5-3-flash` | `glm-5-3-flash` | 1048576 |
| `kimi-k3` | `kimi-k3` | 200000 |
| `kimi-k2.7-code` | `kimi-k2.7-code` | 200000 |
| `minimax-m3` | `minimax-m3` | 200000 |
| `deepseek-v4-pro` | `deepseek-v4-pro-ga-260813` | 1048576 |
| `deepseek-v4-flash` | `deepseek-v4-flash-ga-260731` | 1048576 |

> 探测是在 **Agent Plan Medium** 档位上做的。别的档位/账号可能多给或少给模型 ——
> 少了不会报错（选择器里没有而已），多了按下面的办法自己加。

**Coding Plan 车道只放了 `ark-code-latest`**：本机没有 Coding Plan 订阅，无法探测它
的模型清单，所以只内置官方文档里那条智能路由模型，**不猜**。有了订阅之后，
`arkcli plans model-list --plan coding-plan` 会列出权威清单，照下面第三节加进配置即可。

---

## 五、自己加模型（不需要改插件）

`llm-pi-ai` 的用户层按 provider 合并覆盖组合层的 base，所以在 `settings.yaml` 里
补一条同名 provider 即可追加/整表替换该 provider 的模型清单：

```yaml
llm-pi-ai:
  providers:
    ark-coding-plan:
      models:
        - id: ark-code-latest
          name: Ark 智能路由 (ark-code-latest)
          contextWindow: 262144
        - id: kimi-k2.7-code
          name: Kimi-K2.7-Code
          contextWindow: 200000
```

也可以直接在 **设置 → 模型** 里编辑该 provider，页面写的就是这个 section。
模型 id 写错时，该 provider 行会显示红色诊断（`catalogError`），行本身不会消失，可随时改回来。

---

## 六、已知边界（都是实测结论）

1. **不支持图片输入**。所有模型条目都未声明 `input: [text, image]`，因为图片车道没有实测；
   pi-ai 的规则是「少声明会拒图并说明原因，多声明则会在请求发出后被 provider 拒掉」，
   宁可保守。要开：在 settings 里给自己的模型条目加 `input: [text, image]`。
2. **不提供思考强度档位**。方舟车道确实返回 `reasoning_content`（实测），harness 会把它
   显示出来（headless 实测输出里有 `dsh: reasoning:` 段），但本包未声明 `reasoningEfforts`，
   因此模型选择器里**没有**思考强度可调 —— 模型按其默认强度思考，harness 也**不发送**
   任何 `reasoning_effort` 参数。这是刻意的保守选择：声明了却发错参数会导致请求 400。
3. **组合层声明的 provider 用户删不掉**。这是 pi-ai 的设计（用户层只能覆盖、不能删除
   base 路由）：不想要就 `dsh plugin --profile web remove dsh-ark-plans`。
4. **和 `arkcli helper configure deepseek-harness` 会各写一份**。arkcli 写的是
   `llm-pi-ai.providers.arkcli-<planType>`，本插件写的是 `ark-agent-plan` /
   `ark-coding-plan`；两者路由名不同，会同时出现在选择器里（各自独立凭据）。
   二选一即可，别把同一个 Key 填两遍。
5. **`apiKeyEnv` 引用了启动环境里的同名变量时，页面显示只读**。这是 credentials
   服务的分层规则（环境变量优先级最高），不是插件问题。
6. **patch 是整段替换 `config`**。若将来有别的 bundle 也 `- id: llm-pi-ai` + `config:`，
   后加载者会覆盖本插件声明的 providers（目前官方 `dsh-base` 挂这一行时**不带任何
   config**，本仓库已收录的其它插件也都没打这一行）。

---

## 七、它为什么还需要一个 host 半

组合配置无法报告自己最关键的失败模式：`apiKeyEnv` 解析不到时，这条路由**依然合法**
—— 它照常挂载、照常出现在选择器里，只有在真正请求时才以 `MISSING_CREDENTIAL` 失败。
`lib/index.js` 因此在启动时、以及每次这两个引用变化时，各打印一行状态：

```
dsh-ark-plans: Agent Plan ready — route "ark-agent-plan" resolves ARK_AGENT_PLAN_API_KEY
dsh-ark-plans: Coding Plan declared but keyless — open 设置 → 模型 … 并粘贴 API Key；…
```

它只通过 `ctx.credentials.describe()` 读**引用是否存在**（从不读密钥值本身），
所有分支都自行兜住异常：诊断永远不会拖垮插件树。

额度查询同理只能落在 host 半（签名与文件读取都在 Node 侧）。两半之间用**一条同源
HTTP 路由**通信：

```none
GET /plugins/dsh-ark-plans/quota[?force=1]   →  { ok, plans[], checkedAt }
```

- 用 `ctx.webServer.register({ kind: 'exact', path })` 注册。**exact 而非 prefix**：
  只占这一个路径，不会顺带吃掉它下面的所有子路径；exact 表又先于 prefix 表匹配，
  所以即使它落在 `/plugins` 这个前缀下，也不会被客户端模块分发器抢走。
- 处理器**只接受 GET/HEAD**（其余 405），并且**限定 loopback 来源**（127.0.0.1 / ::1，
  否则 403）：这条路由读到的是账号自己的订阅状态，不该让网内其它机器看到。
- 控制面出错时返回 **HTTP 200 + 说明性 body**，而不是 5xx —— 「读不到额度，原因是 X」
  本身就是 pill 必须能渲染的一种状态，5xx 只会变成浏览器侧一个没有信息的 fetch 失败。
- `?force=1` 绕过 60 秒缓存，供面板上的「刷新」使用。

---

## 八、目录

```none
dsh-ark-plans/
├─ package.json          # dsh.bundle.patch → cordis.patch.yml；dsh.client → lib/client.js
├─ cordis.patch.yml      # 两条 provider profile（路由 / 模型清单 / 凭据引用）
├─ lib/index.js          # host 半：凭据诊断 + 额度查询（OpenTOP V4 签名）+ 额度路由
├─ lib/client.js         # client 半：标题栏额度 pill（factory-form CJS bundle）
├─ docs/verification.md  # 本包的实测记录（端点 / 协议 / 模型 / 额度）
├─ README.md
└─ LICENSE
```
