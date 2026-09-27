@echo off
rem Double-click to start Sanctuary Studio
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: installing components, please wait...
  call npm install
)
set ELECTRON_RUN_AS_NODE=
start "" "node_modules\electron\dist\electron.exe" .
