# Phase 1 原型发布清单

本文件用于把当前 workspace 原型整理成对外可发现的 Phase 1 原型仓库（**先 Discussion/仓库曝光，不直接向上游提 PR**）。

## 0. 前置：真实 E2E 已通过

```bash
node e2e/run.mjs     # 需要 0.2.1 CLI 运行时，见 e2e/README.md
```

要求：`e2e/artifacts/RESULTS.md` 显示两次真实会话、4 条 v3 账本、`applyMode` run1=`noop-todo` / run2=`next-task-ledger`、至少 1 条经验。

## 1. 仓库

- [ ] 新建公开仓库（建议名 `harness2-recursion`），保留当前目录结构。
- [ ] 根 `LICENSE`（MIT）、`README.md`、`CONTRACT.md`、`SELF-CHECK.md`、`docs/`、`e2e/`、`packages/` 一并提交。
- [ ] `.gitignore`：`node_modules/`、`e2e/artifacts/`、`e2e/.home/`、`*.log`。
- [ ] GitHub topics：`dsh-plugin`、`deepseek-harness`、`harness2`、`recursion`、`agent-harness`。
- [ ] CI：`npm install && npm run build && npm run typecheck && npm run verify`；E2E 可手动/夜间跑（需要 dsh 0.2.1 CLI 运行时）。

## 2. 包元数据

> 2026-10-21 更新：两个 workspace 包的 npm 分发名已改为 `dsh-harness2-task-recursion` /
> `dsh-harness2-meta-recursion`，`private` 已移除，`cordis.patch.yml` 的 `name` 已切换；
> 插件导出的 `name` 与 row `id` 保持不变。`npm publish --dry-run` 通过，包版本 `0.2.1`。
> **本机 npm 未登录（`npm whoami` → 401），因此实际 publish 尚未执行。**

### 2026-10-21 packaging validation

- `npm run verify` → **52/52**；build/typecheck 0。
- `node e2e/run.mjs` → **PASS**（2 sessions；PR-5 后 EXPERIENCE entries = 0，compose 仅诊断）。
- `npm run stage0` → PASS，v3 归档 20/20。
- `npm run r6:verify` → PASS（13 assertions）。
- `npm run stage0:r6` → PASS（负向 0 applied / 20 rejected）。
- `npm run stage0:r6:positive` → PASS（20/20 applied；4 controls + 2 trials/cycle）。
- `npm pack --dry-run --workspace dsh-harness2-*` 与 `npm publish --dry-run` → PASS，版本 **0.2.1**。
- 实际 publish 阻塞：`npm whoami` 401（未登录）；需要操作者 `npm login` 或配置 granular token。


**命名可用性检查（2026-10-19，本机 npm registry）**：

| 候选包名 | 状态 |
| :-- | :-- |
| `dsh-harness2-task-recursion` | 未被占用（registry 404） |
| `dsh-harness2-meta-recursion` | 未被占用（registry 404） |
| `harness2-task-recursion` / `harness2-meta-recursion` | 未被占用（registry 404） |

> ⚠️ **不可回滚的错误**：`npm publish` 前必须移除两包 `package.json` 的 `"private": true`，并把 `name` 改成上面确认过的名字；一旦把 `private: true` 的包发布流程走错，修复需要改版本重新发布。建议发布前跑一次 `npm pack --dry-run` 检查清单，再 `npm publish --dry-run` 预演。

- [x] 两个 `package.json` 的 `name` 改为可发布名（`dsh-harness2-task-recursion`、`dsh-harness2-meta-recursion`），更新 `cordis.patch.yml` 的 `name`、README 安装说明、e2e 的 package/assertion（目录名保持不变）。
- [x] 移除 `"private": true`；`files`、`exports`、`peerDependencies`、`keywords`（含 `dsh-plugin`）齐全；补充 `license/repository/homepage/bugs/publishConfig`。
- [x] 保留 `icon.svg`、`locale/en.json`、`locale/zh.json`，并确认 `package.json.icon`。
- [x] npm 分发版本定为 `0.2.1`（`v0.2.0` 已作为 Round-6 代码 tag 发布；包名/元数据属于 packaging 变更，避免污染已推送 tag），后续按语义化版本。

## 3. npm 发布（可选，Phase 1 建议先 GitHub 安装）

```bash
# 先登录 npm（本机当前 401，需要操作者执行 `npm login` 或配置 token）
npm whoami
npm publish --dry-run --workspace dsh-harness2-task-recursion
npm publish --dry-run --workspace dsh-harness2-meta-recursion
# 登录后：
npm publish --workspace dsh-harness2-task-recursion --access public
npm publish --workspace dsh-harness2-meta-recursion --access public
```

安装方式二选一：

```bash
dsh plugin --profile <name> add dsh-harness2-task-recursion
dsh plugin --profile <name> add dsh-harness2-meta-recursion
# 或直接 GitHub spec：dsh plugin --profile <name> add github:<user>/harness2-recursion#path:packages/...
```

## 4. Discussion 提案

- [ ] 使用 `docs/discussion-proposal.md` 作为底稿，按目标仓库模板调整标题/标签。
- [ ] 附上：冻结契约摘要、34/34 验证结果、真实 E2E 结果、三项环境缺口（`pre-step-patch`、Probe 沙箱、组件名表原文对齐）。
- [ ] 明确“请求反馈的问题”五条，并说明欢迎契约审查/贡献者。

## 5. Plugin Directory 收录

- [x] 确认 `package.json` 的 `dsh.bundle.patch`、`icon`、`locale.meta.title/description`（en/zh）正确。
- [ ] 打 tag 后按目录要求提交条目；README 安装命令已与 npm 包名一致；**等待 npm publish 后再提交**。
- [ ] 在仓库 README 中如实列出“环境依赖缺口”，不要隐藏 TODO。

## 6. 安全与合规

- [ ] 不提交任何真实 API key / 凭据；E2E 使用本地 fake provider（`FAKE_API_KEY=dummy`）。
- [ ] `EXPERIENCE.md`/账本为运行期数据，不进入仓库（`.gitignore`）。
- [ ] 说明插件会写本地文件（账本/经验库）及默认位置（`$DSH_HOME/harness2/`）。
