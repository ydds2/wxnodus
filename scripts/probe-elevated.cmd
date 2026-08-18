@echo off
REM wxnodus dual-mode sandbox elevated probe (supremacy 3.6 evidence, 2026-08-18)
REM Double-click this file. If not admin yet, it requests elevation via UAC.
REM Alternative: open an admin PowerShell/cmd, cd to repo root, run scripts\probe-elevated.cmd

REM -- self-elevation: if not admin, relaunch elevated via UAC --
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator elevation - please click [Yes] on the UAC prompt...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -ErrorAction Stop" 2>"%TEMP%\wxnodus-elev-fail.txt"
  if errorlevel 1 (
    echo.
    echo ELEVATION FAILED OR CANCELLED. Details:
    type "%TEMP%\wxnodus-elev-fail.txt" 2>nul
    echo.
    echo How to proceed: open an admin PowerShell, then run:
    echo   cd /d %~dp0..
    echo   scripts\probe-elevated.cmd
  ) else (
    echo Elevation accepted - this window closes now, the elevated window runs the probe.
  )
  pause
  exit /b
)

echo [ELEVATED OK] running as administrator.
cd /d "%~dp0.."
echo RUNNING:%date% %time% > elevated-probe-status.txt
echo [1/2] Building (npm run build - first run takes 1-2 minutes)...
call npm run build
if errorlevel 1 (
  echo BUILD_FAILED - paste the errors above back into the ZCode session.
  echo BUILD_FAILED > elevated-probe-status.txt
  pause
  exit /b 1
)
echo [2/2] Running elevated sandbox probe (dual-mode probe + L0/L1 write tests)...
node scripts\elevated-probe.mjs
echo.
echo Done - result saved to elevated-probe-result.txt in repo root.
echo Paste the file content back into the ZCode session to complete the 3.2 rescore.
pause
