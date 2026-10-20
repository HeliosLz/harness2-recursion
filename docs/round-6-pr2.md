# Round-6 PR-2：edit-body 内容寻址 sidecar

- 日期：2026-10-21
- 基线：PR-1.2（`d38c324`，`npm run verify` 47/47）
- 状态：**已实现并验收**；未进入 PR-3/4/5
- 复跑：`npm run verify`（50）、`npm run stage0`、`npm run stage0:r6`、`npm run stage0:r6:positive`

## 1. 实现

- 新增 `packages/harness2-task-recursion/src/edit-store.ts`：
  - `harness2-edit/v1` schema + `validateEditBody`；
  - `resolveEditsDir(editsDir, ledgerPath)`：空 → `<dirname(ledgerPath)>/edits`；非空按 ledgerPath 同规则（绝对原样，相对 → `$DSH_HOME/harness2/`，否则 cwd）；
  - `editBodyPath` 只用 `sha256:<64 hex>` 的 hex 部分拼 `<hex>.json`，拒绝路径穿越；
  - `writeEditBody`：原子写（tmp→fsync(file)→rename→fsync(dir)）、`0o600`、幂等（同内容返回 `written:false`），不同内容拒绝；
  - `readEditBody`：缺失 → `legacy-no-body`，hash 不一致 → `onError('edit-body-hash-mismatch')` + `hash-mismatch`；
  - `verifyEditBodies`：apply 前的存在/hash 校验；
  - `gcEditBodies`：扫描 ledger `compose/applied.appliedEdits[].contentHash` 引用集，仅删除过期且未引用的 hex JSON；错误只上报 `edit-store-gc-failed`；ledger 缺失时跳过删除。
- 接线：
  - Config 新增 `editsDir`（默认 `''`）；
  - `proposeOnce` 成功后、Probe 前为所有候选写 body；写失败 → `onError('edit-store-write-failed')` + `return`（不 append/emit）；
  - `runComposeDecision` apply 前 `verifyEditBodies`；失败 → `onError('edit-body-missing')` + `compose/rejected(reason='compose-not-wired')`，不 apply；
  - `apply()` 激活时 best-effort GC（异步、不阻塞事件）。
- 冻结面不变：ledger v3、bus 4 事件、`AppliedEdit`、`applyMode`、Q1–Q7/R4/R6。

## 2. 测试

任务包新增测试 28/29/30（当前任务包 31 项，总 50/50）：

- **28**：路径派生与绝对路径；body 写入存在、schema、hash、`0o600`；同内容幂等单文件；篡改内容 → `hash-mismatch`；缺失 → `legacy-no-body`；`verifyEditBodies` 存在/缺失。
- **29**：`editsDir` 不可写（父路径是文件）→ cycle 不产生 probe/compose 事件、不写 ledger、`onError('edit-store-write-failed')`。
- **30**：GC 删除过期未引用、保留过期但被 appliedEdits 引用、保留新鲜、忽略非法文件名；ledger 缺失 → `ledgerMissing:true`、不删除、不抛。

## 3. Live 证据

| 模式 | 结果 |
| :-- | :-- |
| `npm run stage0:`（v3 归档） | PASS 20/20，未受 body 写入影响 |
| `npm run stage0:r6`（负向） | PASS：0 applied / 20 rejected；候选不可模拟无 controls；ledger 中 trials 的 2 个唯一 contentHash 均有 body |
| `npm run stage0:r6:positive`（正向） | PASS：20/20 applied；每 cycle 4 controls + 2 trials；2 个唯一 persona body 均存在且 hash 有效 |

### 与任务书预期的偏差（如实记录）

任务书写“positive 后 editsDir 有 40 个 body（2 candidates × 20 cycles）”。**内容寻址下不可满足**：fixture 每 cycle 提议相同内容，文件名为 content hash，因此实际是 **2 个唯一物理文件、40 次写入/引用**。runner 的断言改为“所有 body 内容寻址且 hash 有效；每个 trial/applied hash 都有对应 body”。若必须每 cycle 一个物理文件，需要放弃内容寻址（与设计 §2 冲突），PR-2 未这么做。

## 4. 仍未处理（不阻塞 PR-3）

- persona 注入无 sandbox；row/tool 真实 membership 仍待 PR-3 composed snapshot。
- `maxAppliedEdits:2` 仍不可达（唯一 simulable op 是 persona-prefix）。
- `index.ts` 体量与 probe 状态机抽取；e2e runner 仍重复 bootstrap。
- `gcEditBodies` 在 apply 激活时 best-effort，无后台定时任务；PR-3 applier 可显式调用。
