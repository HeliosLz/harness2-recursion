# Discussion 提案（草案）：Harness² 双层递归 —— 任务级证据闭环 + Harnessing 级经验沉淀

> 定位：**生态项目提案**（ecosystem project proposal），不是上游 PR。
> 状态：Phase 1 原型已具备可安装形态；本文用于在 dsh 社区 Discussion 收集契约审查与潜在贡献者。

## 1. 问题

Agent 在一个任务里反复失败时，现有 harness 通常只做“重试/换模型”，很少有插件回答三个问题：

1. 失败模式是什么（可结构化、可复现）？
2. 哪种 harness 修改能改善它（候选编辑 + 逐候选隔离验证）？
3. 这次修改/拒绝的因果证据能否沉淀下来，避免编辑器再次提出已被证伪的方案？

## 2. 方案：两个独立插件 + 一条冻结事件契约

| 插件 | 职责 | 关键约束 |
| :-- | :-- | :-- |
| `harness2-task-recursion` | 失败信号 → Propose（LLM 产出双候选）→ Probe（每候选一个隔离子智能体 + 指标）→ Compose 决策 → 账本 v3 → 应用/降级 | 只监听 3 个事件；`agent/pre-step` 内绝不做 I/O/LLM/子智能体；`observeOnly` 默认 true |
| `harness2-meta-recursion` | 消费三类结构化事件 → 事后归因 → `EXPERIENCE.md` → 只读 `harness2Experience` 门面 | 不监听原始会话/工具/LLM 事件；不读用户对话；经验**只供编辑器查询**，不注入执行器上下文 |

两个包**互不 import**，跨插件类型各自声明、结构一致；`src/constants.ts` 两包逐字节相同（八类组件名 + 迁移表）。

### 三个差异点（希望社区重点 review 的部分）

1. **双插件事件契约**：task 只产出 `probe/completed` / `compose/applied` / `compose/rejected` / `propose/failed` 四类结构化事件；meta 只消费它们。事件载荷字段级冻结、发射前严格校验、账本先 append 后 emit；账本写入失败时**不 emit**。
2. **`propose/failed` 是独立终态**：Propose 两次失败 = 没有产生任何可探测候选，这不是“候选被拒绝”。因此它有自己的事件与账本记录，与 `probe/completed`/`compose/*` 在同一 `cycleId` 下**互斥**，meta 对它只做诊断、零写入。我们明确拒绝用“空 id 的 compose/rejected”来表达它。
3. **元知识只改进编辑器，不注入执行器**：经验条目的 `edit` 字段（component/operation/contentHash）**永远取自 task 的事实载荷**，反射 LLM 只能解释 `condition`（且必须被 evidenceSummary 子串约束）；confidence 由冻结公式从证据（trials/metricDelta/adoption/tokenCostSource）重算，不采信 LLM 或文件里的值。这从结构上杜绝“LLM 篡改编辑内容”。

## 3. 可审计性（本提案的核心卖点）

- [`CONTRACT.md`](../CONTRACT.md)：第四轮冻结的全部事件 schema、门面签名、账本 v3、归因规则、迁移映射与已知缺口。
- [`SELF-CHECK.md`](../SELF-CHECK.md)：逐项验收 + 证据文件/测试名，包含独立审计发现与整改记录。
- 测试：`task 15 + meta 14 + loader smoke 5 = 34/34`；两包 `tsc --noEmit` 0 error。
- 真实会话 E2E：隔离 profile 内通过官方 `dsh plugin add` 安装，跑两次 headless 会话；账本 v3、`applyMode` 降级/升级、修订锚点链、token 实际测量、经验条目全部断言（见 [`e2e/README.md`](../e2e/README.md) 与 `e2e/artifacts/RESULTS.md`）。

## 4. 真实的缺口（不隐藏）

| 缺口 | 状态 | 对我们意味着什么 |
| :-- | :-- | :-- |
| `pre-step-patch` 需要**等待 dsh 上游提供**运行时可调用的 `applyHarnessPatch` | **上游依赖，不是本方案未实现**：dsh 0.2.1 尚未提供该 API；受冻结的 `inject` 约束也无法访问 `ctx.subagents` | 在 API 就绪前如实降级到 `next-task-ledger`/`noop-todo`；源码保留 `TODO(ROUND2_APPLY)`，**不伪造 API、不改降级语义** |
| Probe 子智能体工具沙箱 | **上游依赖**：受 `inject` 冻结约束，等待 dsh 提供子智能体工具限制 API；当前 prompt 明确 ADVISORY、结果仅用于行为对比 | 保留 `TODO(ROUND2_SANDBOX)`，API 就绪后接入 |
| 八类组件名与 Harness² 原文对齐 | 当前为 `system-prompt/guardrails/memory/tool-guidance/subagents/skills/scripts/plugins` | 已冻结常量 + 旧名迁移表；等待原文作者/社区确认精确字符串 |

此外，`edit.contentHash` 在 applied/rejected 载荷中可交叉校验；`ExperienceEntry.outcome.tokenCostSource` 是加载重算 confidence 所必需，已纳入冻结 schema。

## 5. 发布形态（Phase 1）

- **原型仓库**：两个独立 package 已具备发布形态（`lib/` + `.d.ts` + `cordis.patch.yml` + `locale/{en,zh}` + `icon.svg`）。
- **npm**：建议包名 `dsh-harness2-task-recursion` / `dsh-harness2-meta-recursion`（发布前移除 `private`、保留 `peerDependencies`），npm keywords 与 GitHub repo topic 使用 `dsh-plugin`。
- **Plugin Directory**：按 dsh 插件目录要求提供 `package.json`、`icon`、`locale` 元数据；不直接向上游提 PR。

## 6. 希望讨论的问题

1. 事件命名与载荷字段是否符合生态惯例（尤其 `propose/failed` 的独立终态设计）？
2. `harness2Experience` 只读门面是否应改用 Cordis `Service` 类导出，还是保持当前 `ctx.provide(frozenFacade)`？
3. 上游是否计划提供运行时 harness patch API 与子智能体工具限制 API？如果有，接口形态是什么？
4. 是否有维护者愿意把本方案纳入 experimental bundles（`dsh-experimental-*`）做联合孵化？
5. 组件名表是否有官方/Harness² 原文的权威清单可以对齐？

## 7. 链接

- 契约：[`CONTRACT.md`](../CONTRACT.md) · 验收：[`SELF-CHECK.md`](../SELF-CHECK.md)
- 真实会话 E2E：[`e2e/README.md`](../e2e/README.md)
- 源码：[`packages/harness2-task-recursion`](../packages/harness2-task-recursion)、[`packages/harness2-meta-recursion`](../packages/harness2-meta-recursion)
