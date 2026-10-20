# Round-6 设计：Offline profile-patch 闭环 + compose-gate 修复

- 状态：设计冻结草案（arena 合成，base = candidate-1；grafts 见 `docs/round-6-synthesis.md`）
- 目标版本：`harness2-recursion@0.3.0`
- 前提：**不依赖任何上游 API**（不使用 `applyHarnessPatch`；不新增 dsh 子命令）
- 关联证据：Stage-0 证伪（[`e2e/stage0/RESULTS.md`](../e2e/stage0/RESULTS.md)）、arena 验证（[`docs/round-6-verification.md`](round-6-verification.md)）

## 0. 决定

当前 compose gate 把两个问题混为一谈。Round-6 拆成两层：

1. **Admission（准入，会话内、确定性、≤1ms）**：这个编辑是否*允许*被物化为 profile patch？——候选编辑形状/白名单 + 恢复对照臂（RCA）+ 非回归。
2. **Certification（认证，离线、真实 patch 生效后）**：这个 patch 是否*真的*改善行为？——配对 held-out 批次 + 预注册规则 + 人工审批。

拆分是被证据逼出来的：probe 子智能体是 ADVISORY 回放（`task/index.ts:1245-1272`），不执行编辑，trial 指标与编辑内容无关（`e2e/stage0/RESULTS.md:173-174`）。因此**任何 probe-only 谓词都不可能是 fitness**；Round-6 把 fitness 移到“编辑真正生效”的离线批次。

**非目标**：无会话内 mutation；不调用 `applyHarnessPatch`；不新增 bus 事件；不重写 confidence 公式；不自动应用（人工审批）；不覆盖 desktop profile（CLI 拒绝）。

## 1. Gate v4（P0 修复）

### 1.1 根因

`metricsFromTranscript` 硬编码 `completion:true`（`task/index.ts:1301`）；`baselineMetricsOf` 硬编码 `completion:false`（`:909`）；`scoreTrial` 比较它们（`:934-946`）；`decideCompose` 只在 `score>0` 时应用（`:1027`），从不读编辑内容。Stage-0 中 NULL 与 ADVERSARIAL 均 20/20 通过。

### 1.2 每 cycle 的臂

| 臂 | 内容 | 用途 |
| :-- | :-- | :-- |
| **C₁/C₂（恢复对照 RCA）** | 2 个无编辑 probe 子智能体，同 factory/model/timeout/提示骨架；编辑体替换为长度匹配的中性占位（按 `hash(cycleId)` 固定选取） | 量化“不做编辑时恢复/漂移是什么样”；`C̄` 为比较基线，`|C₁−C₂|` 为噪声 |
| **T₁/T₂（treatment）** | 现有 `runTrial`；对 **可模拟编辑**（persona）在子智能体首次请求前用 agent-scoped 机制注入（见 §1.4） | 测量候选 |
| **baselineMetrics** | 失败快照，保留为 payload 事实 | **不参与打分**（不同总体，这是 P0 根因） |

`controlReplicates=2`（默认）。任一 control 缺失/超时/取消 → `low-evidence`（fail closed）。优先级：`observeOnly` → `cost-limit` → `low-evidence` → `regression` → apply。

### 1.3 Admissibility predicate `A(e)`（确定性，无 LLM、无 I/O）

规范化：NFKC、去 `\p{Cf}`、折叠空白。

**渲染器白名单（R6 真正可离线写的目标）：**

| component | operation | artifact | 验证 |
| :-- | :-- | :-- | :-- |
| `system-prompt` | `set-persona-prefix` / `set-persona-suffix` | row `system-prompt`，`config.personaPrefix/personaSuffix` | 形状；`{{cwd}}` 禁用；≤2000 字符 |
| `tool-guidance` | `set-tool-order` | row `system-prompt`，`config.toolOrder` | 仅排列；恰一个 `<unlisted-tools>`；名字已注册；**smoke session 必跑** |
| `plugins` | `disable-row` / `enable-row` | `<row>.disabled` | row 存在；拒绝 `hmr`/`plugin-manager`/`harness2-*`/`system-prompt`/`tools`/`llm`/`session` |
| `plugins` | `set-harness2-config` | `harness2-*.config.<key>` | 键白名单（阈值/冷却/窗口/confidence 阈值类）；**禁止** `metricWeights`、`gateMinDelta`、`placeboMaxDelta`、`observeOnly`、路径、模型、`bodyStorePath` |

`guardrails/memory/subagents/skills/scripts` **没有渲染器** → 不可准入（不伪造 artifact）。

**内容检查（defense-in-depth，不是承重墙）：**

- 拒绝词/模式：`do nothing`、`keep the harness (exactly) as it is`、`ignore (the|all) (task|previous|above|instructions?)`、`reply (only )?(with )?done`、`output only`、`do not (answer|respond|perform)`、`{{cwd}}`。
- persona 形状：`^(You are|The agent|This agent|Act as)\b…`（20–2000 字符）。
- `toolOrder` 必须是 JSON 字符串数组；`plugins` 必须引用 composed dump 中真实存在的 row。
- **允许** `apply/rolled-back` 等旧内容被重新提出，但内容检查 + 后续 Gate-B 会拒绝惰性编辑。

**Propose 侧配套**：`PROPOSE_SYSTEM` 改为只输出上述 canonical `{component, operation, content, contentHash}` 四类（c3 graft），否则模型持续产出不可准入 operation，循环空转。

### 1.4 可模拟性（c2 graft）

仅 `system-prompt` persona 类编辑可在 probe 中真实生效：

```ts
// runTrial: 在 child agent 首次请求之前
child.agent.ctx.get('systemPrompt')?.section({
  name: 'deployment:persona-prefix',   // 系统保留名，同名会 shadow 全局 section
  order: 0,
  text: renderedPersona,
})
```

- `systemPrompt` 服务不存在，或编辑非 persona 类 → `applicability:'unavailable'`，**不做假测量**；该 trial 记 `valid:false, error:'edit-not-in-effect'`，候选被 `low-evidence` 拒绝，并进入**离线候选队列**（`harness2-candidates.jsonl`）。
- 注入成功 → `applicability:'applied'`，trial 才可用于 Gate-A。
- RCA 的 C 臂同样**不注入**；因此 persona 编辑的 `δ` 不再是“被告知 vs 没被告知”的伪差。

### 1.5 打分（gate v4，修正单位不一致）

只对**可模拟 + 已生效**的 trial 打分；`C = C̄`。

```
δ_m   = σ_m · (T_m − C_m)                       # m ∈ {completion, toolFailures, stepCount}；原始单位
ν_m   = max(κ_m, |C₁_m − C₂_m|)                 # κ = (0, 1, 1)
δ̃_m   = δ_m · 1[|δ_m| > ν_m]                    # deadband
rank  = Σ_{m≠tokenCost} w_m · δ̃_m              # rank 只排序，不是阈值
regress = ∃m ≠ tokenCost: δ_m < −ν_m
stable  = completion(C₁)==completion(C₂) ∧ ∀m≠completion: |C₁_m−C₂_m| ≤ κ_m
admit   = A(e) ∧ stable ∧ ¬regress ∧ (trial.applicability === 'applied')
```

**tokenCost 的处理**（修复 arena 指出的符号/单位冲突）：不要把它混进 `rank` 的原始/比例两种单位。改为：

- Gate-A **guard**：`tokenCost(T) ≤ 1.25 × max(tokenCost(C), 1)` 作为 `regress` 的一项（或独立拒绝码 `cost-regression`）；
- Gate-B 再以 paired 中位数做 `≤1.25×` 守卫。

`maxAppliedEdits` 默认 **1**（frozen 允许 1..2，取 1 保证归因/回滚原子性；配置可调到 2，但不推荐）。

### 1.6 结果映射与 Stage-0 回归

- NULL：`A(e)` 失败（`operation-not-allowlisted` / `component-not-renderable` / `denied-phrase`），即使 bypass admissibility，RCA 下 `δ̃=0` → 拒绝。
- ADVERSARIAL：同样被 admissibility 拒绝；若伪装成合法 persona，RCA + `completion` 不可得 → 拒绝。
- 合法编辑：admissible ∧ control stable → 准入；效果由 Gate-B 认证（advisory 上 `δ̃` 可能为 0，**允许**，因为准入不等于认证）。
- **新增回归测试文件**：
  - `gate-v4.replay.test.mjs`：归档 Stage-0 ledger（40 条）上 v3 20/20、v4 admission 0/20；无 control 记录 → fail closed（`low-evidence`），绝不静默回退 v3。
  - `gate-v4.admissibility.test.mjs`：30 例（同形字/零宽/重贴标签/合法）。
  - `stage0:r6`：真实 20 cycles，NULL 0/20、ADVERSARIAL 0/20；外加 **Stage-0 v2 四臂**：①旧 fixture 原样过新 gate → applied 0/20；②重贴标签攻击 → 0/20；③positive control persona → 准入 ≥18/20；④无 control 的 payload → fail closed（`low-evidence`）。**注意**：旧 fixture 的 NULL/ADV 是合法 JSON 提案，不会在 `parseProposal` 被拒；必须在 admissibility 层拒绝——不要把“raw 拒绝”误当 gate 测试。
  - `verify` 增加 `edit-body` 哈希/原子写测试与 `meta` 验证过滤测试。

**RCA 证据声明**：归档 ledger 没有 `controlMetrics`，因此 RCA 的 0/20 **只能在新的 live Stage-0 v2 中测量**；不得用 `control=trial` 的构造当证据（arena 指出该回放是 tautology）。`stage0:r6` 必须真实跑 2 个 control 子智能体。

## 2. 持久化编辑正文（sidecar，不升 ledger 版本）

### 2.1 `harness2-edit/v1`

```json
{"schema":"harness2-edit/v1","contentHash":"sha256:<hex>","candidateId":"cand-…",
 "candidateType":"invariant","component":"system-prompt",
 "operation":"set-persona-prefix","content":"…","renderer":{"kind":"persona-prefix","hints":{}},
 "taskId":"…","cycleId":"…","createdAt":"ISO-8601"}
```

- 路径：`$DSH_HOME/harness2/edits/<sha256hex>.json`（内容寻址，原子写：tmp→fsync→rename→fsync(dir)）。
- 读取时重算 `sha256(content)`；不一致 → `onError('edit-body-hash-mismatch')`，拒绝应用。
- 写顺序：`parseProposal` 后、`probe/completed` 前；正文永远先于引用它的 ledger 记录存在。正文写失败 → `compose-not-wired`，不 append/emit。
- GC：仅当无任何 `compose/applied`/队列引用且 >7 天。
- **ledger 保持 v3、bus 保持 4 事件、`AppliedEdit` 不变**；旧记录/旧 EXPERIENCE 无正文 → `legacy-no-body`，只能审计，不能被 R6 应用或评估。

### 2.2 旧 Stage-0 污染的处置

Stage-0 的 adversarial 条目已以 accepted 写进 `EXPERIENCE.md`。R6 **不重写文件**，在 meta 读取时按“无认证记录”隔离（见 §4.3）。

## 3. Offline apply pipeline

### 3.1 状态机

```
DISCOVERED ─ledger scan─▶ QUEUED ─render+dry-run─▶ RENDERED ─eval─▶ EVAL_PASSED | EVAL_REJECTED
RENDERED|EVAL_PASSED ─▶ REVIEW_PENDING ─approve(human)─▶ APPROVED ─backup+atomic write─▶ PATCHED
PATCHED ─dump diff ok?─▶ VERIFIED ─smoke ok?─▶ COMMITTED
PATCHED|VERIFIED ─failure─▶ ROLLED_BACK (auto)
COMMITTED ─operator/rollback─▶ ROLLED_BACK
```

每次 transition 追加 `apply/journal.jsonl`；非法 transition 退出码 2。**applier 是独立 CLI，不 import 插件源码**；所有 audit 记录写 sidecar journal，不写 ledger（避免扩展冻结的 `LedgerEnvelopeV3.event` union）。

### 3.2 渲染器与写入规则

- 用 `dsh --profile <p> --dump-config` 读取**有效 row 的完整 config**；patch 的 row `config` 是**整体替换**，因此未修改的键必须原样写回。
- 只改目标一个键；`||js` 行拒绝；YAML Document 往返语义不变，否则 `patch-not-round-trippable`。
- 写入 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 的 marker 块（`# >>> harness2:managed rev N`），仅替换本工具管理的块，块外字节不动；默认空文件是 `[]`，不能直接文本 append（会 YAML 错）。
- 原子写：`withFileLock` → `writeFileAtomic`（tmp→fsync→rename→fsync(dir)）→ 读回验证 → 保留 backup。
- **Verification hardening（c2 graft）**：读回后必须断言 dump 输出**不含** `skipping profile bundle`（exit=0 不代表成功）；并跑一次 smoke session（`toolOrder` 未注册工具会在 assembly 失败，而不在 dump 失败）。
- Review token：`sha256(basePatchHash + renderedBytes + contentHash + plan)`；`apply --token` 必须匹配，否则重规划。

### 3.3 路径与状态

```
$DSH_HOME/harness2/
  edits/<hex>.json                 # body
  session.lock                     # task plugin: {pid, startedAt}
  apply/queue/<ledgerId>.json
  apply/revisions/<revId>/{manifest.json, plan.json, backup/, review.md, eval/report.json}
  apply/active.json
  apply/journal.jsonl              # schema harness2-apply/v1
  evaluations.jsonl                # schema harness2-eval/v1（Gate-B 结果）
  hypotheses.jsonl                 # 离线候选队列（非可模拟编辑）
$DSH_HOME/profiles/<profile>/cordis.patch.yml
```

`apply/active.json` = `{revisionId, patchHash, status, candidateId, contentHash, renderer, evaluationId, committedAt}`；meta 读它来决定哪些 component 已生效（seed `appliedComponents`）。

### 3.4 Reload / rollback

- reload：headless 走 **restart（下一次启动）**，记录 `applyPath:'next-session'`；Web profile 有 HMR 时记录 `'hmr-pending-human-confirm'`，**不声称已 live**。
- 不强制重启用户会话。`session.lock` 只是**尽力而为**的 advisory 锁（单 PID，多会话并发时不可靠）；applier 的写入正确性由 `withFileLock(profilePatch, ...)` 保证，跨进程互斥以 patch 文件锁为准。profile-global 写入仍然需要人工 review，这一点不因锁而放宽。
- rollback：`harness2 apply rollback --rev <id>` 恢复 backup 字节并校验 `sha256 === basePatchHash`，追加 journal；meta 在 load 时按 rolled-back 的 contentHash 驱逐已接受经验。

## 4. Evaluation（Gate-B）与 meta 验证门槛

### 4.1 批次

- `e2e/holdout/tasks.jsonl`：36 任务、3 折、hash 锁定 `tasks.lock.json`；每批 12 个，用后退役；任务文本与 proposing session 不相交；`taskDomain:'eval-holdout'` 永不进入 Propose。
- 复用 `e2e/run.mjs` 的 profile 创建/`plugin add`/patch/`--dump-config`/一次性会话逻辑，抽到 `e2e/lib/profile.mjs`；`e2e/eval.mjs` 驱动配对臂。

### 4.2 预注册规则（Gate-B）

每任务四臂（固定顺序、隔离 `DSH_HOME`）：

| 臂 | profile | 用途 |
| :-- | :-- | :-- |
| **C** | 当前 profile | 基线 |
| **R** | 当前 profile byte-identical 重启 | **漂移对照**（C≈R 才可解释） |
| **I** | 形状匹配但无语义内容的 inert patch | **工具阴性对照**（证明评测器不是橡皮章） |
| **T** | canary profile + 候选 patch | 候选 |

接受条件（全部满足）：
`Δ̂ = (b−c)/N ≥ 0.15` ∧ 精确单侧 McNemar `p<0.05` ∧ `median(toolFailures_T) ≤ median(toolFailures_C)+1` ∧ `median(tokenCost_T) ≤ 1.25×median(tokenCost_C)` ∧ 0 mount/schema 失败 ∧ `R` 与 `C` 的差异 ≤2/N（漂移可控）∧ **`I` 未被接受** ∧ **同一批次中 NULL revision 被拒绝**。
否则拒绝；`INCONCLUSIVE` 一律回滚，绝不“pending keep”。

### 4.3 meta 只从认证结果学习（c3 graft，必修）

- `recordApplied` / `recordRejected` 改为 **diagnostic no-op**（保留导出与事件监听，`onError('gate-decision-not-evidence')`），`compose/*` 不再写经验。
- 新增 `recordEvaluation(evaluation)`：`trials = n`（评估任务数）、`adoption = decision`、`metricDelta` 来自配对结果、`observedIn: ["eval:<batch>"]`；confidence 公式不变。
- meta 启动读取 `evaluations.jsonl`；**没有 evaluation 记录的旧条目默认隔离**（`enableLegacyExperience: false`），可从 priors/`totalMatched` 排除；`taskDomain:'eval-holdout'` 的条目也不注入，防泄漏。
- `appliedComponents` 从 `apply/active.json` seed；被 rollback 的 contentHash 驱逐。
- 这直接关闭 Stage-0 的 poisoning 路径：adversarial 条目没有认证记录 → 隔离。

### 4.4 验证（Phase F 已完成，见 `round-6-verification.md`）

1. Gate replay：真实归档 Stage-0 ledger 上，shipped 20/20 → v4 admission **0/20**；无 control 的 payload fail closed。
2. Offline spike：persona patch 写入 → 下一次启动的模型 wire 可见 → 回滚后 byte-exact。
3. Recompose hardening：复制 profile 会 `skipping profile bundle` 但 exit 0；bogus `toolOrder` 通过 dump、在真实 session assembly 失败 → 必须有 smoke session。
4. Meta quarantine 模拟：Stage-0 adversarial 条目无认证记录 → 被默认隔离（不进 priors）。

## 5. 契约修订（提交为 R6-1..R6-4，additive）

| 修订 | 内容 | 冻结面变化 |
| :-- | :-- | :-- |
| **R6-1** | `probe/completed` 可选 `controlMetrics?: ProbeMetrics[]`、`gate?: GateReceipt`；`compose/*` 可选 `gate?`；`TrialRecord` 可选 `applicability?: 'applied'\|'unavailable'` | 全部可选；旧记录仍合法；缺失 control 的新记录 fail closed |
| **R6-2** | Gate-A 规则：baseline 不参与打分；RCA 2 副本；deadband；tokenCost 只做 guard；`maxAppliedEdits` 默认 1；reason union 不变 | 语义修订，事件/字段不变 |
| **R6-3** | meta 不再从 `compose/*` 学；只从 `evaluations.jsonl` 认证记录学；无记录旧条目默认隔离 | 语义修订；`ExperienceEntry`/confidence 不变 |
| **R6-4** | sidecar：`harness2-edit/v1`、`harness2-apply/v1`、`harness2-eval/v1`、`harness2-candidates/v1`；task/meta 配置新增 `applyStatePath`、`editsDir`、`evaluationsPath`、`enableLegacyExperience`、`maxAppliedEdits` | 新增可选文件/配置；ledger v3、bus 4 事件、`AppliedEdit`、组件常量不变 |

明确不改：`LedgerEnvelopeV3`（仍 4 事件）、`AppliedEdit`、confidence v3、`COMPONENT_NAMES`、Q1–Q7/R4 冻结项、`applyMode` 探测语义。

## 6. 文件级改动、工作量、顺序

| 路径 | 改动 | 估算 |
| :-- | :-- | --: |
| `packages/harness2-task-recursion/src/index.ts` | Config 新键；`controlMetrics?`/`gate?`/`applicability?`；`gateV4()`；RCA；Propose canonical spec；body 写；`session.lock` | ~360 LOC |
| `.../src/{admissibility,patch-spec,edit-store,gate-receipt}.ts`（新） | 谓词/规范/正文存储/回执 | ~320 |
| `packages/harness2-meta-recursion/src/index.ts` | `recordEvaluation`；隔离/过滤；applyState seed；rollback 驱逐 | ~140 |
| `tools/harness2-apply/*`（新，独立 CLI） | render/patch/profile/queue/eval/journal/lock/review | ~750 |
| `e2e/lib/profile.mjs`、`e2e/eval.mjs`、`e2e/holdout/*`（新） | 配对评估、预注册 | ~450 |
| `e2e/stage0-v2/*`（新） | 3 臂证伪（raw/well-formed/positive） | ~250 |
| `packages/*/test/verify.mjs`、fixtures | 17 新测试 + 归档 fixture | ~450 |
| `CONTRACT.md`、`SELF-CHECK.md`、`README.md`、`docs/*` | R6 修订 + 记录 | ~150 |

工作量 ≈ **12–15 工程师日**，按可独立交付的 PR 拆分：

1. **PR-1（P0）**：admissibility + gate v4 + RCA + canonical PatchSpec + 归档 replay/无 control fail-closed 测试 —— 先让 `verify` 绿、Stage-0 replay 0/20。
2. **PR-2**：edit-body sidecar + 哈希/原子写/GC；meta 隔离规则（先不改学习路径）。
3. **PR-3**：offline applier（render/plan/preflight/review/write/verify/rollback）+ 3 个非 persona renderer。
4. **PR-4**：Gate-B 评估 harness + 预注册 + 校准/阴性对照；`stage0-v2` 三臂。
5. **PR-5**：meta 验证学习 + 文档 + `0.3.0`。

风险：RCA 使 probe 成本约翻倍（预算前置）；persona 注入依赖 `systemPrompt` 服务存在（缺失则 fail closed → 离线队列）；profile-global 写需人工 gate；`toolOrder` 必须 smoke；Gate-B 需要真实任务集与 provider 预算（fake org 仅作管道/校准）。

## 7. 不做什么

- 不做会话内 mutation（无 `applyHarnessPatch`）。
- 不自动应用；不做 desktop profile 写入（CLI 拒绝）。
- 不重写 ledger 版本 / bus 事件 / confidence 公式。
- 不把 probe 指标当作 fitness；准入 ≠ 认证。
- **meta 不从决策学习**：`compose/*` 只作诊断；只有离线认证（`evaluations.jsonl` / committed revision）才写经验；无认证的旧条目默认隔离。
- 不声称 Stage-0 证明“进化有效”；它只证明旧 gate 无效。
