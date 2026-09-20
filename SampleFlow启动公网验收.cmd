@echo off
chcp 65001 >nul
title SampleFlow - Public Acceptance
cd /d "F:\new branch\SampleFlow"
if errorlevel 1 exit /b 1
set "PATH=E:\nodejs;C:\Program Files\Docker\Docker\resources\bin;%PATH%"
echo 正在启动或恢复 SampleFlow 公网验收，请耐心等待检查结果。
echo 无需先开 Docker；不会清空数据或重置密码。
echo.
"E:\nodejs\node.exe" scripts\acceptance.mjs start
if errorlevel 1 goto failed
"E:\nodejs\node.exe" scripts\acceptance.mjs open
if errorlevel 1 goto failed
echo.
echo 启动检查通过。可以关闭本窗口，但不要关闭电脑或让电脑睡眠。
pause
exit /b 0
:failed
echo.
echo 启动未通过，请查看上方提示。不要把旧网址发给客户。
echo 数据和密码仍保留。请检查网络后再次双击；仍失败请联系维护人员。
pause
exit /b 1
