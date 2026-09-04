# 本机本地视觉模型部署与常驻屏幕分析完整方案（2026-09-04）

> 依据：本机实测硬件画像（2026-09-04 实时采集）+ wxnodus 4.0.2 现状能力清单（git HEAD `1a7ca2e4`，127 命令 / 16 门禁全绿）+ `docs/screenwatch-localvlm-modpack-plan-2026-09-03.md` P2 路线。
> 总原则不变：数据不出机 · 诚实降级（每档失败如实标注，绝不假装理解屏幕）· 契约测试锁定 + 真机证据 · 参考不抄袭。

---

## 0. 现状基线（本机实测）

| 资源 | 实测值 | 对本方案的含义 |
|---|---|---|
| CPU | Ryzen 7 5800H 8C/16T @3.2GHz | ffmpeg 捕捉 + OCR + 主 agent 富余 |
| GPU | **RTX 3060 Laptop 6GB**（当前仅用 386MiB，利用率 0%） | **本地 VLM 主落点——VRAM 完全空闲** |
| RAM | 16GB 总，当前可用 ~3.5GB | 紧张——进程内 CPU 推理只作保底档，不作为常驻主档 |
| 磁盘 | C 盘剩 220GB | 模型资产充裕 |
| 显示 | 存在 GameViewer 虚拟显示适配器 | ddagrab 在虚拟/远程屏不可用（已实测「Selected output not supported」）——物理屏场景待补验（D-a） |
| 网络 | 本会话沙箱：huggingface.co 超时；hf-mirror.com API 200、模型文件路径被拦 | 本机网络放行后一条命令补验（D-b）；Ollama 拉取另备镜像/离线路径（见 §3） |

**wxnodus 现状（已真机验证）**：视频流捕捉（gdigrab 19 帧环缓冲 + mp4 证据）✅ · 场景分段 ✅ · Windows OCR ✅ · NCC 模板匹配（score 1.0000）+ 声明式任务链 ✅ · 云端视觉问答（GLM）✅ · 本地 VLM moondream2 **代码+契约 13/13 就绪、模型未下载** ⚠️ · ddagrab 物理屏未验 ⚠️ · 真实点击闭环需用户在场 ⚠️。

---

## 1. 目标架构：三层识别 + 双层本地 VLM（常驻友好）

```
逐帧（毫秒级）        L0 NCC 模板匹配（纯 JS 积分图） + L1 Windows OCR        [已有 ✅]
场景变化每段一次（秒级） L2a 主档：Ollama + Qwen3-VL-2B（GPU，1–3s）           [本方案接线]
                       L2b 保底：moondream2 进程内 CPU（2–8s）                [已有代码 ✅]
                       L2c 最后兜底：只出 OCR+模板，诚实标注「本地视觉不可用」    [已有 ✅]
低频深度问答（可选）     Qwen2.5-VL-7B-q4 按需手动加载（用完即卸，不常驻）
```

降级链（诚实口径）：**L2a 可用 → L2a；否则 L2b；否则 L2c**——每一级失败都有显式状态与原因，绝不静默。

---

## 2. 模型选型（本机配置下的最终决策）

| 档位 | 模型 | 体积 | 资源落点 | 单次延迟（本机预估） | 决策 |
|---|---|---|---|---|---|
| L2a 主档 | **Qwen3-VL-2B-Instruct**（GGUF q4_K_M，unsloth） | ~2.1GB 下载 | VRAM ~2.5GB（6GB 富余） | 1–3s（GPU） | ✅ 常驻 |
| L2b 保底 | moondream2（Xenova，transformers.js q4） | ~1GB 下载 | RAM ~1.5–2GB | 2–8s（CPU） | ✅ 保底（已接线） |
| 可选升级 | Florence-2 base-ft（0.77B） | ~0.5GB | RAM ~0.5GB | 1–2s（CPU） | 🟡 观察（OCR 更强，二选一） |
| 按需档 | Qwen2.5-VL-7B q4 | ~5.5GB | VRAM ~6GB（顶满） | 3–6s（GPU） | ❌ 不常驻（与桌面合成抢显存） |

---

## 3. 下载与安装配置（本机执行清单）

### 3.1 主档：Ollama + Qwen3-VL-2B

```powershell
# ① 安装 Ollama（winget 或官网 exe；装到默认目录，C 盘 220GB 富余）
winget install Ollama.Ollama
# ② 模型拉取——路径 A（优先，命令最简）
ollama pull qwen3-vl:2b
```

**路径 B（国内网络 / 官方 registry 不通时的离线备选）**——经 hf-mirror 下载 GGUF 后本地导入：

```powershell
# B1. 安装 hf 下载 CLI（或直接网页/迅雷下载单文件）
pip install -U "huggingface_hub[cli]"
# B2. 镜像下载 unsloth 量化版（约 2.1GB）
$env:HF_ENDPOINT = "https://hf-mirror.com"
hf download unsloth/Qwen3-VL-2B-Instruct-1M-GGUF --local-dir D:\models\qwen3-vl-2b --include "*q4_k_m*"
# B3. Modelfile 导入 Ollama
Set-Content -Path Modelfile -Value "FROM D:\models\qwen3-vl-2b\Qwen3-VL-2B-Instruct-1M-Q4_K_M.gguf"
ollama create qwen3-vl-2b-local -f Modelfile
```

**常驻服务配置**（`OLLAMA_*` 环境变量，建议经 `setx` 持久化）：

| 变量 | 建议值 | 理由 |
|---|---|---|
| `OLLAMA_KEEP_ALIVE` | `-1` | 模型常驻 VRAM（6GB 富余，免每次重载 3–5s） |
| `OLLAMA_NUM_PARALLEL` | `1` | 串行应答，避免 VRAM 峰值 |
| `OLLAMA_MAX_LOADED_MODELS` | `1` | 同时只驻一个模型 |
| `OLLAMA_FLASH_ATTENTION` | `1` | 3060 支持，推理提速 |
| `OLLAMA_HOST` | `127.0.0.1`（默认） | 只回环监听（数据不出机红线） |

### 3.2 保底档：moondream2 下载补验（D-b，一条命令）

```powershell
$env:WXNODUS_HF_ENDPOINT = "https://hf-mirror.com"
wxnodus        # 进 TUI
/watch start --tier l2 --vlm moondream   # 首次自动下载 ~1GB 到 dataDir/models/hf（代码已注入 cacheDir）
/watch status                            # 期望：本地视觉已加载（或如实报下载失败原因）
```

### 3.3 磁盘/内存预算

| 项 | 预算 | 说明 |
|---|---|---|
| 模型资产 | ~3.2GB（主+保底） | C 盘 220GB 富余，无压力 |
| VRAM 常驻 | 2.5GB / 6GB | 与桌面合成/浏览器加速共存无忧 |
| RAM 增量 | Ollama 本体 ~0.5GB | **不常驻 moondream2**（+2GB 会挤爆当前 3.5GB 余量）——两档互斥，按降级链择一 |

---

## 4. wxnodus 侧接线改造（约半天 + 契约测试）

### 4.1 代码面

1. **新模块 `src/kernel/ollamaVision.ts`**：`probeOllamaVision()`（GET /api/tags 探活）+ `describeScreenOllama(jpeg)`（POST /api/generate，images base64，`stream:false`，timeout 20s）——诚实失败：连接拒绝/超时/坏响应均 `{ok:false, error}`。
2. **`localVision.ts` 增 L2 后端决策**：`resolveL2Backend()`——按 `settings.watchLocalVlm.backend`（`auto|ollama|moondream|off`）与探活结果走降级链 L2a→L2b→L2c；每级切换记录原因到 /watch status。
3. **`watchCommands.ts`**：`/watch start --tier l2 --vlm auto|ollama|moondream`；`/watch keyframe` 输出标注所用后端（「Ollama qwen3-vl:2b · 1.8s」/「moondream2 · 5.2s」/「本地视觉不可用——仅 OCR」）。
4. **设置白名单**：`src/store/config.ts` SETTINGS_KEYS 增 `watchLocalVlm`（`{backend, ollamaModel, ollamaUrl}`）。
5. **段节流**：L2 保持「每段一次 + 最小间隔 5s」（scene_score 分段已存在）——场景没变不打扰 GPU。

### 4.2 契约测试（tests/watch-local-vlm.test.ts）

- Ollama API mock（vi.mock fetch）：正常/超时/非 200/畸形 JSON/空输出 → 逐态诚实断言；
- 降级链：ollama 不可用 → 自动落 moondream（mock 注入）→ 再落「本地视觉不可用」标注；
- `--vlm off` 强制 L2c；`settings.watchLocalVlm` 白名单无未知键告警。

### 4.3 门禁

typecheck + build + test:all + 全量回归 + registry 审计（/watch 子命令不改变三表计数）。

---

## 5. 真机验收标准（证据锚点，诚实口径）

| # | 验收项 | 判定标准 | 对应补验 |
|---|---|---|---|
| E1 | Ollama 常驻 | `ollama list` 见 qwen3-vl:2b；`nvidia-smi` 显存占用 ~2.5GB | — |
| E2 | 主档描述 | `/watch keyframe --vlm ollama` 输出含后端标记 + 语义正确 + 延迟记录（期望 1–3s） | — |
| E3 | 保底档 | `/watch --vlm moondream` 走通（或如实报下载失败原因并留档） | D-b |
| E4 | 降级链 | 停 Ollama 服务 → keyframe 自动落 L2b/L2c 且状态如实标注；重启 → 自动回 L2a | — |
| E5 | ddagrab | 物理屏 `/watch start --backend ddagrab` 成功出帧；虚拟屏如实回落 gdigrab | D-a |
| E6 | 审批点击 | `/watch chain` 模板命中 → 审批 allow → 真实点击 → OCR 验证 → clip 回放（需你在场） | D-c |
| E7 | 资源账 | 常驻后 RAM 可用 ≥2GB、GPU 利用率峰值 <80%（实测记录入档） | — |

---

## 6. 执行步骤与工时

| 步 | 内容 | 预估 | 出口 |
|---|---|---|---|
| 0 | 基线复核：git 干净 ✓（已核实）+ `npm run ci` 全绿记录 | 0.5h | 基线 hash |
| 1 | Ollama 安装 + 模型下载（§3.1 路径 A/B）+ 常驻配置 + E1 | 0.5h（网络决定） | E1 证据 |
| 2 | moondream2 下载补验（§3.2）+ E3/D-b 留档 | 15min | D-b 证据 |
| 3 | 代码接线（§4.1）+ 契约测试（§4.2）+ 门禁（§4.3） | 半天 | 全绿 |
| 4 | 真机验收 E2/E4/E7 + 文档闭环 + master plan 记录 | 1h | 验收证据 |

**风险与对策**：① Ollama 官方 registry 不通 → 路径 B（hf-mirror GGUF 导入，本机网络若也被拦则留档换网重试，绝不伪造成功）；② RAM 挤爆 → 两档互斥 + MCP 闲置回收（`/mcp idle on 120`）；③ 虚拟屏 ddagrab 不可用 → auto 回落已有实测，物理屏补验 D-a；④ Qwen3-VL-2B 中文/UI 能力符合预期则无需升级 7B（升级触发条件：E2 描述质量不达标）。

---

## 7. 完成后 wxnodus 的能力位置（对比目标形态）

- 达成：**「常驻屏幕观察者」全栈本地化**——捕捉（gdigrab/ddagrab 双后端）+ 识别三层（模板/OCR/VLM）+ 任务链 + 证据链 + GPU 语义理解，数据 100% 不出机；
- 仍不具备（如实）：Mano-P 级端到端视觉规划执行（分层管线路线，非 VLA 单模型）；无人值守自动点击（审批桥是你定的安全边界，维持）；
- 后续演进钩子：Florence-2 换保底档、Qwen3-VL 系列升级、/watch chain 社区任务链分发（modpack 通道已就绪）。

> 证据链：`docs/screenwatch-localvlm-modpack-plan-2026-09-03.md`（P0/P1/P2 路线）· `docs/eval-4.0.2-post-cleanup-2026-09-04.md`（现状评估）· 本机实测（§0 采集记录）· 模型来源：[unsloth/Qwen3-VL-2B-Instruct-1M-GGUF](https://huggingface.co/unsloth/Qwen3-VL-2B-Instruct-1M-GGUF)、[unsloth/Qwen3-VL-2B-Thinking-GGUF](https://huggingface.co/unsloth/Qwen3-VL-2B-Thinking-GGUF)。
