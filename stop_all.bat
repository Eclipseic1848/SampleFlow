@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo [SampleFlow] 正在停止开发数据库...
docker compose -f docker-compose.dev.yml down
echo [SampleFlow] 数据库已停止，数据卷仍保留。
pause

