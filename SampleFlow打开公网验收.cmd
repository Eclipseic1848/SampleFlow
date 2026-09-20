@echo off
chcp 65001 >nul
cd /d "F:\new branch\SampleFlow"
if errorlevel 1 exit /b 1
set "PATH=E:\nodejs;C:\Program Files\Docker\Docker\resources\bin;%PATH%"
"E:\nodejs\node.exe" scripts\acceptance.mjs open
set "acceptanceExit=%errorlevel%"
if errorlevel 1 pause
exit /b %acceptanceExit%
