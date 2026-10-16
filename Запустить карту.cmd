@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "MAP_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  set "MAP_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
if not exist "node_modules\vite\package.json" (
  echo Сначала установите зависимости: pnpm install --frozen-lockfile
  pause
  exit /b 1
)
echo Откройте в браузере http://127.0.0.1:5173/
echo Оставьте это окно открытым. Остановка: Ctrl+C.
"%MAP_NODE%" scripts\dev.mjs
if errorlevel 1 pause
endlocal
