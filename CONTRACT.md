# 跨插件契约（第四轮冻结版）

两个插件**不得互相 import**。类型在各自包内声明且结构一致；`src/constants.ts` 两包**逐字节相同**。
第一轮骨架契约、第二轮未被本轮修订项覆盖的内容视为不变。冻结依据：第三轮投喂信息 §一~§四；第四轮增量修订 R4-1~R4-3。

## 1. 事件 schema（第三轮冻结）

```ts
type TokenCostSource = 'measured' | 'estimated'

interface ProbeMetrics {
  completion: boolean
  toolFailures: number
  stepCount: number
  tokenCost: number
  tokenCostSource: TokenCostSource      // Q4
  durationMs: number
}

interface TrialRecord {
  candidateId: string
  candidateType: 'invariant' | 'domain'
  component: string                     // Q1 必填 ∈ COMPONENT_NAMES
  operation: string                     // Q1 必填
  editContentHash: string               // Q1 必填，sha256:<hex>
  valid: boolean
  metrics?: ProbeMetrics                // valid=true 必填；valid=false 必须缺省
  error?: string                        // valid=false 必填，≤200
}

interface ProbeCompletedPayload {
  taskId: string
  baselineMetrics: ProbeMetrics
  trials: TrialRecord[]                 // 1..2，全部 trial 元数据必填
  evidenceSummary: string               // ≤500
  cycleId: string
}

interface AppliedEdit {                 // R3-1
  candidateId: string
  contentHash: string                   // sha256:<hex>，与 Propose 产出一致
  component: string
  operation: string
}

interface ComposeAppliedPayload {
  taskId: string
  cycleId: string
  appliedCandidateIds: string[]
  appliedEdits: AppliedEdit[]           // 与 appliedCandidateIds 一一对应
  appliedComponents: string[]           // 必须等于 appliedEdits 去重后的组件集合
  previousSnapshotRef: string           // 账本锚点；首条为 'none'
  ledgerEntryId: string                 // 与本条账本记录 id 相同
  applyMode: 'pre-step-patch' | 'next-task-ledger' | 'noop-todo'
}

interface ComposeRejectedPayload {
  taskId: string
  cycleId: string
  reason: 'low-evidence' | 'observe-only' | 'cost-limit' | 'compose-not-wired' | 'regression'
  rejectedCandidateIds: string[]        // Q3 必填非空，且每个 id ∈ 同载荷 trials
  baselineMetrics: ProbeMetrics
  trials: TrialRecord[]
}
```

**校验红线**：任一 schema/一致性校验失败 → 不 emit、不写账本、`onError` 上报且不抛出。

- `appliedEdits.length === appliedCandidateIds.length` 且 candidateId 集合相等；
- `appliedEdits.contentHash/component/operation` 直接取自 Propose 的内存候选表，**不得重新计算哈希**；
- `rejectedCandidateIds` 非空且全部出现在同载荷 `trials[].candidateId` 中；
- trial 元数据缺失 → `onError('trial-metadata-incomplete')`，拒绝 `probe/completed`（Q1）。

### Q3 `rejectedCandidateIds` 构造规则

| reason | 契约取值（R4-2 修正） |
| :-- | :-- |
| `regression` | `[best.candidateId]`（score≤0 也取“最不差”候选） |
| `low-evidence` | 所有 `valid:true` trial 的 id；若无 valid trial，则为 **trials 中出现的所有 id** |
| `observe-only` / `cost-limit` / `compose-not-wired` | **trials 中出现的所有 id**（未进入 Probe 的候选不可归因，不得列出） |

> R4-2 已把“预算早停取交集”的实现细化追溯为正式契约；无需再与 `trials` 额外求交。

## 2. `harness2Experience` 只读门面（第二轮签名不变）

```ts
interface Harness2ExperienceFacade {
  readonly ready: boolean
  queryPriors(query: PriorsQuery): PriorsResult
}
interface PriorsResult { priors: ExperienceEntry[]; totalMatched: number }
```

`queryPriors` 契约（Q6 更新过滤步骤）：

1. `ready === false` 或 `failureSignature` 四字段全空 → `{ priors: [], totalMatched: 0 }`；
2. OR 匹配：`toolName`/`errorCode`/`messagePattern` 对 `condition.failurePattern` 做包含匹配，`taskDomain` 相等；
3. `appliedComponents` 过滤：`edit.component ∈ appliedComponents` 的条目剔除（正负一致）；
4. **按 adoption 分流阈值，互不交叉**：
   - `accepted` → 仅保留 `confidence >= minConfidenceToInject`；
   - `rejected` → 仅保留 `confidence >= minNegativeConfidenceToInject`；
5. `totalMatched` = 步骤 4 后的数量（limit 截断前）；
6. 排序：confidence 降序 → `observedIn` 最新 task 插入序降序 → id 字典序；
7. `priors = 排序后前 min(limit, totalMatched)`；`limit` 默认 topK，夹紧到 `min(limit, topKInjection, maxExperienceEntries)`；
8. 同步只读：无 I/O、无 LLM、索引不可变；返回深冻结副本；正负混合返回，由调用方按 `outcome.adoption` 分流。

门面 `Object.freeze`，`Object.keys` 恰为 `['queryPriors','ready']`。

## 3. 经验条目与 confidence v3

```ts
interface ExperienceEntry {
  id: string
  condition: { failurePattern: string; taskDomain?: string; observedIn: string[] }  // 最近 5 个
  edit: { component: string; operation: string; contentHash: string; contentPreview: string }
  outcome: {
    metricDelta: Record<string, number>
    trials: number
    adoption: 'accepted' | 'rejected'
    tokenCostSource: TokenCostSource   // 第三轮新增、第四轮 R4-3 正式冻结
  }
  confidence: number
  migratedFrom?: string                // 第三轮新增、第四轮 R4-3 正式冻结（仅迁移条目）
}
```

冻结公式（Q5）：

```ts
if (trials === 0) return 0                       // 且 trials=0 条目写入前即拒绝
base = adoption === 'accepted' ? 0.6 : 0.5
evidenceFactor = 0.5 + 0.5 * min(1, trials / 3)
repeatFactor = 1 + 0.1 * min(4, samePatternCount)
sourcePenalty = tokenCostSource === 'estimated' ? 0.9 : 1.0
confidence = clamp01(base * evidenceFactor * repeatFactor * sourcePenalty)
```

- 加载文件时按同样公式重算 confidence，不信任文件值；
- `outcome.metricDelta` 由 `probe.baselineMetrics` 与选中 trial 计算，带符号（正=改善），不采信 LLM；
- 两个 trial、measured 的负经验 confidence = `0.5 × 0.8333 = 0.417 ≥ 默认 0.3`，默认可注入（Q6 修复）。

## 4. 账本 v3（Q7）

```ts
interface LedgerEnvelopeV3 {
  version: 'harness2-ledger/v3'
  id: string
  previousSnapshotRef: string | null   // 首条 null
  ledgerEntryId: string                // 与 id 相同
  event: 'propose/failed' | 'probe/completed' | 'compose/applied' | 'compose/rejected'
  payload: ProbeCompletedPayload | ComposeAppliedPayload | ComposeRejectedPayload
  recordedAt: string                   // ISO 8601
}
```

- 只写 v3；append 成功后才 emit；append 失败 → `onError('ledger-append-failed')`、不 emit、不抛出。
- `readLedgerTail` 接受 v2|v3，返回 `{ found, version, id, payload, mappedFromV2? }` 或 `{ found:false }`；
- v2 映射为内存 v3：`appliedEdits: []`、`rejectedCandidateIds: []`、metrics 缺 `tokenCostSource` → `'estimated'`；**不重写 v2 文件**；
- v2 尾记录仍使 `applyMode = 'next-task-ledger'` 可用；
- **R4-1**：`propose/failed` 尾记录可被 `readLedgerTail` 返回，但 `next-task-ledger` 探测通过 `readRevisionAnchor` **跳过**它向前查找最近一条 `compose/applied`/`compose/rejected`。

## 5. Compose 应用路径（第二轮冻结，不变）

`apply` 阶段探测一次并缓存：`pre-step-patch`（防御性探测 `agents.current().applyHarnessPatch`）→ `next-task-ledger`（v2|v3 账本尾可解析）→ `noop-todo`（`TODO(ROUND2_APPLY)`）。
`agent/pre-step` 应用器同步执行：失败清空 pendingPatch、`onError`、仍 `next()`；不 I/O、不 LLM、不写账本。

## 5b. `applyMode` 探测语义裁决（第五轮，已冻结）

```
探测语义裁决（第五轮）：
  applyMode 在 apply() 阶段探测一次并缓存，首次会话因账本不存在
  如实返回 'noop-todo'。此行为为冻结语义，非缺陷。修订链通过账本
  在跨会话间传递（run1 写入 → run2 读取），首次会话内部不应用修订
  是符合“证据积累后再消费”节奏的预期行为。
  不采用“可写即升级”或“首次写入后升级”变体，理由：next-task-ledger 的
  语义是“存在可读的修订源”，不是“存在可写的存储位置”；把不存在的账本
  标记为 next-task-ledger 会制造“声称有修订源但实际为空”的语义遮蔽；
  可变 applyMode 也会让状态难以审计。真实会话证据见 e2e/artifacts/RESULTS.md
  （run1=noop-todo → run2=next-task-ledger，锚点链贯通）。
```

## 6. 组件名（R3-7）

```ts
COMPONENT_NAMES = ['system-prompt','guardrails','memory','tool-guidance','subagents','skills','scripts','plugins']
LEGACY_COMPONENT_MIGRATION = {
  'tool-definitions': 'tool-guidance',
  'tool-policy': 'guardrails',
  'context-assembly': 'system-prompt',
  'experience-memory': 'memory',
  'subagent-composition': 'subagents',
  'workflow-control': 'skills',
  'verification': 'guardrails',
}
```

- 两包 `src/constants.ts` 逐字节相同，禁止跨包 import；
- 加载 EXPERIENCE.md：新名保留；旧名映射并记 `migratedFrom`（写回时保留）；未知名跳过 + `onError('unknown-component', { id, component })`；
- 移除 `workflow-control` 硬编码回退；trials 定位失败 → `onError('trial-locate-failed')` 并跳过。

## 7. 归因规则（R3-1/2/3 + Q2）

- 反射输出必须含 `edit.candidateId`；meta 在来源载荷（`appliedEdits` / `trials`）中定位；
- `edit.contentHash/component/operation` 必须与来源严格相等；不一致 → `onError('reflection-edit-mismatch', { candidateId, expected, actual })`，**拒绝写入**；
- **写入 EXPERIENCE.md 的 edit 字段一律取自来源载荷，反射只提供 condition（evidenceSummary 子串）**；
- 反射不可用时仍写入：edit 取来源事实，condition 回退归一化 evidenceSummary；
- rejected 分支：仅 `regression` 且 `enableNegativeExperience`；对 `rejectedCandidateIds` 每个 id 在 trials 中定位并各写一条负经验；定位失败 → `onError('trial-locate-failed')`；
- `trials === 0` 或选中 trial 缺 metrics → `onError('no-evidence')` / `onError('metric-trial-missing')`，拒绝写入。

## 7b. `propose/failed`（R4-1，第四轮冻结）

```ts
interface ProposeFailedPayload {
  taskId: string
  cycleId: string
  reason: 'llm-error' | 'schema-invalid' | 'hash-mismatch' | 'component-invalid'
  attempts: number              // 固定 2（含重试）
  lastError?: string            // ≤300，已转义
  baselineMetrics?: ProbeMetrics
  recordedAt: string            // ISO 8601，与账本 envelope 一致
}
```

- **task**：Propose 两次失败 → 校验 payload → append 账本（`event: 'propose/failed'`）→ **成功后才 emit**；append 失败 → `onError('ledger-append-failed')`、不 emit、不抛出；**不得**发出空 id 的 `compose/rejected`，同一 `cycleId` 下与 `probe/completed`/`compose/*` 互斥。
- **meta**：只做诊断日志，不提炼经验、不计入正负经验、不参与 confidence、不写 EXPERIENCE.md。
- 失败原因分类：schema 解析/字段问题 → `schema-invalid`；`contentHash` 不匹配 → `hash-mismatch`；未知组件 → `component-invalid`；其余（网络/LLM 异常）→ `llm-error`。

## 8. token 计量（Q4）

- Propose：优先累加 `ctx.llm.stream()` 的 `{type:'usage'}` → measured；否则字符数/4 → estimated；
- Probe/baseline：优先 `ctx.get('tokenMeter').measure(session).totalTokens`（tokenMeter 为可选服务，不加入冻结的静态 inject）→ measured；否则估算 → estimated；
- 同一 `ProbeMetrics` 内 tokenCost 只能来自单一来源，由 `tokenCostSource` 标记；
- meta 的 confidence 对 `estimated` 乘 0.9 惩罚。

## 9. 已知偏差 / 第三轮遗留

1. **`propose/failed` 已作为正式事件冻结（R4-1）**：第三轮“Propose 失败无法发合法拒绝”的冲突以“承认独立终态”解决，原 `TODO(ROUND3_PROPOSE_FAILURE)` 已删除，改为 R4-1 验收项。
2. **早停 `rejectedCandidateIds` 已追溯为正式契约（R4-2）**：取 trials 中出现过的 id。
3. `ExperienceEntry.outcome.tokenCostSource` 与 `migratedFrom` 已作为正式契约字段（R4-3）。
4. `pre-step-patch` 在 dsh 0.2.1 无运行时 API → 环境依赖，保留 `TODO(ROUND2_APPLY)`。
5. Probe 工具沙箱未强制 → 保留 `TODO(ROUND2_SANDBOX)`。
6. profile 安装未执行（第四轮验收）。

## 9b. 已知 P0 缺陷（Stage-0 实测，2026-10-20）

**compose 门禁当前不具备内容辨别力**：在预注册的 Stage-0 实验（20 cycles，真实 headless pipeline）中，NULL edit 与 ADVERSARIAL edit 均被 `compose/applied` 采纳 20/20（100%），且 adversarial 条目进入 `EXPERIENCE.md` 的 accepted 经验。根因：trial 的 `completion` 恒为 true、baseline 恒为 false，且 `decideCompose` 只看 metrics/component，不检查编辑内容。

- 复现：`npm run stage0`；结果 [e2e/stage0/RESULTS.md](e2e/stage0/RESULTS.md)。
- **在第六轮修复 fitness 评估（recovery control arm / placebo 拒绝 / 内容校验）之前，禁止用 COMPOSE 或经验质量作为“自进化有效”的证据**；本次发现不改变已冻结的 confidence 公式与事件 schema，但明确标注其适用性前提。

## 10. 第六轮 PR-1 修订（Gate-v4，已实现）

> 完整设计见 [`docs/round-6-design.md`](docs/round-6-design.md)；实现记录见 [`docs/round-6-pr1.md`](docs/round-6-pr1.md)。

### R6-1（additive 可选字段，已实现）

- `TrialRecord.applicability?: 'applied' | 'unavailable'`；
- `ProbeCompletedPayload.controlMetrics?: ProbeMetrics[]`（最多 4；Gate-v4 要求 2）；
- `ComposeAppliedPayload.gate?` / `ComposeRejectedPayload.gate?`（Gate-v4 receipt，含 candidates 明细、`appliedCandidateIds`、`rejectedCandidateIds`、`reason`）；
- 新增校验器 `validateGateReceipt`；旧 v3 payload 仍然合法。
- PR-1.2：`probe/completed` 新增可选 `controlAssignments?: { candidateId, metrics: ProbeMetrics[] }[]`（per-candidate matched controls，每项 1..2 metrics）；Gate candidate receipt 增加 `probed/controlCount/stable`，全局 `controlCount` 允许 0..8。
- Gate-v4 **要求** `TrialRecord.applicability === 'applied'`（缺失按 `unavailable` fail closed）；空 transcript（无 assistant 输出）trial 无效；`completion` 由 assistant 输出推导，且 completion 回归属于 `regressed`。

### R6-2（gate 语义，已实现）

- Config：`gatePolicy: 'v4' | 'v3'`（默认 **v4**；v3 只用于归档复现）、`controlReplicates`（默认 2）、`maxAppliedEdits`（默认 1）。
- Gate-v4：**admission ≠ certification**。空 control/少于 2/control 不稳定/不可模拟 → `low-evidence` fail closed；不静默回退 v3。
- Deadband：`completion/toolFailures/stepCount` 对 2 个 control 的均值与噪声取死区；**tokenCost 不参与排名**，只做 `≤1.25×control` guard。
- 不可准入候选映射到既有 reason `regression`（不新增 reason union 成员）；`rejectedCandidateIds` 仍与 trials 相交。
- **PR-1.1**：`controlReplicates` 固定为 2；`maxAppliedEdits` 仅 1|2，且第 2 编辑必须不同 component；3+ controls 视为 `low-evidence`；`applicability` 缺失即 `unavailable`；空 transcript trial 无效；Gate receipt 只包含实际 probed 候选，`gate.rejectedCandidateIds` 必须等于 payload 的 `rejectedCandidateIds`。
- 只有 `set-persona-prefix` 可在 probe 内模拟（agent-scoped `systemPrompt.section({name:'deployment:persona-prefix'})`）；其余 canonical 编辑 `applicability:'unavailable'`，留待离线 applier。
- Admissibility 白名单：`system-prompt/set-persona-{prefix,suffix}`、`tool-guidance/set-tool-order`、`plugins/{disable-row,enable-row,set-harness2-config}`；deny lexicon + 变量/形状校验；`FORBIDDEN_CONFIG_KEYS` 禁止 `metricWeights`/`gatePolicy`/路径/模型等自调裁判键。

### 尚未实现的 R6-3/R6-4

- R6-3（meta 只从 evaluations 学习、旧经验 quarantine）留待 PR-5；
- R6-4（edit body / apply / eval sidecars、offline applier）留待 PR-2/PR-3/PR-4。

### R6-5（Gate-v4 rejection 审计语义，PR-1.2）

Gate-v4 的 `compose/rejected.rejectedCandidateIds` 为 **audit-complete**：列出该 cycle 全部 trials 的 candidateId，并与 `gate.rejectedCandidateIds` 完全一致；这与冻结的 Q3（`low-evidence` 取 valid trial ids、`regression` 取 best id）不同——**Q3 规则继续适用于 `gatePolicy: v3`/legacy**，v4 采用本修订。控制候选（non-simulable）仍以 `valid:false, applicability:'unavailable'` 的 trial 形式出现，保证 id 可审计。

## 11. PR-2（edit-body sidecar，已实现）

`compose/applied.appliedEdits` 仍只有 `{candidateId, contentHash, component, operation}`（冻结不变）；编辑正文持久化在内容寻址 sidecar：

- `harness2-edit/v1`：`{schema, contentHash, candidateId, candidateType, component, operation, content, renderer:{kind,hints}, taskId, cycleId, createdAt}`；读取时重算 `sha256(content)`，不匹配 → `onError('edit-body-hash-mismatch')` 并拒绝。
- `candidateId` 必须是 `cand-<16 lowercase hex>`，且必须等于 `cand-` + `sha256("<candidateType>:<component>:<content>")` 前 16 hex（与 Propose 同一推导）；`verifyEditBodies` 同时校验 body 的 candidateId 与待应用 candidate 一致，不一致 → `onError('edit-body-candidate-mismatch')` 并拒绝 apply。
- 路径：`editsDir`（Config，默认空 → `<dirname(resolved ledgerPath)>/edits`）；文件 `<editsDir>/<64 hex>.json`；原子写（tmp→fsync→rename→fsync(dir)），`0o600`，同 hash+content 幂等，不同内容拒绝。
- 时机：Propose 成功后、Probe 之前为所有候选写 body；写失败 → `onError('edit-store-write-failed')`，本 cycle 不 append/emit 任何事件。Compose apply 前用 `verifyEditBodies` 校验 body 存在且 hash 匹配；缺失 → 拒绝 apply，reason `compose-not-wired`。
- 旧 ledger/Stage-0 fixture 无 body → `legacy-no-body`（不阻止 replay，不 backfill）。
- GC：`gcEditBodies({editsDir, ledgerPath, maxAgeMs=7d, now})` 仅删除“过期且未被 `compose/applied.appliedEdits[].contentHash` 引用”的 `*.json`；非法文件名忽略；任何错误 `onError('edit-store-gc-failed')` 不抛出；ledger 缺失时跳过删除；apply() 激活时 best-effort 调用一次。
- 内容寻址意味着**相同候选内容跨 cycle 只产生一个物理文件**；引用计数按 ledger/applied 记录，不是每 cycle 一份。
- 不改 ledger 版本、bus 事件、`AppliedEdit`、`applyMode`、Q1–Q7/R4/R6 冻结项。
