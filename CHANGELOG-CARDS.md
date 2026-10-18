# dsh-skill-cards 改造记录

> 本文记录本轮对 `dsh-skill-cards`（v1.1.0）的完整改造：需求演进、设计决策、踩过的坑、验证方式。
> 仓库位置：`C:\Users\shuying\Documents\deepseek-harness\default-workspace\dsh-skill-cards-main`

---

## 一、起点

原插件是一个"技能卡片浏览器"：扫本机技能目录，用游戏王卡面展示，勾选后一次性注入当前会话。
没有**开关**概念——技能要么在，要么不在。

本轮从"加个开关"开始，一路做到"会话隔离 + 跨重启持久化 + 默认关闭"。

---

## 二、需求演进（六轮）

| # | 需求 | 核心产出 |
|---|---|---|
| 1 | 加开关功能 | 会话级影子 provider，关闭=模型看不见 |
| 2 | 本轮要能运用 | 改由 `agent/status → idle` 驱动释放 |
| 3 | 区分本对话 / 下轮 | 两种应用范围：本轮 / 本会话 |
| 4 | 不同会话互不影响 | 开关从全机共享改为会话级 |
| 5 | 重启后保持关闭 | 会话名单持久化 + 影子重建 |
| 6 | 默认关闭卡片 | `_disableByDefault` 机器级偏好 |

---

## 三、核心机制：影子 provider

### 3.1 为什么不用"删文件"或"改配置"

关掉一个技能，最直觉的做法是删目录或改 `SKILL.md`。**都不行**：

- 不可逆，且会影响机器上其它 agent
- 用户可能只是想"这个对话先别用"

采用的是 **skill registry 的分层覆盖**：

```js
agent.ctx.get('skills').registerProvider(() => ({
  name: 'dsh-skill-cards-shadow',
  async list() {
    return [...items].map(d => ({
      name: d.def.name,                              // 同名
      invocation: { modelInvocable: false, userInvocable: false },
      rank: 0,                                       // 同层平局靠它
    }))
  },
}))
```

### 3.2 为什么这样就生效

skill registry 合并「全局层 + 会话作用域链」时：

> **近的层直接赢同名条目**，rank 只决定同一层内的平局。

所以：

- 影子注册在 **agent 自己的 context** → 层次更近 → 压过文件系统 provider
- `rank: 0` → 同层也赢
- `modelInvocable: false` → 从 `<available_skills>` 消失，`skill` 工具也拒绝加载

**技能文件一个字节都不动。**

### 3.3 结构

```
lib/index.js
  ├─ sessionDisabled   Map<sessionId, Set<name>>   会话级开关名单
  ├─ shadows           Map<sessionId, {agent, items, dispose}>
  ├─ introduced        Map<sessionId, Map<name, dispose>>   已注册的真身
  ├─ pending           Map<sessionId, Set<name>>   本轮待释放
  ├─ applyMode         Map<sessionId, Map<name, 'turn'|'session'>>
  └─ temporarilyEnabled Map<sessionId, Map<name, skill>>    临时抬影子
```

---

## 四、关键设计决策

### 4.1 一次性：释放时机（第 2 轮）

**问题**：应用后本轮没用上。

**错在哪里**：最初监听发送手势（Enter / 主按钮）来撤销。手势**先于** agent 读取技能目录，技能被从这一轮脚下抽走。

**三条候选路的比较**：

| 时机 | 结论 |
|---|---|
| 发送手势 | ❌ 抢在 agent 读目录之前 |
| 草稿变空 | ❌ 既迟又不可靠（只在 `submit-settled && ev.ok` 后清空） |
| **回合结束（idle）** | ✅ 已读到，下一条拿不到 |

**实现**：技能被 **HOLD** 着穿过整个 `running` 窗口，`agent/status → idle` 一到立刻释放恰好那批。

### 4.2 会话隔离：开关也必须会话级（第 4 轮）

**问题**：A 会话关掉 dev-expert，B 会话也灰了。

**根因**：只有「开关」是全机共享的，其余（应用/待用/影子）都已按 sessionId 键控。

**改法**：

```
旧：_disabled 全机一份 + 扇出到所有会话
新：sessionDisabled 会话级内存 + 持久化
```

**迁移兼容**：新会话首次出现时继承一次旧 `_disabled`，之后独立演进。

### 4.3 跨重启：两件事都要做（第 5 轮）

**问题**：重启后卡片自动恢复。

**这不是一个 bug，是两个**：

| # | 问题 | 后果 |
|---|---|---|
| 1 | `sessionDisabled` 纯内存 | 重启后回退旧 seed，开关改动全丢 |
| 2 | **影子 provider 也是内存** | 名单存住了也没人重建影子 |

只修 #1 不够——这是最容易做漏的地方。

**修法**：

- 持久化到 `_sessionDisabled`（按 sessionId 分组）
- `agent-added` 时按名单重建影子（`reapplyShadows`）

### 4.4 空格哨兵：一个隐蔽 bug

测试逼出来的：

> 把继承来的技能**重新开启**后，空集会删除会话键 → 重启后该会话变成"从未写过" → 又 seed 回旧 `_disabled` → **技能自己又关上了**。

**修法**：空集写 `null` 作**显式哨兵**（"此会话已决定，当前无关闭项"），而不是删键。

```js
// readSessionDisabled
if (raw === null) return new Set()   // 已决定，无关闭项
if (!Object.hasOwn(all, id)) return undefined  // 从未写过 → 可 seed
```

### 4.5 默认关闭（第 6 轮）

**问题**：重启后新开对话，技能全开。

**根因**：一条对话的开关，没法套到一个还不存在的对话上。这需要**默认值**。

**三级判定**：

| 会话状态 | 初始开关 |
|---|---|
| 有自己记录 | 用自己的（**优先**） |
| 无记录 + 默认关闭=开 | 全部关闭 |
| 无记录 + 默认关闭=关 | 旧 `_disabled` seed |

**边界选择**：默认关闭钉的是**创建那一刻已安装的技能**。之后新装的默认开启——不让偏好悄悄关掉刚装的东西。

---

## 五、踩过的坑（按严重度）

### 5.1 键漂移（最严重）

会话 id 有两套拼法：client 传 `session-<uuid>`，agent 注册表用裸 `<uuid>`。

```
写：rememberTemporary(sessionId, ...)   ← client 的 session-xxx
读：releaseSession(agent.session.id)    ← agent 的裸 uuid
```

键不同 → 回合结束**查不到**临时标记 → 影子永久不恢复 → **关闭的技能一直可见**。

**修法**：`canonicalSession(ctx, id)` —— 先解析活跃 agent，用 agent 自己的 id 作唯一键。所有会话级路由统一走它。

### 5.2 影子异步化（导致"面板关了还能用"）

`/skills` 原用 `void reapplyShadows(...)` —— 发出去就不管，同步返回旧 payload。

**面板拿到「关」，影子还在异步路上。**

**修法**：`fillShadowsSync()` —— 注册 provider + 读正文全同步。同步是**硬要求**：任何回答"关了吗"的读路径，后面必须跟一个已填充的影子。

### 5.3 时序：seed 早于 scan

`reapplyShadows` 原来先 seed 后 scan。但新会话的 seed 读 `knownSkillNames`，而它**只有扫描才填**。

```
新会话创建 → seed 读到空表 → disabled 空 → return → 0 个影子
```

**修法**：先 scan → remember → 再 seed。

### 5.4 `assert.ok(!/regex/)` 恒失败

`!regex` 对正则对象永远是 `false`（对象恒 truthy）。要写 `!/regex/.test(src)`。

### 5.5 CSS 用 inset 看不见

`.dsh-sc-gcard` 自带 `padding:5.5%` 的金属内边距，`inset` 描边画在 padding 区里被框色吃掉。改用外描边 `0 0 0 2px`。

### 5.6 扇形布局点卡面≠勾选

扇形里点卡面是**切换浏览焦点**，只有中央那张才等于勾选。写测试要走工具栏「全选」，不能点卡面。

---

## 六、测试策略：从"断言源码"到"验证行为"

### 6.1 教训

前几轮写了大量**源码文本断言**（`assert.match(hostSrc, /.../)`）。问题：

- 变量改名 → 9 个测试误报
- 真 bug（键漂移、影子缺失）→ **一个都没抓到**

因为 bug 出在**运行时键对不对**，不是"代码长什么样"。

### 6.2 改进：行为测试 + 敏感性验证

关键测试改为**直接驱动真实函数**：

```js
const { agent, providers } = fakeAgent()
await reapplyShadows(ctx, home, 's1', agent)
assert.deepEqual(shadowedNames('s1'), ['alpha','beta'])
assert.ok(providers[0].list().every(c => c.modelInvocable === false))
```

并且**验证测试有敏感性**——把 bug 改回去，确认测试会失败：

```
反转扫描顺序 → ✖ a default-off session really shadows every installed skill
恢复修复     → ✅ 4/4 通过
```

这一步很关键。不这样做，你永远不知道测试是不是在装样子。

### 6.3 当前测试规模

**20 个文件 / 188 个用例**，其中本轮新增：

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `apply-off` | 5 | 关闭的技能也能应用 |
| `audit-regressions` | 6 | 审计出的 5 个 bug |
| `clear-turns-off` | 5 | 清空要真关掉技能 |
| `default-off` | 8 | 默认关闭偏好 |
| `session-isolation` | 3 | 两会话互不影响 |
| `shadow-behaviour` | 4 | 影子真实填充 |
| `shadow-ordering` | 4 | 扫描/seed 顺序 |
| `shadow-sync` | 5 | 同步填充 |
| `switch-persistence` | 6 | 跨重启保持 |
| `switch` | 13 | 开关主逻辑 |

另有 2 个**改动前就存在**的失败（Windows 路径断言，与本次无关）。

---

## 七、数据文件

`~/.dsh/skill-cards-stats.json`：

```json
{
  "dev-expert": { "uses": 20 },
  "_prefs": { "layout": "fan" },
  "_sessionDisabled": {
    "session-abc": { "dev-expert": false },   // 该会话关了 dev-expert
    "session-def": null                        // 该会话已决定，全开
  },
  "_disableByDefault": true                    // 新会话默认全关
}
```

| 键 | 作用域 | 说明 |
|---|---|---|
| `<skillName>` | 用户级 | 使用次数 / 分类 / ★ |
| `_prefs` | 用户级 | 布局偏好 |
| `_customCategories` | 用户级 | 自建分类 |
| `_sessionDisabled` | **会话级** | 每个会话的关闭名单 |
| `_disableByDefault` | **机器级默认** | 新会话出生状态 |
| `_disabled` | 遗留 | 只读，作从未写过的会话的初始值 |

---

## 八、HTTP 路由

前缀 `/plugins/dsh-skill-cards/`，同源校验。

| 方法 | 路由 | 说明 |
|---|---|---|
| GET | `skills?sessionId=` | 技能列表，`enabled` 按会话算 |
| GET | `applied?sessionId=` | 已应用 + 各自 mode + 该会话关闭名单 |
| GET | `default-off` | 新会话默认关闭：开/关 |
| POST | `switch` | 开/关技能（**只改当前会话**） |
| POST | `introduce` | 注册进会话，`mode: turn\|session` |
| POST | `revoke` | 从会话移除 |
| POST | `default-off` | 写默认关闭偏好 |

---

## 九、部署

**工作区就是 DSH 加载的那份**（profile symlink 已指向工作区）。

```
C:\deepseek-harness\0.2.0-rc.2\.dsh\profiles\web\node_modules\dsh-skill-cards
  → C:\Users\shuying\Documents\deepseek-harness\default-workspace\dsh-skill-cards-main
```

| 改动位置 | 生效方式 |
|---|---|
| `client/` | 刷新页面 |
| `lib/` | **必须重启 DSH** |

---

## 十、当前状态

- 源码：`lib/index.js` 1513 行、`client/client.js` 4402 行
- 测试：188 用例，186 通过
- 线上 store：`_disableByDefault: true`，12 个会话记录

### 待确认

重启 DSH 后验证：新开会话 → 面板全关 **且** 模型确实看不到。

若仍有问题，用这条命令定位是名单错还是影子错：

```bash
curl "http://127.0.0.1:3080/plugins/dsh-skill-cards/skills?sessionId=<会话id>" | \
  node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);
  console.log('enabled:', j.skills.filter(s=>s.enabled).length, '/', j.skills.length)})"
```

- `enabled: 0/6` + 模型仍能用 → **影子问题**
- `enabled: 6/6` → **名单问题**

---

## 十一、第七轮：两个"反复没修好"的真根因

用户第二次报：「各个会话单独还是会有窜」+「本轮生效仍然不能在会话后撤回」。
上一轮把这两个问题当成**键控没对齐**去修，加了 `canonicalSession`——方向对，但不是主因。

### 11.1 撤不回来：监听器**从来没挂上**

`ActiveSessionTracker` 里写的是：

```js
const agents = service(this.ctx, 'agents')
if (agents && typeof agents.on === 'function') { ... }
```

`agents` 是 `AgentRegistry`，而 `AgentRegistry extends Service`；cordis 的 `Service` **没有 `on()`**。验证：

```
$ node -e "import('./dsh-agent/lib/index.js').then(m=>console.log(typeof m.AgentRegistry.prototype.on))"
undefined
```

所以 `typeof agents.on === 'function'` 恒为假 —— **整块被跳过**，`agent/status → idle` 的释放监听一个都没注册。表现就是：应用了「本轮」，这一轮过了、下一轮过了，标签还在，只有关会话才没。

**改法**：agent 生命周期是 cordis **事件**，要走 `ctx.on`：

```js
this.ctx.on('agent/created',  ({ agent }) => …)   // 重建影子
this.ctx.on('agent/disposed', ({ agent }) => …)   // 清注册表
this.ctx.on('agent/status',   ({ agent, status }) => …)  // running→idle 释放
```

这也顺手修好了第二个隐形问题：`reapplyShadows` 从来没在 `agent/created` 时跑过，所以重启后关闭状态只在**打开面板**那一刻才补上。

> 注意 `agents.on(...)` 不报错只是不生效 —— `typeof` 守卫把 TypeError 变成了静默跳过。这类"假守卫"比直接崩溃更难查。

### 11.2 会话窜：三处"猜会话"

| # | 位置 | 旧行为 | 后果 |
|---|---|---|---|
| 1 | `ActiveSessionTracker.current()` | 回落 `agents.list()[0]` | 取注册顺序第一个 agent，从调用方看是**随机会话**；且 `introduce`/`switch` 会**写**进去，不只是读错 |
| 2 | `/skills`、`/applied` 无 id | 回落全机 `_disabled` | 没碰过开关的会话继承了别人会话的灰色 |
| 3 | 客户端 `store.setSession(id)` | `if (id && …)` 才写 | 切到空白会话时保留旧 id，之后所有请求都指着上一个会话 |

另外 `settings.section` 是 **root 作用域**槽位（没有 `sessionId`），它和输入框**共用一个 store 的 `sessionId` 字段**，谁最后挂载谁说了算 —— 两个界面轮流覆盖。

**改法**：

- 宿主**不再猜**：`current()` 恒返回 `undefined`；三条写路由缺 `sessionId` 一律 **400**；`/applied` 无 id 返回空集 + `noSession: true`；`/skills` 无 id 返回空 `disabled`（不再借旧 `_disabled`）；`/active-session` 恒 `null`。
- 客户端把会话 id 变成**显式 prop**：`SkillsPanel` 接收 `sessionId`，面板内所有请求都用它，不再读共享 store。设置页与输入框各传各的，互不覆盖。
- `setSession(undefined)` 现在是**有效写入**，会清掉旧 id 并清空 chips。

### 11.3 顺带修好：中途应用被自己这一轮吃掉

原来只要看到 `idle` 就释放。但两种 `idle` 不代表"你这一轮结束了"：

- 应用时 agent **已经在跑** —— 这一轮早就读完目录了，它的 `idle` 不该消耗这次应用；
- `maintenance` 阶段（压缩、起标题）也会翻到 `idle`，根本没有回合。

**改法**：`sessionClock` 数 `running` 边沿（harness 装了不变式，禁止同状态重复，所以这个计数是可靠的回合钟）。持有申请时记下当时的钟值，只有**钟走过了**才释放。

### 11.4 测试从"断言源码"改成"驱动真实路由"

新增 [test/host-session-contract.test.mjs](test/host-session-contract.test.mjs)：用假 web server + 假 agents 服务 + **两个活跃会话**，直接跑真实 `apply()` 与真实 HTTP handler，断言：

- 缺 id 的写请求 → 400，且**没有**任何会话被写入；
- 指定 A → 只有 A 有注册，B 的 `/applied` 是空；
- 无 id 的 `/applied` → 空 + `noSession`；
- 无 id 的 `/skills` 不继承旧 `_disabled`，而**具名**会话仍继承一次（迁移承诺不变）；
- 中途应用不被本轮 `idle` 消耗，下一轮结束才释放；
- 维护 `idle` 不消耗；
- `agent/disposed` 清掉注册与持有。

这套测试当场抓到一个真 bug：`agent/disposed` 里引用了改名后不存在的 `sessionEpoch`（ReferenceError）。

### 11.5 现状

- 测试：**197 用例全过**（含把两个 Windows 路径断言改成跨平台写法）
- 之前"改动前就存在"的 2 个失败已不存在 —— 它们是测试自己硬编码 POSIX 路径，不是代码 bug
- `lib/` 改动**必须重启 DSH**；`client/` 刷新页面即可（源码运行时加载，无需构建）

---

## 十二、第八轮：重启后「面板关着、模型能用」的真根因

第七轮修好了监听器（`ctx.on` 代替 `agents.on`），重启后监听器确实挂上了。但用户报：**重启后原先默认关闭的技能，面板显示关闭，模型却真的能用**。

### 12.1 影子挂在 agent 的 fiber 上，而 agent 会换

影子 provider 注册在 `agent.ctx.get('skills')` 上，是**该 agent 作用域的一个 cordis effect**。所以：

```
agent 卸载 → 该 fiber 卸载 → provider 被 dispose
```

但 `shadows` map 里那条 `state` 还在。于是 `ensureShadowProvider` 看到 `shadows.get(sessionId)` 有值就 `return existing` —— **provider 早就死了，注册这一步被整个跳过**，`fillShadowsSync` 却照样返回"填了 N 个"。

重启时正撞上这个：会话被 resume 成**新 agent**，旧 state 残留在表里。面板读持久化名单 → 全 OFF；模型读真实 registry → 一个影子都没有 → 全部可用。

真实复现（真 cordis + 真 dsh-skill）：

```
fill #1: 1                                        ← 第一次有效
after dispose, shadowedNames still says: ['alpha'] ← 幽灵记录
fill #2 (new agent): 1                             ← 谎报成功
view #2: [["alpha", true]]                         ← 模型实际可用
```

**修法三处**：

1. `state.live` 由 registration 自己的 `control.signal` 驱动 —— cordis dispose 时 abort，这时把 `live=false` 并从 `shadows` 里删掉。**死句柄不可能再被当成健康句柄。**
2. `ensureShadowProvider` 复用条件收紧为 `live && agent 同一个对象`。不同 agent 对象 = 会话被重建，必须在新作用域上重注册。
3. `fillShadowsSync` 改为**替换** `items` 而非累加，并在 provider 不活时返回 `0` 而不是谎报数量。

### 12.2 顺带修掉：改了 items 却不失效缓存

registry 有 `collectCache`。provider **没有重新注册**时，它没有任何理由知道列表变了：

- 把技能重新打开 → `items` 清空 → 缓存仍返回旧的（隐藏）列表 → **面板说开着，模型还看不到**；
- 面板内 `unshadowSkill` 同理。

**修法**：把 `control.invalidate` 存到 state 上，`fillShadowsSync` / `shadowSkill` / `unshadowSkill` 每次改动 items 后显式调用。

> 这个方向和 12.1 相反但同样致命：12.1 是"该看不见却看得见"，12.2 是"该看得见却看不见"。两者都是"面板与模型不一致"。

### 12.3 为什么之前的测试全绿却没抓到

旧 harness 的假 `registerProvider` **从不 dispose**，所以死句柄在假环境里永远是"活"的。假环境测不出生命周期问题。

新增 [test/shadow-liveness.test.mjs](test/shadow-liveness.test.mjs)：**用真实的 `@deepseek-ai/cordis` + 真实 `dsh-skill` 分层**，驱动真实 `fillShadowsSync`，断言：

- agent 被 dispose 后，表里不留幽灵记录；
- 同一会话以**新 agent** 回来时，影子必须真的重新注册，且模型看不到；
- 重新打开技能后影子层必须清空，模型要看得到；
- 影子只作用于自己的 agent，不泄漏到别的会话。

harness 包不可用时这三个用例**跳过**而不是失败，保证裸 checkout 也能跑。

### 12.4 新增只读诊断路由

`GET /plugins/dsh-skill-cards/shadow-state?sessionId=<id>` 一次给出三方对比，避免再靠猜：

```json
{
  "agentLive": true,
  "persistedDisabled": ["dev-expert", "..."],   // 面板信什么
  "shadowed": ["dev-expert", "..."],            // 内存影子层有什么
  "shadowProviderRegistered": true,
  "modelView": [],                              // 模型真的能用的（必须不交集）
  "installed": ["..."]
}
```

判定：`persistedDisabled` 与 `shadowed` 不一致 → 影子层没建；`modelView` 里出现了 `persistedDisabled` 的名字 → 影子没生效。

### 12.5 现状

- 测试：**200 用例全过**（新增 3 个真实分层的生命周期用例）
- `lib/` 改动仍需重启 DSH


---

## 十三、第九轮：按用户要求重定义「本轮」

用户截图 + 明确诉求：

> 对话一轮，技能没有退回。我想可不可以改成，**本轮会话生效发送文本后自动清除，本会话生效的保持不变**。

这正是原本的设计意图，但实现上一直没真正做到。第七轮修好了监听器，第八轮修好了影子生命周期，这轮修的是**释放的判据本身**。

### 13.1 病根：把「有没有发生一轮」交给了事件

之前的规则是"监听 `agent/status` 的 `running → idle`，看到 idle 就放"。两个问题：

1. 本机实测 `agent/status` 没送达 → 一次都不会放 → 截图里的"聊完一轮还在"。
2. 即使用 `sessionClock` 数 `running` 边沿，它**仍然依赖事件**。

**根因是把权威数据当成了通知。** 会话日志里本来就有 `turnBoundary.lastTurn`（`turn/start` 计数），读它就行，不需要任何事件送达。

### 13.2 改法：日志钟为准，事件钟兜底

```
turnNumberOf(ctx, sessionId)   → sessionProjections.stateOf(session,'turnBoundary').lastTurn
releaseSession(sessionId, observedTurn)  → 只有钟「走过了」才释放
```

- `introduce` 记下**申请时的日志钟**；
- `GET /applied` 每次先 `settleTurnHolds()`，再回答；
- `agent/status → idle` 也走同一个 `settleTurnHolds()`（快路径）；
- 投影服务不可用时退回 `sessionClock`（事件钟），保证不因缺投影而永不释放。

**两条独立触发路径，共用一套判据**，任一条送达就能放。

### 13.3 两种作用域的分界（用户要的那条）

| 模式 | 存在哪里 | 何时消失 |
|---|---|---|
| `turn`（本轮） | `pending` + `introduced` | 日志钟推进到下一轮后，下一次 settle |
| `session`（本会话） | **只在 `introduced`**，不进 `pending` | 只有 `/revoke`、关闭、或 agent 卸载 |

因为 `settleTurnHolds` 只处理 `pending`，**session 模式的申请天然不被回合边界碰到** —— 这就是"本会话的保持不变"。

### 13.4 顺手补上：chip 上有作用域标签

原来两种 chip 长得一样，用户没法知道哪个会自己退。现在每个 chip 带「本轮」（琥珀色）/「本会话」（蓝色）标记，来自 `/applied` 的 `modes`。

### 13.5 新增行为测试

`test/host-session-contract.test.mjs` 加三条，全部驱动真实 `apply()` 与真实 HTTP handler：

- **未发送时不丢**：只 poll 不推进日志钟 → 申请仍在（防"刚点就被清"）；
- **发完就清 / 本会话不动**：推进日志钟后，`turn` 消失、`session` 连过三轮仍在；
- **没有投影也能放**：`turnProjection: false` 时靠 `running→idle` 事件钟仍然释放。

### 13.6 现状

- 测试：**203 用例全过**
- `lib/` 需重启 DSH；`client/` 刷新页面即可

---

## 十四、第十轮：撤太快，技能没注入

上一轮把释放判据从"事件"改成"日志钟"，方向对，但**判据不完整**：

> 撤太快了技能都没注入。

### 14.1 为什么

`turnBoundary.lastTurn` 在 **`turn/start` 那一刻**就前进了，而系统提示与技能目录要到回合内部更晚才装配。客户端 700ms 轮询正好撞进这个窗口：

```
turn/start → lastTurn+1        ← 我的判据在这里就满足了
             ↓
（客户端轮询 /applied → 释放 → 注销技能）
             ↓
装配 system prompt / skill catalog  ← 技能已经没了
```

### 14.2 补上第二个必要条件

```
① lastTurn 推进过            消息真的发出了
② openTurnStartSeq === null  那一轮已经结束
```

两条**同时**满足才释放。投影不可读时，② 退化为 `agent.status !== 'running'`（Agent 的 `status` getter 是可靠的，`idle`/`maintenance` 都算不是 running）。

这也顺带修正了另一件事：应用时若回合**已经在跑**，它的目录早就读完了，日志钟推进但 `openTurnStartSeq` 非空 → 不释放；等它结束、钟仍是应用时的值 → 仍不释放；直到下一轮 → 释放。语义正确。

### 14.3 两套刻度不互相比较

`lastTurn`（日志）和 `sessionClock`（事件）是**不同刻度**。之前申请时读不到投影会退到事件钟，结算时投影又可读了，两个数直接比大小 → 误判。

现在：戳不可知就记 `undefined`，`releaseSession` 只在**两边都已知**时才做 `now <= takenAt` 的比较，否则交给"是否在飞行中"这一条决定。**不可知不等于过期**，不能凭猜就撤销。

### 14.4 新增测试（全部驱动真实 apply + 真实 HTTP handler）

| 用例 | 断言 |
|---|---|
| 回合进行中不能撤 | `openTurn` 状态下连轮询两次，`skills` 与 `pending` 都还在 |
| 等结束、不等开始 | `beginTurn + openTurn` 不撤；`endTurn` 后撤 |
| 未发送不能被轮询吃掉 | 无回合时连轮询三次仍在 |
| 无投影时靠事件钟 | `turnProjection:false`，`running→idle` 仍能释放 |

### 14.5 现状

- 测试：**206 用例全过**
- 释放判据：`lastTurn 推进` **且** `无进行中回合`

---

## 十五、第十一轮：「本轮/本会话」改成打标签，发卡才应用

用户要求把两步拆开：

> 当我按本轮或本会话，按钮变成是否发卡，不进入发卡动画，而是给选中卡片打上本轮或本会话标签，标签打上就取消勾选。按下发卡才应用技能。

### 15.1 旧流程的问题

一个按钮同时干三件事：应用技能 → 立刻播发卡动画 → 关闭面板。后果：

- 想给一批卡打「本轮」、另一批打「本会话」，就得按两次、看两次动画，中间还看不清攒了什么；
- 按下去就收不回，没有"再想想"的余地。

### 15.2 新流程

```
勾选卡片
   ↓ 按「应用到本轮」/「应用到本会话」
卡片左下角出现「待发·本轮」/「待发·本会话」虚线标签，勾选清空
   ↓ （可以继续勾下一批，打另一种标签；同一张卡重按会改标签而非重复）
按「发卡 · N」
   ↓ 真正 POST /introduce（按 scope 分组各一次）→ 播发卡动画 → 关面板
```

细节：

| 行为 | 说明 |
|---|---|
| 打标签不发任何请求 | `stageFn` 里没有 `api()` 调用，纯本地状态 |
| 勾选被消费 | 按一下就 `setSelected(new Set())`，符合"标签打上就取消勾选" |
| 同卡重按 = 改标签 | Map 覆盖，一张卡只有一种作用域 |
| 标签可撤 | 点标签本身（虚线按钮）即 `unstage` |
| 混合批次 | 按 scope 分组，每组一次 `/introduce`，各卡保住自己的作用域 |
| 失败卡留着 | 成功的不再显示待发标签；失败的仍带标签，可直接重试 |
| 已生效优先 | 一张卡已在对话里就只显示「本轮/本会话」实心标签，不再显示待发 |

### 15.3 视觉区分

- **待发**：虚线边框 + `待发·本轮` / `待发·本会话`
- **已生效**：实心边框 + `本轮` / `本会话`

虚线 vs 实心 = "还没应用" vs "已经在对话里"。

### 15.4 测试

`client-load` 新增流程用例，断言：

- `stageFn` 内**没有任何 `api()` 调用**（打标签不上网）；
- `stageFn` 记录 scope 且清空勾选；
- 只有 `dealFn` 调 `/introduce`，且 `triggerGacha` 在 `dealFn` 里。

### 15.5 现状

- 测试：**207 用例全过**
- 纯客户端改动 → **刷新页面即可**，无需重启 DSH

---

## 十六、第十二轮：中文工作区下「新会话默认关闭」失效

用户报：

> 在中文文件夹下工作区的默认技能关闭没有实现，英文或符号是正常的。

### 16.1 先证伪：中文路径本身没问题

逐一排除了所有"看起来像中文"的嫌疑点，全部正常：

| 试的 | 结果 |
|---|---|
| `process.cwd()` 在中文目录 | 正常，UTF-8 无误 |
| `scanInstalled` 扫中文 cwd（含空格/#/·） | 正常，项目技能能扫到 |
| `writeStats` / `readStats` 在中文 home 路径 | 正常 |
| 会话 id 拼写（`session-<uuid>`） | 与持久化键一致 |
| `disabledForSession` 纯逻辑 | 正常，中文/ASCII 会话 id 都 seed 出全关 |

所以"中文"不是原因，是**巧合的触发器**。

### 16.2 真根因：在扫描之前就把判定钉死了

`disabledForSession` 是**同步**的，而发现技能是异步的。默认关闭的 seed 需要"当前装了哪些技能"，只能由调用方先扫一遍再 `rememberInstalled()` 告诉它。

而会话**先于**任何 `/skills` 请求被创建。旧代码在这一刻的处理是：

```js
set = new Set(knownSkillNames.size > 0 ? knownSkillNames : readDisabled(stats))
//                                                  ↑ 空集
sessionDisabled.set(sessionId, set)
writeSessionDisabled(home, sessionId, set)   // ← 把空集写成 null，永久判定
```

于是会话在**发现技能之前**就被钉成"无关闭项"（store 里是 `null`），此后 `readSessionDisabled` 永远返回空集 —— 默认关闭对这个会话**永久失效**。

实测作者机器上 **57 个会话里有 14 个被这样钉死**。哪些会中招取决于"首次读取是否抢在扫描之前"，所以表现为"有些工作区行、有些不行"，用户观察到的是中文工作区。

### 16.3 修法：扫描之前不下结论、不落盘

```js
if (knownSkillNames.size === 0) return new Set()   // 临时视图，不写盘、不缓存
set = new Set(knownSkillNames)                      // 有扫描结果才真正 seed
writeSessionDisabled(...)                           // 此时才持久化
```

关键点：**"还不知道" ≠ "什么都没有"**。返回空集只是临时视图，下一次读取（扫描已完成后）会推导出真正的 seed。

### 16.4 存量数据：提供可选修复脚本

`null` 有两种来源，脚本无法区分：

- 旧 bug 钉死的 → 应该重置
- 用户真的把全部开回来 → 必须保留

所以**不自动跑**。新增 [diagnose/reset-pinned-sessions.mjs](diagnose/reset-pinned-sessions.mjs)：

```bash
node diagnose/reset-pinned-sessions.mjs                    # 干跑，列出候选
node diagnose/reset-pinned-sessions.mjs --apply            # 真正重写（自动备份）
node diagnose/reset-pinned-sessions.mjs --apply --keep session-abc
```

### 16.5 顺带修掉：中文技能名被静默丢弃

`isSkillName` 原来是 `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`，**只认 ASCII**。一个名为 `中文技能` 的目录会被直接 `continue` 跳过 —— 面板里完全看不到，也没有任何提示。

改成"只拒绝真正危险的字符"：

| 保留拒绝 | 理由 |
|---|---|
| 路径分隔符 `/` `\` | 名字会拼进 `resourceBase` 路径 |
| 控制字符 `\u0000-\u001f` `\u007f` | 破坏路径与 JSON 键 |
| 双向覆盖 `\u202a-\u202e` `\u2066-\u2069` | 可让两个不同名字显示成一样 |
| 开头 `.` | 隐藏文件 |

非 ASCII（中文、日文、emoji）一律接受。

### 16.6 测试

新增 [test/default-off-seed.test.mjs](test/default-off-seed.test.mjs)（6 条）：

| 用例 | 断言 |
|---|---|
| 扫描前 | 只返回临时空集，**store 里不得出现该会话的行** |
| 扫描后 | 同一会话 seed 出全部技能为关闭，**且此时才落盘** |
| 已有 `null` 记录 | 不回溯改写（尊重既有决定） |
| 默认关闭关着 | 仍用 legacy `_disabled` seed，不需要扫描 |
| 两会话共享一次扫描 | 各自独立 Set，互不影响 |
| 修复脚本 | 默认干跑、必须 `--apply`、自动备份、支持 `--keep` |

`smoke` 补两条：中文/日文/emoji 目录名必须被发现；路径分隔符与控制字符仍被拒绝。

### 16.7 现状

- 测试：**215 用例全过**
- `lib/` 需重启 DSH
