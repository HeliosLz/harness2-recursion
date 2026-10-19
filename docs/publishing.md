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

**命名可用性检查（2026-10-19，本机 npm registry）**：

| 候选包名 | 状态 |
| :-- | :-- |
| `dsh-harness2-task-recursion` | 未被占用（registry 404） |
| `dsh-harness2-meta-recursion` | 未被占用（registry 404） |
| `harness2-task-recursion` / `harness2-meta-recursion` | 未被占用（registry 404） |

> ⚠️ **不可回滚的错误**：`npm publish` 前必须移除两包 `package.json` 的 `"private": true`，并把 `name` 改成上面确认过的名字；一旦把 `private: true` 的包发布流程走错，修复需要改版本重新发布。建议发布前跑一次 `npm pack --dry-run` 检查清单，再 `npm publish --dry-run` 预演。

- [ ] 两个 `package.json` 的 `name` 改为可发布名（`dsh-harness2-task-recursion`、`dsh-harness2-meta-recursion`），并更新 `cordis.patch.yml` 的 `name`、根 README 引用、`e2e/run.mjs` 安装路径。
- [ ] 移除 `"private": true`；确认 `files`、`exports`、`peerDependencies`、`keywords`（含 `dsh-plugin`）齐全。
- [ ] 保留 `icon.svg`、`locale/en.json`、`locale/zh.json`，并确认 `package.json.icon`。
- [ ] 版本从 `0.2.0` 起（与冻结契约轮次对应），后续按语义化版本。

## 3. npm 发布（可选，Phase 1 建议先 GitHub 安装）

```bash
cd packages/harness2-task-recursion && npm publish --access public
cd ../harness2-meta-recursion && npm publish --access public
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

- [ ] 确认 `package.json` 的 `dsh.bundle.patch`、`icon`、`locale.meta.title/description`（en/zh）正确。
- [ ] 打 tag 后按目录要求提交条目；确保 README 的安装命令与包名一致。
- [ ] 在仓库 README 中如实列出“环境依赖缺口”，不要隐藏 TODO。

## 6. 安全与合规

- [ ] 不提交任何真实 API key / 凭据；E2E 使用本地 fake provider（`FAKE_API_KEY=dummy`）。
- [ ] `EXPERIENCE.md`/账本为运行期数据，不进入仓库（`.gitignore`）。
- [ ] 说明插件会写本地文件（账本/经验库）及默认位置（`$DSH_HOME/harness2/`）。
