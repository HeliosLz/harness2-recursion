# Round-6 PR-4：Gate-B offline evaluation + applier enforcement

- 日期：2026-10-21
- 基线：PR-3 + `--help` 修复（`7f17eb0`）；`verify` 50/50、`verify:apply` 7/7
- 状态：**已实现并验收**；未进入 PR-5
- 工具：`tools/harness2-eval/`（独立纯 JS `.mjs`，不 import task/meta 源码）

## 1. 任务集与预注册

- `e2e/holdout/tasks.jsonl`：36 个 `eval-holdout` 任务，3 折 × 12；checker = `stdout-exit`（exit code + success marker）。
- `e2e/holdout/tasks.lock.json`：tasksHash + 数量/折数。
- `e2e/holdout/preregistration.json`：tasksHash、arms C/R/I/T、N=12、seed、providerClass、日期、OEP/v1 阈值（delta≥0.15、p<0.05、toolFailure slack 1、token ratio 1.25、drift≤2、inert/null 必须拒绝）。
- 运行前校验 tasksHash；`preregHash` 写入报告；replay 用当前 prereg 重算，运行后改 prereg 会导致 replay 拒绝。

## 2. 四臂与统计

- 每任务固定顺序 C/R/I/T（报告记录 arms 顺序）：
  - C 当前 profile；R byte-identical 重跑（漂移）；I 形状匹配 inert patch（工具阴性/NULL revision）；T canary + revision patch。
- 成功只取确定性 checker（进程退出 + marker + mount/schema 错误），不采信模型自述。
- 统计：`Δ̂=(b−c)/N`、精确单侧 McNemar；次级中位数（toolFailures、tokenCost）、mount/schema=0、R−C 差异 ≤2/N、I 未被接受（同时作为 NULL revision 检查）。
- verdict：`accept` 需全部满足；数据不完整 → `inconclusive`（**不得 apply**）；否则 `reject`。
- 报告 schema `harness2-eval/v1` 写入 `<editsDir 同级>/eval/<batchId>/report.json` + `runs/runs.jsonl`；`reportHash` 用稳定 key 排序计算。
- `harness2-eval replay --report <file>` 重算统计/schema/hash，不依赖 provider。

## 3. applier 强制 evaluation

- `apply` 新增 `--evaluation <report.json>`；默认必须有 accept 报告。
- 校验：`harness2-eval/v1`、`verdict==='accept'`、revisionId/contentHash/planToken 与 manifest 匹配、reportHash 自校验、preregHash/tasksHash 与仓库注册文件匹配。
- `reject|inconclusive` → `evaluation-rejected`；mismatch → `evaluation-mismatch`；缺报告 → `evaluation-required`。
- `--allow-unevaluated` 降级为**未文档化调试逃生口**：必须 `HARNESS2_ALLOW_UNEVALUATED=1`，否则 `evaluation-force-env-required`；apply journal/active/manifest 记录 `evaluation:'forced-unevaluated'`、`verdict`、`batchId`、`evaluationReportHash:null`。
- 正常路径 journal/active/manifest 记录 `evaluation:'accept'`、`verdict`、`batchId`、`evaluationReportHash`。
- preflight 不要求 evaluation（评估需要候选 patch）；desktop 仍拒绝；不写 EXPERIENCE、不发 bus。

## 4. 测试与验收

- `npm run verify:eval`：**6/6** — 统计边界/精确 McNemar、inert/NULL/不完整数据、预注册与 replay 篡改、accept 报告 schema/reportHash、inert patch 形状、CLI help/unknown。
- `npm run verify:apply`：**8/8** — 新增 evaluation 强制：缺报告、reject、mismatch、forced escape env、accept 写入 journal/manifest/active。
- `npm run verify`：**50/50** 不变。
- `npm run pr4:integration`（合成 fake-matrix）：applier plan→preflight→四臂 eval(report accept)→apply(--evaluation)→verify→rollback，PASS：
  `{ verdict:'accept', b:10, c:0, evaluation:'accept', providerClass:'fake-calibration' }`
- 既有 `pr3:integration`、stage0 v3 20/20、stage0:r6 正/负向继续 PASS（复跑记录见最终报告）。

## 5. 边界与偏差

- **fake-provider 只做工具校准（`fake-calibration`）**，不是真实效能证据；真实 provider 报告才能作为生产 apply 依据。CI 只跑 fake matrix。
- 真实 headless runner 已接线（复制 profile、写 T/I patch、跑任务、checker/stdout/exit 判定），但 token/step 是输出近似估计（headless 无 token meter）；未在 CI 跑付费 provider。
- `I` 臂同时承担“inert tool negative”和“NULL revision”检查（报告 `inert.accepted` / `nullRevisionRejected`），避免额外五臂；文档明确此映射。
- `--allow-unevaluated` 仅为 PR-4 前/调试逃生口；生产路径必须 `--evaluation` accept + preflight + `--yes`。
- 未实现 PR-5 meta 学习迁移；未改 ledger v3/bus/`AppliedEdit`/confidence/Gate-v4。
