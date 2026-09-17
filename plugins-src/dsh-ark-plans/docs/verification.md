# 实测记录 — dsh-ark-plans 0.1.0

这份文件记录**本包声明的每一条事实**是怎么测出来的，便于复核与后续刷新。
所有探测都是只读的（一次 `max_tokens=1` 或极短对话的请求），没有创建任何远端资源。

## 0. 实测环境

| 项 | 值 |
|---|---|
| 日期 | 2026-09-17 |
| dsh | `@deepseek-ai/dsh@0.1.6-alpha.1` |
| cordis | `4.0.2` |
| 适配器 | `@deepseek-ai/dsh-llm-pi-ai@0.1.6-alpha.1`（`api: openai-completions`） |
| Node | 22.22.2 |
| 账号套餐 | **Agent Plan Medium**（个人版，`cn-beijing`），到期 2026-10-06 |
| Coding Plan | **无订阅** → 该车道只做契约实现，未做真实调用 |

## 1. 端点

来自 arkcli `1.0.27` 自身的车道表（二进制内文档）与本地 profile：

| 套餐 | OpenAI 兼容 base | Anthropic 兼容 base |
|---|---|---|
| `agent-plan` / `agent-plan-team` | `/api/plan/v3` | `/api/plan` |
| `coding-plan` / `coding-plan-team` | `/api/coding/v3` | `/api/coding` |
| `platform` | `/api/v3` | — |

本机 `~/.arkcli/config.yaml` 的 Agent Plan profile 里 `anthropic_base_url` 为
`https://ark.cn-beijing.volces.com/api/plan`，与上表一致（Anthropic 车道是同 base 去掉 `/v3`）。

**实测**：`POST https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions` → **200 OK**。

## 2. 模型发现：不存在，必须内置

| 请求 | 结果 |
|---|---|
| `GET /api/plan/v3/models` | **404**（空 body） |
| `GET /api/plan/models` | **404** |
| `GET /api/coding/v3/models` | **401** `AuthenticationError`（路由存在，Agent Plan 的 Key 不被 Coding 车道接受） |

pi-ai 的端点发现（`openai-completions` → `GET {baseURL}/models`）在这条车道上无法工作，
所以模型清单只能内置，且其正确性只能靠逐 id 真实请求确认。

## 3. 模型清单探测（62 个候选 id，13 个 200）

候选来源：本机 arkcli 模型缓存里的 56 个 text/LLM 基础模型，加上已知的方舟模型名与路由名。
每个候选发一次 `POST /chat/completions`（`max_tokens: 1`），只记录状态与解析后的模型名。

**served（200）**，括号内为响应里回显的真实模型：

```text
ark-code-latest        (glm-5.3)                       ← 智能路由
doubao-seed-evolving   (doubao-seed-evolving)
doubao-seed-2-1-turbo  (doubao-seed-2-1-turbo-260628)
doubao-seed-2-0-lite   (doubao-seed-2-0-lite-260215)
doubao-seed-2-0-mini   (doubao-seed-2-0-mini-260215)
glm-5.3 / glm-5-3      (glm-5.3)
glm-5-3-flash          (glm-5-3-flash)
glm-5-2                (glm-5.3)                        ← 别名，未收录（与 glm-5.3 重复）
kimi-k3                (kimi-k3)
kimi-k2.7-code         (kimi-k2.7-code)
minimax-m3             (minimax-m3)
deepseek-v4-pro / -ga  (deepseek-v4-pro-ga-260813)
deepseek-v4-flash / -ga (deepseek-v4-flash-ga-260731)
doubao-seed-2-0-pro / -code / -260215 (doubao-seed-2-1-turbo-260628)  ← 别名，未收录
```

**rejected（404 `UnsupportedModel`，全部剔除，未写进配置）**：
`ark-latest`、`doubao-seed-1-6*` 全系、`doubao-seed-1-8`、`doubao-seed-code`、
`doubao-seed-character`、`doubao-smart-router`、`doubao-pro/lite/vision-*` 全系、
`deepseek-v3`、`deepseek-v3-1`、`deepseek-v3-2`、`deepseek-r1*`、
`glm-4-5-air`、`glm-4-6`、`glm-4-7`、`kimi-k2`、`kimi-k2-thinking`、`minimax-m2`、
`qwen2-5-72b`、`qwen3-*`、`mistral-7b`。

> 结论：**404 而不是 403**，说明这条车道对「不在套餐内」的模型一律回 `UnsupportedModel`，
> 与「不能调用」不作区分。清单按档位会变：本表是 Medium 档位的结果。

contextWindow 取值来源：本机 arkcli 模型缓存 `foundation-models.json` / `arkmodels-meta.json`
（官方目录的 `ContextLength`）——`deepseek-v4-*` 与 `glm-5-*` 为 1M、`doubao-seed-2-*` 为 256k；
缓存未覆盖的 `kimi-*` / `minimax-*` 取 200000（与同族公开窗口一致，宁保守不夸大）。

## 4. 请求形态探测（harness 实际会发的形状，全部 200）

| # | 形状 | 结果 |
|---|---|---|
| A | 多轮：`system` + user/assistant/user（assistant 不带 `reasoning_content`） | **200** `finish=stop` |
| B | 工具往返：assistant `tool_calls` + `role: tool` 结果 + `tools` 定义 | **200** `finish=stop` |
| C | `role: developer` 系统消息 | **200** |
| D | `reasoning_effort: high` | **200** |
| D2 | `thinking: {type: "disabled"}` | **200** |
| E | `stream_options: {include_usage: true}` | **200** |
| E2 | `max_completion_tokens` | **200** |
| E3 | `temperature` | **200** |

**流式**：`stream: true` → **200**，`content-type: text/event-stream`，149 条 `data:` 行，
含 `finish_reason` 与 `usage` chunk，以 `data: [DONE]` 结束。

**工具调用**：返回标准 `tool_calls`（`finish_reason: "tool_calls"`，
`function.arguments` 为 JSON 字符串）—— harness 的 agent 循环可直接工作。

→ 由此得出结论：**不需要任何 `compat` 开关**（`thinkingFormat` / `maxTokensField` /
`supportsDeveloperRole` / `supportsUsageInStreaming` 等一律保持 pi-ai 默认即可）。

## 5. 端到端实测：harness 自己走这条路由

前四节都是直接打方舟端点，证明的是「端点与协议」；这一节证明的是「harness 接上之后能用」。

在一个**全新的临时 `DSH_HOME`** 里（不碰生产 3080、也不碰开发 3090）：

```bash
DSH_HOME=<临时目录>
dsh plugin --profile headless add plugins/dsh-ark-plans/0.1.6-alpha.1/dsh-ark-plans-0.1.0.tgz
# settings.yaml: agent-default-model: { provider: ark-agent-plan, model: doubao-seed-2-0-lite }
ARK_AGENT_PLAN_API_KEY=<plan key> dsh --profile headless "只回答两个字：能通"
```

实测输出（`exit 0`）：

```none
能通
dsh: reasoning:
用户现在只要求回答两个字"能通"，我直接按照要求回答就可以了，不需要调用任何工具。
```

这一次调用同时验证了四件事：

1. 插件树真的挂上了，`llm-pi-ai` 从本包的 patch 里注册出 `ark-agent-plan` 路由；
2. `apiKeyEnv: ARK_AGENT_PLAN_API_KEY` 被 credentials 服务按每请求解析（此处来自环境变量，
   与「Models 页写入 `.credentials.yaml`」是同一条解析链）；
3. pi-ai 的 `openai-completions` 与方舟套餐车道握手成功，真实返回内容；
4. `reasoning_content` 被 pi-ai 解析并显示为 harness 的 reasoning —— 因此「思考不可见」
   这一条**不成立**，实为「思考可见、但没有强度档位可调」。

## 6. 未验证的部分（如实登记）

1. **Coding Plan 车道的真实调用**：无订阅，只验证了该 base 存在（用 Agent Plan Key 得到
   401 而非 404）。`ark-code-latest` 是 arkcli 车道文档里该套餐的路由模型，但**没有实测**。
2. **图片输入**：所有模型条目未声明 `input`，因此不能贴图。方舟目录显示
   `doubao-seed-*` 属 VisualQA 模型，但套餐车道的图片行为未实测，故不声明。
3. **思考强度档位**：车道接受 `reasoning_effort`（实测 **200**），但本包不声明
   `reasoningEfforts`，所以选择器里没有强度可调、harness 也不发送该参数；
   思考**内容**本身是可见的，见上一节第 4 条。
4. **Anthropic 兼容车道**：`/api/plan/v1/messages` 实测 **200**（用 `x-api-key` +
   `anthropic-version: 2023-06-01`），但本包不用它，仅备查。

---

# 实测记录 — 0.2.0 额度显示

日期 **2026-09-17**，环境同第 0 节（dsh `0.1.6-alpha.1`，Node 22.x，Windows）。
全部探测只读：额度查询是幂等的 `Get*Usage`，没有创建/修改任何远端资源。

## 7. 额度不在数据面（否证）

在 Agent Plan 车道上，用套餐 API Key 逐个试下列 GET 路径：

| base | 路径 | 结果 |
|---|---|---|
| `/api/plan/v3` | `/usage`、`/plan/usage`、`/quota`、`/subscribe`、`/subscription` | **全部 404** |
| `/api/plan` | 同上 5 条 | **全部 404** |
| `/api/coding/v3` | 同上 5 条 | **全部 404** |
| `/api/v3` | 同上 5 条 | **全部 404** |

→ 结论：额度**不是**数据面能力，换路径/换 base 都拿不到。

## 8. 额度在控制面（OpenTOP）

从 arkcli 二进制（`@volcengine/ark-cli@1.0.27`，Go）里提取到的 Action 与字段契约：

| Action | 路径 | 车道 |
|---|---|---|
| `GetAFPUsage` | `/open/GetAFPUsage` | Agent Plan personal |
| `GetCodingPlanUsage` | `/open/GetCodingPlanUsage` | Coding Plan personal |

响应字段（二进制内 struct 标签实测）：Agent Plan 用
`Result.AFPFiveHour` / `AFPDaily` / `AFPWeekly` / `AFPMonthly`（各自带
`Used` / `Total` / `Percent` / `ResetTime` 或 `ResetTimestamp`），加 `Result.Tier`；
Coding Plan 用 `Result.QuotaUsage[]`，**只给 `Percent`**，`Used` / `Total` 缺省不出现。

**签名实测**：手工对 `https://open.volcengineapi.com/?Action=…&Version=2024-01-01`
做 V4 签名（`X-Date` / `X-Content-Sha256` / `X-Security-Token` + `Authorization`），
服务端**认得这条路由**（返回业务错误而非 404），但对本机当时的凭证回
`InvalidCredential`。原因见下一条。

## 9. 认证边界（实测结论）

额度 Action 需要**控制面身份**，套餐 API Key 调不动它：

```console
$ arkcli usage plan --format json
{"ok": false, "error": {"message":
  "auto-discover subscriptions: … ListSubscribeTrade requires Volcengine Ark SSO STS,
   please run `arkcli auth login volc-sso`: identity volc-2129033424 STS 续期失败:
   token 交换失败: invalid_request - The request parameter refresh_token is invalid."}}
```

→ 即**账号本身**的 SSO refresh token 已失效；重新 `arkcli auth login volc-sso`
即可恢复。插件对这条路径的处理正是按此设计：显示 `expired` + 上面这条处置建议，
而不是空值或错值。

## 10. 降级路径（真机实测）

在隔离环境（`DSH_HOME=~/.dsh-dev`，端口 **3090**，不碰生产 3080）装入本包后：

```console
$ curl -s 'http://127.0.0.1:3090/plugins/dsh-ark-plans/quota'
{"ok":true,"plans":[
  {"plan":"Agent Plan","route":"ark-agent-plan","status":"expired",
   "reason":"arkcli 的 SSO 凭证已过期。运行 `arkcli auth login volc-sso` 重新登录后即可查询额度。"},
  {"plan":"Coding Plan","route":"ark-coding-plan","status":"no-identity",
   "reason":"未找到 arkcli 身份。额度接口在控制面，需要 SSO/AK-SK 签名；先运行 `arkcli auth login volc-sso` 登录一次。"}],
 "checkedAt":"2026-09-17T12:13:44.747Z"}
```

同时验证：`POST` 同一路径 → **405**；`GET /plugins/dsh-ark-plans/nope` → **404**
（exact 路由没有吃掉子路径）；`?force=1` → 绕过缓存重新查询。

## 11. 正常路径（stub 响应实测）

控制面真实数据拿不到（第 9 节），所以 happy path 用**符合第 8 节契约的响应**验证
解析与渲染，签名与请求构造走真实代码：

- Agent Plan stub（绝对值）：解析出 `5h` / `weekly` / `monthly` 三个窗口，`daily` 按设计
  剔除，`Tier=medium` 带出；
- Coding Plan stub（仅百分比）：解析出 `session` / `weekly` / `monthly`，
  `used` / `total` 保持 **`null`**（不臆造绝对量），`percent` 正常显示；
- 渲染断言 12 项全过：车道名、窗口名、`已用 / 总额（百分比）`、`刷新：<绝对时间>`、
  相对时间提示、档位、失败原因、更新时间、刷新按钮。

## 12. 未验证的部分（如实登记）

1. **控制面真实额度数字**：受第 9 节凭证失效阻塞，本包**没有**见过这个账号的真实
   `used` / `total` 返回。字段名与结构取自 arkcli 二进制的 struct 标签（第 8 节），
   解析逻辑已按该契约用 stub 验证，但**未经真实响应确认**。
2. **Coding Plan 的真实额度**：该账号无 Coding Plan 订阅，连降级路径也只能测到
   `no-identity`；Happy path 用的同样是 stub。
3. **浏览器内实际渲染**：自动化浏览器在本机不稳定，最终 UI 验证改用「真实组件代码 +
   脚本化 hooks」在 Node 里渲染并断言文本（第 11 节），**没有**截图证据。

