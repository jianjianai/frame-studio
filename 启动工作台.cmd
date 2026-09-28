@echo off
chcp 65001 >nul
cd /d "%~dp0"
where pnpm.cmd >nul 2>nul
if errorlevel 1 (echo pnpm was not found. Install pnpm first. & pause & exit /b 1)
if not exist node_modules (call pnpm.cmd install --frozen-lockfile)
if errorlevel 1 (pause & exit /b 1)
echo FRAME Studio: http://127.0.0.1:5173
echo Keep this terminal open. Press Ctrl+C to stop.
call pnpm.cmd dev --open
if errorlevel 1 pause
