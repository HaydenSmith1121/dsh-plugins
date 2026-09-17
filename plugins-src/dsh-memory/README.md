# dsh-memory

给 DeepSeek Harness 加一层**跨会话记忆**：一轮结束后自己把新对话蒸馏成长期笔记，
下一次会话开始时，全局笔记 + 当前工作区的笔记会作为提示段自动带上。

对应的是「用久了它越来越懂你」那类体验，但实现上不依赖任何云服务、不写会话日志，
全部落在本地 `$DSH_HOME/memory/` 的两三个 markdown 文件里，**你可以直接手改**。

---

## 一、它解决了什么

harness 自己有几个相邻但不等价的东西：

| 现有能力 | 边界 |
|---|---|
| `dsh-compaction-*` | 只压**当前会话**上下文，会话一结束就没了 |
| `dsh-session-persistence-jsonl` | 会话原文存在 `$DSH_HOME/sessions`，但**没有任何东西会去读它、总结它** |
| `dsh-agent-instructions` | 每次会话自动注入 `AGENTS.md`，但那是**人手写**的，不会自己长 |
| `dsh-session-query-sqlite` | 有全文检索，但默认 `openAt: never`，且检索是「你主动去查」 |

缺的那一环正是：**会话结束 → 自己总结 → 下次自动带上**。本插件就是这一环。

---

## 二、工作方式

### 召回（每次模型请求前）

给每个 agent 注册一个作用域提示段：

```js
agent.ctx.inject(['systemPrompt'], (scope) => {
  scope.systemPrompt.section({
    name: 'memory:recall',
    order: scope.systemPrompt.getSectionOrder('FILE_REFERENCE') - 50,
    text: () => store.recall(workspaceOf(agent)),
  })
})
```

**必须按 agent 注册，不能全局注册。** `AssembleContext` 只带 `scope` 和 `signal`，拿不到
agent——全局段没办法知道当前是哪个工作区。按 agent 注册还有第二个好处：这个
fiber 随 agent 一起卸载，不会漏到下一个会话里。

段的插入位置取 `FILE_REFERENCE`(900) 减 50，即 850：紧挨在环境类上下文那一带，
在 persona 之后、工具说明之前。

### 蒸馏（`agent/turn-stopping`）

触发点选的是 **`agent/turn-stopping`**，因为它是 **serial（会被 await）** 事件——
这个监听器的 promise 不 settle，turn 就不关闭。

空闲防抖（`agent/status → idle` 后起个定时器）体验更好，但**对持久化是错的钩子**：
`dsh --profile headless "…"` 这种一次跑完就退出的用法，turn 一关进程就走了，
任何「turn 之后再跑」的活儿根本不会执行。所以这里是 await 的。

代价用两道闸门压住，让普通短轮次零开销：

| 闸门 | 默认 | 环境变量 |
|---|---|---|
| 新一轮文本量的下限 | 600 字符 | `DSH_MEMORY_MIN_CHARS` |
| 同一会话两次蒸馏的最小间隔 | 60 秒 | `DSH_MEMORY_MIN_INTERVAL_MS` |

### 只喂人说的话

`session/event` 里只取 `user/message` 中 `source.kind === 'user'` 的，加上
`assistant/message`。合成消息（我们的召回段本身、文件变更通知、skill 正文、goal 续跑）
**一律不要**——否则记忆会把自己的输出当成新事实再总结一遍，几轮之后就漂了。

---

## 三、存储布局

```
$DSH_HOME/memory/
├─ MEMORY.md                          # 全局笔记（跨项目的事实）
├─ workspaces/
│  └─ <slug>-<hash8>/MEMORY.md        # 按工作区隔离的笔记
└─ journal/
   └─ YYYY-MM-DD.md                   # 每次蒸馏的段落，append-only
```

- `<slug>` 取自工作区目录名，给你翻目录时看的；`<hash8>` 是路径 sha1 前 8 位，
  用来区分同名 checkout（`D:\a\web` 和 `D:\b\web` 不会撞）。
- 笔记行格式：`- YYYY-MM-DD HH:mm · <一句话>`，纯文本，**手改完全安全**。
- 追加时按归一化文本去重，超过 `DSH_MEMORY_FILE_BYTES` 时丢**最旧**的。
- 写入走临时文件 + rename，中途崩溃不会把已有记忆截断。

蒸馏产物是一段 JSON：

```json
{"global":["…"],"workspace":["…"],"summary":"一段话"}
```

`global` 进全局文件，`workspace` 进当前工作区文件，`summary` 进 journal。
模型经常会裹一层 ``` 代码块或加一句废话，所以解析时取最外层花括号对，
不假设回复是干净的。

---

## 四、安装

```bash
dsh plugin --profile web add /path/to/dsh-memory-0.1.0.tgz
```

装完**需要重启 profile**：本插件在进程启动时挂载（要拿到 `agent/created`、
`session/event`、`agent/turn-stopping` 这些宿主事件），不是热插拔的。

## 五、配置

全部走环境变量——这样宿主半**一个包都不导入**（只有 `node:` 内置模块）。
代价是没有 config schema，收益是：harness 换版本时改了任何插件 API，
都不可能让本模块 import 失败把整棵插件树带崩（就是
`plugin tree failed to load` 那个失败面）。本插件只有 8 个旋钮，也没有 UI，
这个取舍是划算的。

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_MEMORY_DISABLED` | — | 非空则**挂载但完全惰性**，排查插件树时用 |
| `DSH_MEMORY_ROOT` | `$DSH_HOME/memory` | 记忆根目录，测试指到临时目录 |
| `DSH_MEMORY_MIN_CHARS` | `600` | 新一轮文本量下限 |
| `DSH_MEMORY_MIN_INTERVAL_MS` | `60000` | 同会话两次蒸馏最小间隔 |
| `DSH_MEMORY_TRANSCRIPT_CHARS` | `16000` | 单次蒸馏喂进去的正文上限 |
| `DSH_MEMORY_RECALL_BYTES` | `6000` | 召回段字节上限（超了丢最旧的） |
| `DSH_MEMORY_FILE_BYTES` | `32000` | 单个记忆文件字节上限 |
| `DSH_MEMORY_MAX_TOKENS` | `1200` | 单次蒸馏输出预算 |
| `DSH_MEMORY_TIMEOUT_MS` | `45000` | 单次蒸馏超时（AbortController） |

蒸馏用**默认模型路由**（`agentDefaultModel.currentSelection()`）。
想省钱就在「设置 → 模型」里把默认模型换成便宜的——蒸馏是一次普通的
`ctx.llm.stream()` 调用，没有单独的模型配置。

---

## 六、明确不做的事

- **不读会话日志。** 正文来自 `session/event` 的实时通知，不解析
  `$DSH_HOME/sessions`，也不依赖 `session-query-sqlite`（它默认是关的）。
- **不碰设置、凭据、会话。** 所有写入都限制在 `$DSH_HOME/memory/` 之内。
- **不提供工具和斜杠命令。** 0.1.0 只有「自动召回 + 自动蒸馏」两条路。
  `memory_write` / `memory_search` / `/remember` 是 0.1.x 的下一步——
  那需要 `tools.register` 的 `ToolDefinition` 契约，本版有意不引入这个面。
- **不做向量检索。** 召回是「全局 + 当前工作区」全量注入（有字节上限），
  不是语义检索。笔记量到几千条以后需要换策略，那是 0.2 的事。

---

## 七、验证

```bash
node test/smoke.mjs
```

冒烟测试用手搭的 Cordis ctx 真正驱动 `apply()`，覆盖：提示段注册与 order、
召回为空时不注入、合成消息被过滤、蒸馏落盘（全局 / 工作区 / journal）、
工作区键格式、喂给模型的正文不含召回段本身、重复条目不重复追加。

它**不覆盖**只有真实运行时能回答的部分：作用域提示段注册是否被接受、
`agent/turn-stopping` 是否真的被 await、`llm.stream` 的 option 形状是否被接受。
那些由隔离环境上的端到端实测覆盖，见 `docs/verification.md`。

---

## 八、许可

MIT。见 `LICENSE`。
