// src/kernel/processTree.ts — B2（2026-09-04 第三批）：进程树终止单一事实源
// 背景（8/30 事故族）：bash 等直接 spawn 路径此前靠 spawn({signal}) 只杀直接子进程
// （powershell.exe）——孙进程树（npm→node→vitest worker）全量泄漏成孤儿。
// 机制参考（不抄实现）：本仓 taskRunner 既有 taskkill /T /F 范式（taskRunner.ts:284）；
// winSandbox Job Object（KILL_ON_JOB_CLOSE）覆盖沙盒路径——本模块补齐非沙盒普通路径。
// 语义：win32 走 taskkill /T /F（全树强杀，与 taskRunner 同族）；posix 降级 SIGKILL
// 单杀（进程组需 spawn detached——当前 bash 路径未用，如实降级不伪装全树）。
import { spawn } from 'node:child_process';

/** 终止以 pid 为根的整棵进程树。返回诚实结果——绝不假装成功。 */
export function killProcessTree(pid: number): Promise<{ ok: boolean; detail: string }> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve({ ok: false, detail: `非法 pid：${pid}` });
  if (process.platform === 'win32') {
    // /T 全树递归 + /F 强杀（控制台子树对温和信号不可靠——F 必需；taskRunner 同族语义）
    return new Promise(resolve => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', e => resolve({ ok: false, detail: `taskkill 启动失败：${e.message}` }));
      killer.on('close', code => {
        if (code === 0) return resolve({ ok: true, detail: `全树已终止（根 pid ${pid}）` });
        // 128 = 进程不存在（已自行退出）——目标态已达成，如实标注而非报错
        if (code === 128) return resolve({ ok: true, detail: `进程已不在（根 pid ${pid}——视为已终止）` });
        return resolve({ ok: false, detail: `taskkill 退出码 ${code}（根 pid ${pid}）` });
      });
    });
  }
  // posix 降级：直接子进程 SIGKILL（无进程组——诚实标注非全树）
  return new Promise(resolve => {
    try { process.kill(pid, 'SIGKILL'); resolve({ ok: true, detail: `SIGKILL ${pid}（posix 降级单杀——非全树）` }); }
    catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      resolve(/ESRCH/.test(msg) ? { ok: true, detail: `进程已不在（pid ${pid}）` } : { ok: false, detail: `kill 失败：${msg}` });
    }
  });
}
