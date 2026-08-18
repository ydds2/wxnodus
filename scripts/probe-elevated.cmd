@echo off
REM 3.2 双态沙盒提权分支实测（supremacy 3.6）——请在【管理员】终端运行本脚本：
REM   方式 1：右键本文件 →「以管理员身份运行」
REM   方式 2：管理员 PowerShell/cmd 中执行 cd 到仓库根后运行 scripts\probe-elevated.cmd
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
