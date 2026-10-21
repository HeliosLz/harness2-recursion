# Round-6 整体冻结 / 发布复核

- 日期：2026-10-21
- 复核基线：`2d145bc`（PR-5.1 完成，工作区开始时干净）
- 复核角色：release reviewer（只验证，不新增功能，不改冻结契约）
- **结论：NO-GO**

一句话理由：验证矩阵中 `npm run r6:verify` 在干净树上 exit 1，其“legacy Stage-0 accepted experience is quarantined”断言依赖的 `e2e/stage0/artifacts/EXPERIENCE.md` 已不存在；PR-5 之后 compose 不再写经验，Stage-0 归档产物无法再生该文件，导致冻结复核命令不可复现。其余功能/契约检查通过，但按发布规则任一失败即 NO-GO。

## 1. 验证矩阵（真实执行）

| # | 命令 | 结果 | 关键计数/证据 |
| :-: | :-- | :-: | :-- |
| 1 | `git status --porcelain` | PASS | 开始时空；复核运行后仅 3 个 tracked RESULTS 快照被 PASS 运行刷新 |
| 2 | `git log --oneline -12` | PASS | 12 条提交含 PR-1…PR-5.1；HEAD `2d145bc` |
| 3 | `npm run build` | PASS (0) | task + meta tsc |
| 4 | `npm run typecheck` | PASS (0) | task + meta tsc --noEmit |
| 5 | `npm run verify` | PASS | **52/52**（task 31 + meta 16 + loader 5） |
| 6 | `npm run verify:task` | PASS | **31/31** |
| 7 | `npm run verify:meta` | PASS | **16/16** |
| 8 | `npm run verify:loader` | PASS | **5/5** |
| 9 | `npm run verify:apply` | PASS | **9/9** |
| 10 | `npm run verify:eval` | PASS | **6/6** |
| 11 | `npm run r6:verify` | **FAIL (1)** | `ASSERTION FAILED: legacy Stage-0 accepted experience is quarantined (no evaluation record) {"entries":0,"acceptedWithoutEvaluation":[]}` at `e2e/round6-spike/gate-replay.mjs:326` |
| 12 | `npm run pr3:integration` | PASS | forced-unevaluated + 字节恢复 |
| 13 | `npm run pr4:integration` | PASS | fake 报告拒绝；debug 路径 forced-unevaluated |
| 14 | `npm pack --dry-run --workspace harness2-task-recursion` | PASS | admissibility/gate-v4/probe-arm/edit-store 齐全 |
| 15 | `npm pack --dry-run --workspace harness2-meta-recursion` | PASS | constants/evaluation-verify/index 齐全 |
| 16 | `npm run stage0` | PASS | v3 归档 **20/20 NULL、20/20 ADVERSARIAL，GATE INVALID** |
| 17 | `npm run stage0:r6` | PASS | 20 cycles，**0 applied / 20 rejected**，probe 0，controlCount=0 |
| 18 | `npm run stage0:r6:positive` | PASS | 20 cycles，**20/20 applied**，每 cycle 4 controls + 2 trials，probe 120 |

真实 pipeline 耗时约 6 分钟；stage0/r6 的 PASS 结果已写入对应 RESULTS/artifacts，失败路径未被写成成功结果（stage0-r6 runner 仅在全部检查 PASS 时更新 tracked RESULTS）。

### 阻塞项复现（NO-GO 证据）

```
$ npm run r6:verify
Error: ASSERTION FAILED: legacy Stage-0 accepted experience is quarantined (no evaluation record)
{"entries":0,"acceptedWithoutEvaluation":[]}
    at e2e/round6-spike/gate-replay.mjs:326
exit 1
```

- `e2e/round6-spike/gate-replay.mjs` 默认读取 `e2e/stage0/artifacts/EXPERIENCE.md`。
- 当前 PR-5 语义：`compose/*` 不再写经验，`e2e/stage0/stage0.mjs` 重新运行后不会生成该文件；`ls` 确认 v3 与正/负向 artifacts 均无 `EXPERIENCE.md`。
- 该文件从未被 git 跟踪，因此这是**测试/归档契约与 PR-5 语义不一致**导致的不可复现，不是偶发环境问题。

## 2. 冻结契约审计

| # | 检查项 | 结果 | 证据 |
| :-: | :-- | :-: | :-- |
| 1 | ledger v3 仍 4 事件 union，字段未破坏 | PASS | `CONTRACT.md` §10 R6-1/R6-2；`packages/harness2-task-recursion/src/index.ts` Events；`harness2-ledger/v3` |
| 2 | bus 恰好 4 事件、无新增 | PASS | task/meta `interface Events` 各 4 个；loader smoke 验证 |
| 3 | `AppliedEdit`/`COMPONENT_NAMES`/`applyMode`/confidence v3 未变 | PASS | `CONTRACT.md` §10–15；`scoreConfidence` 保留；`git diff 3118fba..HEAD` 未见字段删除 |
| 4 | 两插件不互相 import；`constants.ts` byte-identical | PASS | 交叉 import grep 为空；两文件 sha256 均 `e81d07ab…f2b3`，`cmp` BYTE_IDENTICAL |
| 5 | 插件导出 namespace-only，无 shadow API | PASS | `import * as` 得到 namespace；`Config/apply/inject` 存在；helper 导出为既有命名空间成员 |
| 6 | `probe/completed` additive 字段；Gate-v4 receipt/validator 一致 | PASS | `controlMetrics/controlAssignments` 可选；`validateGateReceipt` 与 receipt 校验测试 26 |
| 7 | R6-1..R6-6 均有实现状态与测试映射，无过期“尚未实现” | PASS | `CONTRACT.md` §10–15；README/SELF-CHECK 当前段更新到 52/52 |
| 8 | 不调用不存在的上游 API、不自动 apply、不写 desktop、不把 EXPERIENCE 作为 apply 依据 | PASS（有保留） | `applyHarnessPatch` 仅 feature-detect 且 guarded；applier 拒绝 desktop；审计未发现 EXPERIENCE 写入 |
| 9 | applier apply 默认必须 real `--evaluation`；fake 只能 debug env + forced-unevaluated | PASS | `validateEvaluationReport` + `HARNESS2_ALLOW_UNEVALUATED`；PR-4.1 测试 9/9 |
| 10 | meta 不从 compose 写经验；只有 verification 条目进 priors；legacy 默认隔离 | PASS | meta 测试 16/16；`recordApplied/Rejected` 诊断返回 |

## 3. 文档与证据真实性

- 当前 README/SELF-CHECK 顶部状态与命令输出一致：`verify` 52/52、meta 16/16、apply 9/9、eval 6/6。
- 历史章节（PR-2 50/50、PR-3 6/6 等）保留当时数字，属历史记录；若发布前需要“单页当前数字”，以 README §验收与 `docs/round-6-verification.md:83` 为准。**非阻塞**。
- `docs/round-6-design.md` §1.3 仍保留 `TODO(PR-3, composed snapshot)`；这是已记录的残余风险（真实 row/tool membership 未由成员校验），不是“未实现 PR-3 applier”的过期声明。
- `pr4:integration` 明确标注 **fake-matrix / fake-calibration**，不是真实 provider 效能证据；meta 的 verification 测试使用显式 test fixture，也未声称真实 provider 证据。
- stage0 v3 结果明确是 **GATE INVALID / rubber stamp 20/20** 的归档复现，不是生产通过证据。
- stage0/r6 RESULTS 已由本次 PASS 运行刷新；日期 `2026-10-21`、模式与计数与命令输出一致。

## 4. 发布边界

- 远端：`origin` = `git@github.com:HeliosLz/harness2-recursion.git`；本地 `main` **领先 origin/main 16 个提交**；未 push、未 tag、未建 PR。
- `npm pack` 清单：task 含 `admissibility/gate-v4/probe-arm/edit-store`；meta 含 `evaluation-verify/constants`；无缺失模块。
- 无 secrets 文件被跟踪；无 `e2e/*/artifacts` 被 git 跟踪（仅 3 个 RESULTS 快照被跟踪，属项目约定证据）。
- `git status` 在复核开始时干净；复核后仅 RESULTS 快照与新增本文件待提交。

## 5. 残余风险

- `providerClass` 仍是本地自声明，无法密码学证明报告来自真实 provider；hash/统计重算只防篡改。
- real runner 的 token/step 为估计值；未跑付费 provider CI。
- legacy 经验只过滤不迁移；旧文件保留供审计。
- HMR 仅 `hmr-pending-human-confirm`，未验证 live reload；无 child sandbox（persona 注入面）。
- Stage-0 归档产物依赖本地 artifacts；`r6:verify` 的 EXPERIENCE 依赖需要归档/夹具修复后才能复现。
- `applyHarnessPatch` 仅 guarded feature-detect，若上游未来提供 API 需重新审计自动 apply 边界。

## 6. 建议

**NO-GO**。发布前必须解决以下阻塞（不修改冻结契约）：

1. 由 PR-5/5.1 负责人决定 `r6:verify` 的契约：要么提交一个显式 legacy EXPERIENCE 归档夹具（并让 gate-replay 读取它），要么把该断言改为验证“PR-5 后 compose 不再写经验 + 用夹具验证 quarantine”；不得改测试语义来静默通过。
2. 修复后重跑完整矩阵（至少 build/typecheck/verify/r6:verify/pr3/pr4/stage0/r6 正负向）。
3. 其余检查通过后，人工确认 `providerClass` 信任边界与是否接受“fake 仅校准”的发布说明，再执行 push/tag/release。

## 7. 本地提交与远端

- HEAD：`2d145bc`
- 本轮复核产生的提交：本文件 + 3 个 RESULTS 快照刷新（`docs(round6): ...`）
- 本地领先 `origin/main`：**16** 个提交（复核提交前计数）；未 push。
