@echo off
rem acceptance-build-harness.cmd — build-restart-readback 场景入口包装
rem （Start-Process -WorkingDirectory <proj> 注入项目目录，无参调用 harness）
node "%~dp0acceptance-build-harness.mjs"
