@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title FRAME MCP
pushd "%~dp0"
if errorlevel 1 exit /b 1

echo FRAME 远程 MCP - OAuth / Bearer
echo.
where node.exe >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请安装 Node.js 22.13 或更新版本后重试。
  goto failed
)
node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>22 || major===22 && minor>=13 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 版本过低，请升级到 22.13 或更新版本。
  goto failed
)

if exist "node_modules\@modelcontextprotocol\server\package.json" goto configured
set "FRAME_START_PNPM="
where pnpm.cmd >nul 2>nul
if not errorlevel 1 set "FRAME_START_PNPM=pnpm.cmd"
if defined FRAME_START_PNPM goto install
where pnpm.exe >nul 2>nul
if not errorlevel 1 set "FRAME_START_PNPM=pnpm.exe"
if defined FRAME_START_PNPM goto install
echo 缺少项目依赖，也未找到 pnpm。请安装 pnpm 后重试。
goto failed

:install
echo 首次启动正在安装项目依赖，需要网络连接。
call "%FRAME_START_PNPM%" install --frozen-lockfile --prod=false
if errorlevel 1 goto failed

:configured
set "FRAME_START_ENV=.env"
if not "%~1"=="" set "FRAME_START_ENV=%~1"
if exist "%FRAME_START_ENV%" goto start
node -- scripts/mcp-remote.mjs init --env-file "%FRAME_START_ENV%"
if errorlevel 1 goto failed
echo.
echo 已创建私有配置："%FRAME_START_ENV%"
echo 请先填写公网域名、AI 回调地址和隧道设置，然后再次双击本脚本。
echo 配置说明：docs\MCP-REMOTE.md
pause
popd
endlocal
exit /b 0

:start
echo 正在检查配置："%FRAME_START_ENV%"
node -- scripts/mcp-remote.mjs check --env-file "%FRAME_START_ENV%"
if errorlevel 1 goto failed
echo.
echo 正在启动 MCP。启用 Cloudflare 隧道时会一并启动。
echo 请保持此窗口打开；按 Ctrl+C 停止服务。
echo 公网是否可用取决于配置与隧道连接，请按接入指南核验。
echo.
node -- scripts/mcp-remote.mjs serve --env-file "%FRAME_START_ENV%"
if errorlevel 1 goto failed
popd
endlocal
exit /b 0

:failed
echo.
echo MCP 启动失败或服务异常退出，请查看上方错误。配置说明：docs\MCP-REMOTE.md
pause
popd
endlocal
exit /b 1
