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

## 6. Interrogate 修复（Act 1–5）

| Act | 问题 | 修复 | 证据 |
| :-: | :-- | :-- | :-- |
| 1 | `e2e/stage0` 未 pin v3，默认 v4 会覆盖历史 20/20 证据 | 在 `patchYaml()` 加 `gatePolicy: v3`，`--dump-config` 断言该字段；测试 20 静态校验两个 runner 的 pin | `npm run stage0` 重跑：PASS，NULL/ADV 20/20，v3 复现成立 |
| 2 | 发布包 `files` 漏 `lib/admissibility.*` / `lib/gate-v4.*` | 加入 `files`；测试 20 校验 | `npm pack --dry-run` 现含 4 个新文件 |
| 3 | admissibility 原型链查找：`__proto__`/`constructor` 可绕过，component 会抛错 | 改用 `Object.hasOwn` + Array 校验；补继承键测试 | 测试 16：继承键全部拒绝且不抛；`triggerThreshold` 仍通过 |
| 4 | completion 恒真、regression 漏 completion、空 transcript 有效、applicability 默认 applied | `completion = assistantMessages > 0`；v4 空 transcript trial 置 `valid:false`；control 空 transcript 不产出 metric；`regressed` 加入 completion；`applicability` 缺失即 `unavailable` | 测试 17/17b；live 仍 PASS |
| 5 | 无 v4 正向路径测试；live 全负向，gate 可“永远拒绝”通过 | 新增测试 19（stub v4 cycle：2 controls + persona 注入 + gate receipt + applied）；新增 live positive 臂 `stage0:r6:positive` | 测试 19 PASS；live negative PASS（0 applied / 20 rejected / 2 controls）；live positive PASS（**20/20 applied**、probe 80 = 4/cycle、gate stable/controlCount 2、每 cycle 恰 1 edit） |

同时加固：`stage0:r6` 断言 session exit、每 session 恰 2 条记录、唯一 cycle、gate `controlCount=2 && stable=true`、probe 请求数；失败报告只写 `artifacts/`，不再覆盖 tracked `RESULTS.md`。

**仍未修（review 的 Consider 项，非本次 Act）**：matched control prompt/长度匹配占位、receipt 与 payload 的 rejected 集一致性 + validator 深度、3–4 control 的 mean/stability 一致性、maxAppliedEdits 同 component 语义、judge/budget 键仍可被 `set-harness2-config` 调整、observeOnly 下仍跑 controls、失败诊断日志、persona 注入与沙箱、probe 两次实现/`index.ts` 体量、normalize/raw content。
