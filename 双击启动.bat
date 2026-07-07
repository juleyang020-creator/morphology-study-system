@echo off
rem 启动本地静态服务器（让 Service Worker 生效），再打开浏览器。
rem 之前直接 start index.html 走 file:// 协议，SW 在 file:// 下不注册，离线缓存完全失效。
setlocal
set "DIR=%~dp0"
set "PORT=8765"

:find_port
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
    set /a PORT+=1
    goto :find_port
)
set "URL=http://127.0.0.1:%PORT%/index.html"

rem 优先 Python（Windows 常见安装），回退 Node，最后回退 file://
where python >nul 2>&1
if %errorlevel%==0 (
    call :open_delayed
    python -m http.server %PORT% --bind 127.0.0.1 --directory "%DIR%"
    goto :eof
)
where py >nul 2>&1
if %errorlevel%==0 (
    call :open_delayed
    py -m http.server %PORT% --bind 127.0.0.1 --directory "%DIR%"
    goto :eof
)
where npx >nul 2>&1
if %errorlevel%==0 (
    call :open_delayed
    npx -y serve -l "%PORT%" "%DIR%"
    goto :eof
)

echo 未找到 python / py / npx，回退为直接打开 file://（离线缓存将不可用）。
start "" "%DIR%index.html"
endlocal
goto :eof

:open_delayed
start "" powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Milliseconds 1200; Start-Process '%URL%'"
exit /b
