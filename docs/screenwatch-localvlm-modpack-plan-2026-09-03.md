# wxnodus 常驻屏幕分析 · 本地多模态 · Minecraft 式版本与 Mod 整合方案（2026-09-03）

> 输入：① 参考 Mano-P 与 MAA 完善「常驻直播屏幕分析」；② 本地多模态模型支持常驻桌面捕捉分析；③ 参考「我的世界」式版本推出 + 开源 Mod 整合形式更新 wxnodus。
> 方法：先联网取证两项目机制（下文附引用锚点），再与本仓既有实测资产（2937 用例、/computer 工具链、黑洞记忆、审批/证据/急停、/bundle、update 链路）做差距分析，最后给出可落地方案。**机制与语义借鉴、实现一律原创**（AGENTS.md 约束）。

---

## 0. 摘要

一句话：**把 wxnodus 的「一次性桌面操作」升级为「常驻屏幕观察者」**——借鉴 MAA 的「截图→分层识别→声明式任务链→动作→验证」管线与 Mano-P 的「纯视觉驱动、全本地、端侧推理」理念；识别层引入**本地多模态模型（moondream2 via transformers.js）**做分层降级的中间档；产品形态引入 **Minecraft 式版本列车（snapshot/release）+ modpack 整合分发**，让社区以「整合包」形式开源协作。

---

## 1. 参考取证（机制锚点）

| 项目 | 取证事实 | 可借鉴的机制（实现原创） |
|---|---|---|
| [Mano-P](https://github.com/Mininglamp-AI/Mano-P) | 开源 GUI-VLA（视觉-语言-动作）智能体，OSWorld 专用榜 #1（58.2%）；**纯视觉驱动**跨平台 GUI 自动化（不依赖系统 API/无障碍接口）；在 Apple M4 Mac mini/MacBook 或算力棒上**本地运行，数据不出设备**；多步骤任务规划+执行 | ① 纯视觉单模型规划+动作（截图进、动作出）② 端侧推理、隐私红线 ③ 多步任务链执行。⚠ 其模型为 macOS/M 系列定向——Windows CPU 上不可直用，本方案以 moondream2 等价替代 |
| [MAA](https://github.com/MaaAssistantArknights) | 开源游戏助手：**截图 → 识别（OCR + 模板匹配）→ 声明式任务链（task-schema JSON）→ 动作 → 结果验证**；低算力（低端手机可跑）；识别器可插拔分层；失败重试+备选；[任务链 schema](https://github.com/MaaAssistantArknights/blob/083e4338/docs/zh-tw/protocol/task-schema.md) 社区可写 | ① 三层识别分层（模板匹配/OCR/模型，按需降级）② 任务链 JSON 声明式（社区可扩展）③ 帧差跳过+自适应间隔的低资源循环 ④ 结果验证闭环 |
| [moondream2 (Xenova)](https://huggingface.co/Xenova/moondream2) | moondream2 的 **transformers.js（Node.js）移植**——本机 CPU 推理的 1.86B 视觉-语言模型（描述/问答/指物） | wxnodus 已依赖 `@huggingface/transformers`（黑洞向量预热即用其加载器）——同源引入，零新增重依赖 |

> 未取证处明写：Mano-P 的具体模型权重与 Windows 兼容性未实测——本方案不采用其模型，仅采用理念；MAA 任务链细节以官方 schema 文档为锚。

---

## 2. 与既有资产的差距分析（结合前几轮实测结论）

wxnodus 现有（均已实测/代码实证）：`computer_screenshot/observe/click/type/open` + UIA 元素级 + `estop` 急停 + 高影响审批 + 证据链 + 同屏去重（vision-dedup 缓存）+ Windows 原生 OCR（Windows.Media.Ocr）+ 黑洞记忆 + `/eco` 生态探针 + 六档权限选择器。

| 目标能力 | 已有 | 缺口 |
|---|---|---|
| 一次性屏幕操作 | ✅ 完整 | — |
| **常驻循环捕捉**（直播式） | ❌ | 无驻留 watch 循环、无帧差变化检测、无自适应间隔 |
| **模板匹配识别**（MAA 式 UI 元素定位） | ❌ | 只有 OCR/UIA/模型——缺「屏幕坐标级模板匹配」通道 |
| **本地多模态模型** | ⚠️ 被裁撤 | V4 裁撤了 moondream/离线层（legacy 开关仍留）——需按新形态重接（本方案 B） |
| 声明式任务链 | ⚠️ 部分 | /script（会话录制回放）存在，但无「屏幕任务链 JSON」 |
| 社区整合分发 | ⚠️ 部分 | /bundle 打包存在；无 modpack 清单、依赖解析、兼容矩阵 |
| 版本渠道 | ⚠️ 部分 | update 子命令存在但 feed 未配置；无 snapshot/release 双渠道 |

---

## 3. 方案 A：常驻屏幕分析（「直播」观察者）

> 2026-09-03 用户裁决：**捕捉层不用截图轮询，改用实时视频流捕捉**——长时间连续录制 + 场景分段 + 关键帧分析 + 事件触发时可回放证据片段（截图轮询会漏掉瞬时事件，且无回放能力）。

### 3.0 视频捕捉技术选型（Windows 现实，诚实口径）

| 方案 | 机制 | 优缺点 | 决策 |
|---|---|---|---|
| **ffmpeg gdigrab（首选）** | `ffmpeg -f gdigrab -framerate 5-10 -i desktop -f mjpeg pipe:1` → 连续 MJPEG 帧管道进 Node | ✅ 零新增原生依赖（ffmpeg 已在语音/生态链路内探测）· 真视频流 · 可同流出 mp4 证据段；⚠ GDI 抓不到安全窗口/DRM 内容（黑屏）· 默认主屏（多屏需指定） | ✅ P0 采用 |
| WGC（Windows.Graphics.Capture） | Win10+ 现代捕捉 API，低开销、可抓 UWP | 需原生 addon（C++/Rust） | P2 可选升级档 |
| node-screenshots（已有依赖） | GDI 逐帧截图 | 轮询式、高 fps 下 CPU 高 | ❌ 仅作无 ffmpeg 时的诚实降级（标注「帧模式」而非假视频） |

### 3.1 架构（视频流管线——MAA 任务链语义 + Mano-P 纯视觉理念，落 wxnodus 内核）

```
screenStream 服务（kernel/screenStream.ts，常驻）
  ┌─ 捕捉层：ffmpeg gdigrab → MJPEG 管道（5-10fps、分析用低分辨率）
  │     ├─ 帧环缓冲（内存保留最近 60s）——「回放」数据源
  │     └─ 证据段：触发事件时切出最近 N 秒 mp4 落盘（sha256 入审计链）
  ├─ 分段层：帧差/场景切换检测 → 视频分段（复用 domain/computer/segmentReplay.ts
  │     分段语义——「轨迹归纳分段」思想平移至屏幕流）
  ├─ 分析层：关键帧采样（每段首帧+变化峰值帧）→ 分层识别链（3.2）
  │     · 轻量通道逐帧跑（模板匹配/OCR 仅在对关键帧与触发条件）
  │     · 重通道（本地 VLM）按段节流（每段一次，秒级）
  ├─ 反馈层：system.screen.watch 事件（fps/段摘要/置信度/耗时）
  │     · 长时低频：每 N 分钟聚合摘要 → 黑洞记忆吸收（/hole 可召回）
  │     · 瞬时触发：模板命中/OCR 关键词命中 → 即时事件 + 可选动作（走审批/证据/急停）
  └─ 资源护栏：CPU/内存预算超限自动降 fps（10→5→2）；estop 立即停流；
       前台全屏/游戏自动暂停分析层（录制不中断——回放能力保持）
```

### 3.2 分层识别链（新增模板匹配档，MAA 三通道语义——关键帧为输入）

| 档 | 通道 | 用途 | 成本 | 状态 |
|---|---|---|---|---|
| L0 | **模板匹配**（新增 `screenMatch`：OpenCV 式归一化互相关，纯 JS 实现或 wasm-opencv） | 已知 UI 元素/按钮/图标定位（坐标+置信度） | 毫秒级 CPU | 新增 |
| L1 | Windows 原生 OCR（Windows.Media.Ocr） | 屏幕文本抽取 | 百毫秒 | ✅ 已有 |
| L2 | **本地 VLM moondream2**（方案 B） | 屏幕语义描述/「这个窗口在干什么」问答 | 秒级 CPU/GPU | 重接 |
| L3 | 云端 GLM-4V（可选末档，用户显式配 key） | 复杂多步规划 | 网络+密钥 | ✅ 已有 |

降级规则：L2 未装配 → 诚实标注「本地视觉不可用」→ 只出 OCR+模板；**绝不假装理解屏幕**（诚实文化）。

### 3.3 命令面与前端

- `/watch start [--fps 5|10] [--tier l2] [--ring 60s]`（**视频流模式**：ffmpeg gdigrab → 环缓冲 + 分段分析）· `/watch stop` · `/watch status`（fps/环缓冲占用/段数/最近摘要）· `/watch clip [N秒]`（**导出回放证据片段** mp4 → 证据目录 + sha256 入审计链）· `/watch keyframe`（当前关键帧快照分析）· `/watch chain <task-chain.json>`（MAA 式声明任务链：`{triggers:[{match:模板id, then:click|x,y, verify:ocr}]}`）
- 无 ffmpeg 时诚实降级：`/watch start` 报「视频捕捉不可用（ffmpeg 缺失）——降级帧模式？`--frames`」——**绝不把轮询冒充视频**（诚实文化）
- TUI：状态栏 `▣` 旁加 `◉ watch` 徽标（fps + 环缓冲）；运行时面板（OASIS M5 同页）显示分段时间线
- wire：`system.screen.watch` 事件流（frame/segment/trigger/clip 四类）→ 桌面端/IDE 可渲染「直播视图」
- 记忆：段摘要入黑洞（session scope）——配合 `/hole` 实现「搜一下我之前屏幕上那个报错」

### 3.4 安全与隐私（不可妥协）

纯本地（L0-L2 零网络）；动作一律走既有审批/证据/急停；`/watch` 默认**只观测不动作**（动作需显式 `--act` + 任务链）；屏幕内容不进审计链原文（只存摘要+模板命中，防敏感信息落盘——诚实口径写入文档）。

---

## 4. 方案 B：本地多模态模型

### 4.1 选型对比

| 候选 | 推理位置 | 体积/内存 | Windows 成熟度 | 与 wxnodus 契合 |
|---|---|---|---|---|
| **moondream2（Xenova/transformers.js）✅ 推荐** | Node 进程内 CPU（WebGPU 可选） | ~2GB int8 / 1.86B 参数 | ✅ transformers.js 官方支持（已在依赖树） | 与黑洞 embedder 同加载器；零新增服务进程；离线 |
| Ollama + qwen2.5-vl-7b | 独立服务 | 7B/6GB+ | ✅ 但需用户装 Ollama | 引入外部进程依赖，违背「零装配诚实降级」优先原则——作为可选高级档 |
| Windows ML（ONNX） | 系统运行时 | 视模型 | ⚠️ 打包复杂 | 未来 GPU 档候选 |
| GLM-4V（云） | 网络 | 0 | ✅ 已集成 | 保留为 L3 末档（需 key） |

### 4.2 落地要点

`kernel/localVision.ts`：能力探测（`/eco` 已有探测框架）→ 懒加载（首次 /watch 或 computer_observe local 档才下载/加载模型，默认下载到 dataDir/models）→ 结果缓存 + 同屏去重（vision-dedup 复用）→ 失败诚实降级 L1/L0。恢复 V4 裁撤的离线视觉能力但**只用于屏幕观察**（不做全量离线聊天——尊重裁撤裁决）。

---

## 5. 方案 C：Minecraft 式版本与 Mod 整合

### 5.1 版本列车（我的世界 version_manifest 语义）

```
wxnodus-version-manifest.json（官方 feed 根）
  ├─ latest: { snapshot: "4.1.0-snapshot.2026xxxx", release: "4.0.2" }
  └─ versions: [ { id, type: snapshot|release, url, sha256, minNode, compatibleMods: ">=1" } ]
```

- 双渠道：`snapshot`（每周自动构建快照，尝鲜/社区测）· `release`（稳定）；`update --channel snapshot|release` 切换；`--apply` 升级链已有（sha256+回滚）——只需接 manifest。
- 规则：**正式版 = 快照冻结**（Minecraft 快照→正式语义）；快照带构建号，可一键回滚上一快照。

### 5.2 Mod 整合（Forge/Fabric 语义，落在已有 /bundle）

| Minecraft 概念 | wxnodus 对应物 | 状态 |
|---|---|---|
| Mod（jar） | plugin / skill / MCP server | ✅ 已有（沙箱隔离已实测） |
| **Modpack 整合包** | `modpack.json` 清单：`{name, version, targetWxnodus:"4.0.x-4.1.x", mods:[{kind:plugin|skill|mcp, id, version, url|本地路径, sha256}], config:{...}, hooks:...}` | **新增**（/bundle 升级） |
| Forge 兼容矩阵 | targetWxnodus 版本范围 + 启动时逐 mod 校验 + 不兼容诚实标注/禁用（绝不带病加载） | 新增 |
| 整合包安装器 | `/modpack install <url|zip|目录> [--dry-run]`：下载（SSRF 防护已有）→ sha256 → 依赖解析 → staging → 原子落位 → 沙箱加载 → 回滚 | 新增（复用 pluginInstaller 模式） |
| 崩溃隔离 | mod 崩溃仅隔离该 mod（processIsolationSandbox 已有语义） | ✅ |
| 社区分发 | GitHub 仓库/本地目录发布 modpack；`/modpack list/export` | 新增 |

### 5.3 开源节奏

官方仓保持「核心纯净、Mod 外置」：新能力优先以 mod/modpack 形式发布（如屏幕模板库、任务链社区包 `watch-pack-genshin` 式），核心只保协议+运行时——**对应「我的世界」本体与整合包的分工**。

---

## 6. 实施路线图（每步可验收）

| 阶段 | 交付 | 验收 | 状态 |
|---|---|---|---|
| **P0 视频流骨架** | `screenStream`（ffmpeg gdigrab → MJPEG 管道 → 帧环缓冲）+ 场景分段（stderr scene_score）+ L1 OCR 段摘要入黑洞记忆 + `/watch start/stop/status/clip` + wire 事件（system.screen.watch） | ✅ **已落地（2026-09-03 同日）**：契约测试 5/5；真机 gdigrab 6s 实拍（19 帧环缓冲 + 真实 OCR 识别屏幕文本 + mp4 证据 12 帧/4s/60KB/sha256）；无 ffmpeg → FFMPEG_MISSING 诚实报；`/help` 全目录 124 | ✅ |
| P1 | L0 模板匹配通道 + MAA 式任务链 `/watch chain` + 动作闭环（复用审批/证据/急停） | ✅ **代码+测试+真机检测已落地（2026-09-03）**：NCC 纯 JS（积分图 O(1) 统计，σ≈0 语义定义）+ ffmpeg 灰度解码复用；`/watch chain` 声明任务链（模板/阈值/OCR 验证/click·type 动作）；动作经审批桥（allow/deny/session），无桥 fail-closed 仅记录；chain-error 事件不静默吞。真机：同帧自匹配 score=1.0000@(200,150)、跨帧 1.0000。⚠ 真机「审批→真实点击」需用户在场批准后实测（本会话未自动点击） | ✅ |
| P2 | 方案 B：moondream2 本地视觉档（按段节流）+ WGC 捕捉可选升级 | ✅ **P2.1 已落地（2026-09-03）**：`localVision.ts` 懒加载单例（q4 CPU）+ cacheDir 注入 + `WXNODUS_HF_ENDPOINT` 镜像端点 + 诚实失败。⚠ **真机推理环境阻塞（2026-09-04 终判）**：huggingface.co 超时；hf-mirror.com 的 **API 路径 200、模型文件 resolve 路径被网络层拦截**（direct fetch 亦失败——非代码缺陷）；代码路径契约全锁定，网络放行后一条命令补验。**P2.2 已落地（代码+契约）**：screenStream 捕捉后端选择（`ddagrab`=Desktop Duplication API/WGC 同层 ｜`gdigrab`｜`auto` 诚实回落）+ `/watch --backend` + 状态如实呈现——契约 13/13；真机 auto 回落 gdigrab 实测生效（16 帧+mp4 证据）；**ddagrab 真机受本会话 D3D11 设备限制**（原始错误「Selected output not supported」——换含 D3D11 转换的 ffmpeg 构建或原生 addon 可验） | ✅/⚠环境 |
| P3 | 方案 C：version manifest + snapshot/release 双渠道 + `/modpack` 清单/安装/兼容矩阵 | ✅ **全部落地（2026-09-03/04）**：P3b 整合包（`semverRange` 兼容矩阵 + `/modpack install|list|export`：版本门/sha256 防篡改/原子落位回滚/url SSRF——真机 2 组件安装+list+export+不兼容拒绝全通过）；P3a 版本列车（`versionManifest` 严格解析 + `/channel` 双渠道切换持久化 + `fetchLatestRelease` 清单形态 C + cli update/banner 按渠道选版——真机：本地 manifest feed 双渠道渲染、`/channel snapshot` 切换后 update 取 4.1.0-snapshot.20260904）。契约 28 用例 + 全量回归 214 用例绿 | ✅ |
| P4 | 社区化：任务链/模板/modpack 开放仓库 + 文档（MAA 式社区任务链书写指南） | ✅ **已落地（2026-09-04）**：`docs/screenwatch-chain-authoring-guide.md` 社区书写指南（schema 参考/模板制作/阈值标定/动作安全红线/发布安装/提交检查清单——仅凭文档即可提交任务链包）；官方示例 `examples/watch-pack-demo`（chain+templates+modpack+README）；modpack 新增 `watch` 组件类型（任务链包一键安装到 dataDir/watch/packs/<id>）；**dogfood 自证**：按指南流程 dry-run→安装→真实 PNG 模板解码装载链→export 回导全通过（并抓获/修复 PNG 模板头解析真 bug）；216 用例全绿 | ✅ |

### 6.1 P0 实现要点（已落地）

- `src/kernel/screenStream.ts`：MJPEG 帧切分（FFD8…FFD9）、环缓冲（60s 滚动淘汰）、`keyframe()` 采样、`clip()` 环缓冲重封装 mp4 + sha256、场景切换节流（≥2s）；启动判定=**收到真实帧才算成功**（10s 兜底诚实失败）。
- `src/commands/ext/watchCommands.ts`：`/watch` 命令面 + `system.screen.watch` 事件（frame/segment/clip）+ 段关键帧 OCR 摘要入黑洞（`/hole --all` 可召回）。
- 真机踩坑实录（诚实记录）：① spawn 无 shell 时 filter 单引号会被当字面量——comma 用 `\,` 转义；② 多输出标签必须 `-filter_complex`（`-vf` 不产生可 `-map` 的标签）；③ select 链输出需打 `[sc]` 标签。
- 回归：`watch-command.test.ts` 5 用例（假 ffmpeg 视频流夹具）+ 6 文件 172 用例全绿；registry 三表 124=124=124；user-guide 124 条；smoke 5/5。

### 6.2 P1 实现要点（已落地）

- `src/kernel/screenMatch.ts`：`jpegSize`（JPEG 头部维度）、`decodeGray`（ffmpeg 灰度 rawvideo，帧 640 档/模板原生档）、`nccMatch`（纯 JS NCC——积分图 O(1) 局部统计 + stride 采样；σ≈0 平窗/平模板语义定义=1/负相关，绝不 NaN 伪造）、`matchTemplate`/`loadTemplateFile`。
- `watchCommands.ts` 链面：`/watch chain <task-chain.json>`（MAA 式 `{triggers:[{id,template,threshold,verify:{ocr},action:{kind:click|type|none}}]}`）——命中即记录（黑洞 + trigger 事件 + 关键帧证据）；动作 click/type 经 `ctx.gateway.requestApproval`（allow/session/deny），无审批桥 fail-closed 仅记录；坐标映射解码帧→真实屏幕；chain-error 事件（诊断不静默）。
- 测试：`screen-match.test.ts` 7 用例（纯数学契约）+ watch 链面 4 用例（装载/命中/审批 allow·deny/fail-closed/格式校验）——**16/16 全绿**；全量回归 7 文件 **183 用例全绿**。
- 真机（零点击）：真实视频流关键帧解码 → 裁剪 120×80 模板 → 同帧自匹配 `(200,150) score=1.0000`、2s 后跨帧 `1.0000`——REAL_MATCH_OK。
- 踩坑实录：① vi.mock 无法拦截 `createRequire`（源侧曾真实调用 robotjs——已改动态 import 并用 try 回退 vitest 无 default 的 mock 命名空间）；② EventBus 事件包在 `payload`（监听侧解包）；③ 断言失败泄漏流会污染后续测试（try/finally 停流+关库）。

---

## 7. 与既有资产对齐（零重复建设）

复用：captureScreen/UIA/OCR/estop/审批/证据/vision-dedup/黑洞记忆/`/eco` 探测（含 ffmpeg 探测）/transformers.js 依赖/**segmentReplay 分段语义**/pluginInstaller/SSRF 下载/bundle/update 链/`/oasis`（watch 状态进运行时面板）。
新增仅四处：screenStream 视频流服务、screenMatch 模板通道、localVision 档、modpack 清单。

## 8. 风险与不做清单

- **风险（视频流特有）**：gdigrab 抓不到安全窗口/DRM 内容（黑屏——文档明示，不假装）；多屏默认主屏（`--monitor` 选屏）；环缓冲内存预算（60s×10fps×~100KB≈60MB，超限自动降 fps）；证据段磁盘策略（环形滚动+上限，只保留触发票段）；常驻 CPU/内存护栏（超限自动降 fps、estop 立即停流）。
- **风险（通用）**：模板库冷启动（对策：随 modpack 分发社区模板包）；本地模型下载体积（对策：懒加载+可选）。
- **不做**：不照搬 Mano-P 模型（macOS 定向）；不把 L2 本地模型用于通用聊天（尊重 V4 裁撤）；不做云托管模板库（本地/GitHub 分发，市场只收不出）；动作触发默认关闭（先观测后动作）；**无 ffmpeg 时绝不把轮询帧冒充视频流**。

## 9. 引用

- Mano-P：<https://github.com/Mininglamp-AI/Mano-P>（纯视觉 GUI-VLA、端侧本地推理、OSWorld 58.2%）
- MAA 任务链 schema：<https://github.com/MaaAssistantArknights/blob/083e4338/docs/zh-tw/protocol/task-schema.md>
- MAA 管线（DeepWiki）：<https://deepwiki.com/MaaAssistantArknights/MaaAssistantArknights/2.3-resource-update-pipeline>
- moondream2 (Xenova, transformers.js)：<https://huggingface.co/Xenova/moondream2>
