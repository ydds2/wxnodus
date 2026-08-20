# tests/ 布局约定

> 本页回答「测试放哪、怎么被发现」——取代大规模机械搬移（audit §13.46 序 4 决策：
> 批量移动会连锁破坏 package.json 数十条 test:w*-xx 路径脚本与全部 import 深度，纯外观收益、
> 高回归风险，故以约定文档化替代）。

## 分区

| 目录 | 内容 | 运行方式 |
|---|---|---|
| `tests/unit/` | 纯单元（无 IO） | `npx vitest run tests/unit` |
| `tests/contract/` | 契约（端口/形状断言） | 同上 |
| `tests/integration/` | 集成（真实 DB/进程） | 同上 |
| `tests/failure/` | 故障注入 | 同上 |
| `tests/wave0-8/` | 按 Wave 的验收电池（对应 `npm run test:w*-xx` 脚本——**路径是脚本锚点，移动需同步改脚本**） | `npm run test:w1-01` 等 |
| `tests/regressions/known-failures/` | KF 回归（对应 `npm run test:known-failures` 独立配置） | `npm run test:known-failures` |
| `tests/fixtures/` | 验收机现场构建产物（锁哈希核验，不入库：electron/node_modules、*/bin、*/obj） | `npm run verify:windows-fixtures` |
| `tests/` 根 | 跨分区主题测试（kernel-*、ui-*、cli-*、commands-*） | 全量 `npm test` |

## 规则

1. **新增测试**：先按主题选根目录文件命名（`kernel-`/`ui-`/`cli-`/`commands-` 前缀），跨域明确的才进 `tests/{unit,contract,integration,failure}`。
2. **路径锚点**：`package.json` 的 `test:w*-xx` 脚本引用具体文件——移动测试文件必须同步脚本与 import 深度（`../src/` → `../../src/`）。
3. **fixture 产物**：一律不入库（.gitignore 已覆盖）；现场由 `build-fixtures.ps1` 按 `fixtures.lock.json` 哈希核验重建。
4. **全量门禁**：`npm run ci`（七步聚合）是唯一权威绿判定。
