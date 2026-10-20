# Round-6 PR-1.2：Gate-v4 matched-control 与审计一致性修复

- 日期：2026-10-20
- 基线：PR-1.1（`dd6df45` + `23d763a`）之后的 adversarial review（Act 1–5）
- 状态：**已实现并验收**；仍未进入 PR-2..PR-5
- 复跑：`npm run verify`（47）、`npm run stage0`、`npm run stage0:r6`、`npm run stage0:r6:positive`

## 1. 修复映射

| Act | 问题 | 修复 |
| :-: | :-- | :-- |
| 1 | `neutralPlaceholder` 固定 64 词（≈603 字符），长 persona 的 control 臂被截短 | 改为循环填充到**精确长度**；测试 603/604/2000 与长文案的 treatment/control prompt/section 长度相等 |
| 2 | 单 control 失败后跨候选重试；per-candidate controls 被 `meanControl` 平均，配对丢失 | **每个可模拟候选固定 2 个 matched controls**（同一候选的 prompt/section 长度配对）；失败**不重试**；部分 pair 保留用于审计但 gate 对该候选 fail closed；无 cross-candidate 平均 |
| 3 | 3-control low-evidence receipt 被 validator 拒 → compose 记录丢失；receipt/validator 语义不一致；`probed` 死代码 | 放宽 per-candidate `controlCount` 0..4、全局 0..8；candidate receipt 增加 `probed/controlCount/stable`；`admissibilityCode` 枚举校验；`applied ∪ rejected` 必须覆盖全部 candidate；`applied ⊆ admitted`；`stable=true` 时每个 probed candidate 必须 stable；`probed` 由真实 treatment arm 是否执行决定 |
| 4 | `observeOnly` 短路导致默认配置完全不取证 | 改为：observe-only **运行 treatment trials、跳过 controls**（取证但不做 admission/apply）；无 simulable 候选时仍零 child；更新文档与测试 |
| 5 | `createChild`/`sendPrompt` 失败仍标 `applicability:'applied'`；payload/receipt fallback 静默换 ids；Q3 rejected 语义冲突 | `runProbeArm` 返回 `injection:'applied'|'unavailable'|'not-required'`；pre-injection 失败 → trial `unavailable`；`decideComposeV4` 不再静默 fallback，`runComposeDecision` 发现 receipt/payload 不一致时 `onError('gate-receipt-mismatch')` 并拒绝 emit；**CONTRACT R6-5** 明确 Gate-v4 rejection 载荷为 audit-complete（全部 trials），Q3 的 valid-trial/best-id 规则保留给 v3 |

## 2. 验收证据

### 自动化

```
npm run verify → 47/47
npm run typecheck → 0
npm run build → 0
```

新增/更新测试：

- 21：placeholder 603/604/2000 精确长度；长文案两臂长度相等；control 不含 edit；
- 25：两候选 ×（2 controls + 1 treatment）= 6 个 child；首个 control 失败**不重试**、partial pair、gate low-evidence；长短 content 的 controls 不被平均；
- 26：3 controls 的 low-evidence receipt 可被 validator 接受并写出；coverage/ghost/admissibilityCode 深度校验；
- 27：`createChild` 在注入前失败 → trial `valid:false, applicability:'unavailable'`，receipt `probed:false`；
- 22：observeOnly 运行 2 个 treatment child、无 control，trials 为 applied，compose 仍 `observe-only`。

### Live

| 模式 | 结果 |
| :-- | :-- |
| `npm run stage0:r6` | PASS：20 cycles，**0 applied / 20 rejected**，**0 control 子智能体**（候选不可模拟），gate `controlCount=0 && stable=false`，probe 请求 0 |
| `npm run stage0:r6:positive` | PASS：20 cycles，**20/20 applied**，每 cycle **4 controls + 2 trials**（probe 120），gate `controlCount=4 && stable=true`，每 cycle 1 个 canonical persona edit |
| `npm run stage0` | v3 归档复现 20/20（保持） |

## 3. 仍未处理的 Consider（不阻塞 PR-2，但需记录）

- `maxAppliedEdits:2` 在真实 v4 中不可达（只有一个 simulable op：persona-prefix；第二编辑须不同 component，因此测试 17 的 twoAllowed 是构造状态）。
- 无第二可模拟 op；`toolOrder`/`plugins` 只能走 PR-3 离线评估。
- `probe child` 仍无 sandbox；persona 注入仍是 prompt 注入面（`TODO(ROUND2_SANDBOX)`）。
- PROPOSE_SYSTEM 的“registered tool / row present in snapshot”承诺尚未由成员校验执行（PR-3 需传递 composed snapshot 或改写承诺）。
- 结构：`index.ts` ~2.4k 行、`probe-arm` 与 `probeCandidates` 状态机仍可进一步抽离；e2e runner 仍有重复 bootstrap。
- fake server 的 `probePromptCoverage` 尚未被 live runner 断言 control 不含 edit / treatment 含 edit。

## 4. 结论

PR-1.2 关闭了 review 指出的 matched-arm 与 audit 主要缺口：control 现在**按候选配对且长度精确**，失败不会跨候选重试，receipt 与 payload 在 reject 路径一致，observe-only 恢复“只取证”。**PR-2（edit-body sidecar）可以基于此基线继续**；进入 PR-3 前仍需补 sandbox/成员校验与第二可模拟 op。
