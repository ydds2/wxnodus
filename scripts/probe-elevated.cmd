@echo off
REM 3.2 双态沙盒提权分支实测（supremacy 3.6）——双击即可（自动请求管理员提权，UAC 弹窗点「是」）。
REM 也可以：管理员 PowerShell/cmd 中 cd 到仓库根后运行 scripts\probe-elevated.cmd

REM ── 自提权：当前非管理员时经 UAC 重新以管理员身份启动自身（实测脚本必须提权才有效）──
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo 需要管理员权限实测提权沙盒分支——正在请求提权（UAC 弹窗请点「是」）...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0.."
echo [1/2] 构建（npm run build——首次约 1-2 分钟）...
call npm run build
if errorlevel 1 (
  echo BUILD_FAILED：构建失败——把上方错误贴回 ZCode 会话
  pause
  exit /b 1
)
echo [2/2] 提权实测（双态探测 + L0/L1 沙盒写测试）...
node scripts\elevated-probe.mjs
echo.
echo 实测完成：结果已保存到仓库根 elevated-probe-result.txt——把该文件内容贴回 ZCode 会话即可复算 ⑥ 9→10。
pause
