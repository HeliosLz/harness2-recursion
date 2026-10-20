# Round-6 设计验证（可执行）

验证对象：[`docs/round-6-design.md`](round-6-design.md) 中可被当前机器证伪的部分。所有 spike 只读仓库，产物写入 `e2e/round6-spike/artifacts/`（gitignored）。

## 环境

- dsh `0.2.1-rc.2` 提取运行时：`/tmp/dsh021/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`
- Node `v25.7.0`；仓库 `harness2-recursion`（Stage-0 归档 ledger：`e2e/stage0/artifacts/ledger.jsonl`）

## 1. Gate replay（`node e2e/round6-spike/gate-replay.mjs`）

**结果：PASS，19/19 assertions**（`e2e/round6-spike/artifacts/SPIKE-GATE.json`）

| 检查 | 结果 |
| :-- | :-- |
| 复现 shipped gate：NULL / ADVERSARIAL 采纳 | **20/20、20/20** |
| **v4 admission（admissibility + RCA）** | **0/20、0/20** |
| v4 admissibility 单独拒绝（NULL/ADV） | 0/20、0/20 |
| 重贴标签（合法 op + 恶意文本） | `denied-phrase` 拒绝 |
| token 规则一致性 | `unit:'raw tokens'`、`rankExcludesTokenCost:true`、`tokenGuardRatio:1.25`；+25% token 回归 fixture 被 `tokenGuard` 拒绝 |
| RCA “ablation” | **显式标注 tautological**（归档 ledger 无 control 臂；`control==trial` 只验证算术，不作为 RCA 有效性证据） |
| Gate-B 10:2 配对改善 | `Δ=0.20, p=0.0193` → accept |
| Gate-B 弱效果 4:1 / 有害 1:9 | reject |
| Stage-0 adversarial 经验（无 evaluation 记录） | **被 R6-3 隔离**（hash 命中 acceptedWithoutEvaluation） |

> 注意：Stage-0 归档 ledger 没有 `controlMetrics`，因此 **RCA 的真实 0/20 必须在 `stage0:r6` 的 live 运行中测**；本次 replay 的 admissibility 0/20 是真实的，RCA ablation 已明确降级为算术检查。

## 2. Offline apply spike（`node e2e/round6-spike/run-spike.mjs`）

**结果：PASS，13/13 assertions**（`e2e/round6-spike/artifacts/SPIKE-RESULTS.json`），约 40s。

| 检查 | 结果 |
| :-- | :-- |
| 隔离 headless profile + 官方 `dsh plugin add` 两包 | 成功 |
| 渲染完整 row config 的 `personaPrefix` patch（A） | 写入原子；dump 组合出新值 |
| 下一次启动的模型 wire | 请求体只含 A（不含 B） |
| 渲染 revision B 并原子重写 | dump/wire 只含 B，A 消失 |
| 字节级 rollback | patch hash 恢复到 A；wire 只含 A |
| 仓库隔离 | dirty set 前后不变（spike 不修改仓库） |

## 3. 尚未在本轮验证的部分（诚实标注）

- **live RCA**（2 个真实 control 子智能体）只设计、未实现；`stage0:r6` 是 PR-1 的验收门槛。
- HMR live reload：headless 关闭 HMR，只验证了 restart 路径。
- `toolOrder` / `plugins` 渲染器：只验证 persona 渲染器；`toolOrder` 需要 smoke session 的结论来自跨 candidate 的 recompose spike（judge 已核对 `session-bogus.out`）。
- Gate-B 的 N=40 held-out 批次与真实 provider 成本未运行；fake-provider 只能校准管道。
- 所有 spike 使用 fake provider，**不是效能证据**；它们只证明 gate 修复与离线写入机制可执行。

## 复跑

```bash
node e2e/round6-spike/gate-replay.mjs
node e2e/round6-spike/run-spike.mjs
```

## 4. PR-1 实现后的 live 验收（追加）

`npm run stage0:r6` 在真实 dsh 0.2.1 headless 上跑 20 个 cycle（Gate-v4）：**PASS**

```
probe/completed: 20; compose/applied: 0; compose/rejected: 20
controlMetrics lengths: [2]; bad controls: 0
rejected ids ⊆ trials: true; gate/v4 receipts: 20
inadmissible candidate receipts: 40
elapsed: 116.7s
```

这补上了设计验证中“live RCA 未测”的缺口：每 cycle 都有 2 个真实 recovery control，且 NULL/ADVERSARIAL 0 applied。详见 [`round-6-pr1.md`](round-6-pr1.md) 与 [`e2e/stage0-r6/RESULTS.md`](../e2e/stage0-r6/RESULTS.md)。

## 5. PR-1 review 修复后的 live 复跑（追加）

| 模式 | 命令 | 结果 |
| :-- | :-- | :-- |
| negative | `npm run stage0:r6` | PASS：20 cycles，**0 applied / 20 rejected**，每 cycle 2 controls，gate `controlCount=2 && stable=true` |
| positive | `npm run stage0:r6:positive` | PASS：20 cycles，**20/20 applied**，每 cycle 恰 1 canonical persona edit，probe 80（2 controls + 2 trials） |

这两条把“gate 只会拒绝”的验证缺口补上：positive 臂证明 admissible persona 会经 `systemPrompt.section` 注入、trial 有效并被 applied。

## 6. PR-1.2 修复后复跑（追加）

| 检查 | 结果 |
| :-- | :-- |
| `npm run verify` | **47/47** |
| `npm run stage0`（v3 归档） | PASS，NULL/ADVERSARIAL 20/20（v3 未变） |
| `npm run stage0:r6`（负向） | PASS：0 applied / 20 rejected；候选不可模拟 → **0 probe child**；gate `controlCount=0 && stable=false` |
| `npm run stage0:r6:positive`（正向） | PASS：20/20 applied；**每候选 2 matched controls + 1 treatment**（probe 120）；gate `controlCount=4 && stable=true`；每 cycle 1 edit |

这一轮验证了「per-candidate controls 不被跨候选平均」「失败不重试」「receipt/payload 一致」「observe-only 只取证」。
