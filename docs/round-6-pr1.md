# Round-6 PR-1 实现记录：Gate-v4 admission + admissibility + RCA

- 日期：2026-10-20
- 范围：`admissibility` + `Gate-v4` + 恢复对照臂（RCA）+ canonical `PROPOSE_SYSTEM` + 归档 replay/无 control fail-closed 测试 + live `stage0:r6`
- 状态：**已实现、经 adversarial review 修复后验收**；未包含 PR-2（edit-body sidecar）、PR-3（offline applier）、PR-4（Gate-B harness）、PR-5（meta 只从认证学习）

## 1. 代码改动

| 文件 | 内容 |
| :-- | :-- |
| `src/admissibility.ts`（新） | 纯谓词：白名单（persona prefix/suffix、toolOrder、plugins row/config）、deny lexicon、变量/形状校验、`FORBIDDEN_CONFIG_KEYS`、`PERSONA_PREFIX_SECTION` |
| `src/gate-v4.ts`（新） | `evaluateGateV4`：2 个 recovery control、completion/toolFailures/stepCount deadband、token 25% guard（不参与排名）、admissibility + applicability、`maxAppliedEdits`、`GateV4Receipt` |
| `src/index.ts` | Config 新增 `gatePolicy`（默认 v4；v3 仅供归档复现）、`controlReplicates`（默认 2）、`maxAppliedEdits`（默认 1）；`TrialRecord.applicability?`、`ProbeCompletedPayload.controlMetrics?`、compose payload `gate?`；Probe 顺序 C1→T1→T2→C2，persona 编辑在子智能体首请求前通过 agent-scoped `systemPrompt.section({name:'deployment:persona-prefix'})` 注入；v4 下不可模拟编辑返回 `valid:false, error:'edit-not-in-effect'`；`decideCompose` v4 分支；`PROPOSE_SYSTEM` 改为 canonical operations |
| `src/index.ts`（校验器） | 可选字段校验；`validateGateReceipt`；`controlMetrics` ≤4 且逐项 metrics 校验 |
| `test/verify.mjs` | 新增 admissibility（22 断言）、gate-v4（fail-closed/稳定控制/token guard/maxAppliedEdits）、归档 Stage-0 replay（v3 20/20 → v4 0/20，fail closed）；原 v3 行为测试显式加 `gatePolicy:'v3'` |
| `test/fixtures/stage0-ledger.jsonl` | 归档 40 条 v3 记录，作为 replay 回归 fixture |
| `e2e/stage0/stage0.mjs`、`e2e/run.mjs` | 显式 `gatePolicy: v3`，保持历史 harness 的复现语义 |
| `e2e/stage0-r6/run.mjs`（新） | live 验收：20 个真实 headless cycle，NULL/ADVERSARIAL 必须 0 applied |

## 2. Gate-v4 行为（实现与设计的差异）

- **Admission = A(e) ∧ stable controls ∧ ¬regression ∧ applicable**；默认 `maxAppliedEdits:1`。
- **不要求 rank>0**：admission 只筛选“可被物化的候选”，效果认证属于 Gate-B；这与设计 §1.5 一致（避免把 advisory probe 当 fitness）。
- tokenCost **不进入排名**，只做 25% 上限 guard（修复设计评审指出的单位/符号冲突）。
- `controlMetrics` 缺失/少于 2/不稳定 → **fail closed `low-evidence`**；v3 payload 没有 control 时**绝不回退 v3 判定**。
- 不可准入候选按设计映射到冻结 reason `regression`（不新增 reason）；`rejectedCandidateIds` 仍与 trials 相交。
- **仅 `set-persona-prefix` 可在 probe 内模拟**；suffix/`toolOrder`/`plugins` 一律 `applicability:'unavailable'` + `edit-not-in-effect`，进入后续离线队列（PR-3 实现）。
- RCA 使用 2 个真实无编辑子智能体；live 验收证明 20/20 cycle 都带 2 条 control metrics（不再使用 `control=trial` 的 tautology）。

## 3. 验收

### 自动化（`npm run verify`）

```
tests 40, pass 40, fail 0
```

- 任务包测试 21 项；其中归档 replay：**v3 20/20 applied → v4 0/20 applied**，原因全部 `low-evidence`（无 control 的旧 payload fail closed）。
- 两包 `tsc --noEmit` 通过；meta 包仅同步可选字段类型。

### Live `stage0:r6`（`npm run stage0:r6`，真实 dsh 0.2.1 headless）

```
Result: PASS
Cycles: 20 (sessions 20)
probe/completed: 20; compose/applied: 0; compose/rejected: 20
controlMetrics lengths: [2]; bad controls: 0
rejected ids ⊆ trials: true; gate/v4 receipts: 20
inadmissible candidate receipts: 40
fake requests: {main:80, propose:20, probe:40, reflection:20}
elapsed: 116.7s
```

- 每个 session 恰好 1 个 cycle（3× 500 → 触发 → success）；
- 每 cycle 2 个 control 子智能体、2 条 control metrics；
- NULL/ADVERSARIAL 的 candidate receipt 全部 `admissible=false`，0 个 applied；
- 账本为 v3；`probe/completed` 带 `controlMetrics`，`compose/rejected` 带 `gate/v4`。

产物：`e2e/stage0-r6/RESULTS.md`、`e2e/stage0-r6/artifacts/`（gitignored）。

## 4. 已知未完成 / 后续 PR

1. **meta 仍从 `compose/*` 学习**（PR-5）：当前 live 验收中 rejection 会触发 meta reflection；由于 trial 无 metrics，未写入经验。Stage-0 的 adversarial accepted 条目仍存在，尚未 quarantine。
2. **没有离线 applier**（PR-3）：`applicability:'unavailable'` 的候选只被拒绝，尚未进入 `harness2-candidates.jsonl` 队列；edit body 未持久化（PR-2）。
3. **Gate-B 未实现**（PR-4）：admission 不是认证；没有 held-out 批次、inert patch/漂移对照。
4. `set-persona-suffix` 在 probe 内不可模拟（保留名只验证了 prefix）；后续可扩展或继续走离线评估。
5. live 验收使用 fake provider，不是效能证据；`reflection:20` 说明 meta 仍在消费 rejection，PR-5 要改为“只从认证结果学习”。

## 5. 复跑

```bash
npm install && npm run build
npm run verify                 # 37/37
npm run stage0:r6              # live Gate-v4 验收（~2 分钟）
```

## 6. PR-1.1 硬化（interrogate Consider 项）

| 项 | 实现 | 证据 |
| :-- | :-- | :-- |
| Matched control arm | `probe-arm.ts` 提供共享 `buildArmPrompt`/`runProbeArm`；control 用 `neutralPlaceholder(len, cycleId)` 替换 edit body，两臂注册同长度 `deployment:persona-prefix` section；treatment/control prompt 长度严格相等 | 测试 21：两臂 prompt/section 长度相等、control 不含 edit 文本；live positive probe 80 仍 PASS |
| 禁止候选调裁判 | tunable 表只剩 `triggerThreshold/repeatedFailureWindow/cooldownMs/trajectoryWindow`；`controlReplicates` 固定 `Schema.const(2)`；`maxAppliedEdits` 仅 1|2，且第 2 编辑必须不同 component | 测试 16/17：judge/budget 键全部拒绝；3 controls → low-evidence；同 component 只应用 1 个 |
| Receipt/payload 一致 | receipt 只含 `probed` 候选；`rejectedCandidateIds` 与 payload 完全一致；`validateGateReceipt` exact-key + 嵌套/集合/原因一致性校验 | 测试 24：budget early-stop 下 receipt=payload；malformed receipt 被拒 |
| 失败诊断与短路 | `onError('control-failed'/'persona-injection-unavailable'/'empty-transcript'/'probe-arm-timeout')`；observeOnly 或无可模拟候选时跳过 control 子智能体；budget 覆盖每个 control/trial | 测试 22/23：observeOnly 零 child；缺失 systemPrompt/空 transcript 有诊断 |
| normalize/raw | row id 按 raw 校验；toolOrder 名称限制为安全字符；`" session "`/零宽字符不再通过 | 测试 16 |
| Prompt 承诺 | `PROPOSE_SYSTEM` 改为“shape-valid”，真实 row/tool membership 标记 `TODO(PR-3, composed snapshot)` | 源码 + 设计 §1.3 |

**行为变化**：负向 `stage0:r6` 的候选全部不可模拟，因此按设计跳过 control 子智能体（`controlCount=0`, `stable=false`）；正向 `stage0:r6:positive` 的 persona 候选仍产生 2 controls + 2 trials/cycle。

**仍未修（真实风险，留在文档）**：persona 注入 × 无工具沙箱（sandbox 上游 TODO）、`index.ts` 与 e2e harness 的重复、probe 双实现已合并为 `runProbeArm` 但 profile/fake-server runner 仍重复、row/tool 真实 membership（PR-3）、`metricWeights` 仍是 v4-dead config。
