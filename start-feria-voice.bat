@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules" (
  echo Встановлення залежностей npm...
  call npm install
)

:menu
cls
echo ========================================================
echo    Feria Polyglot — Сервер мовної механіки D^&D
echo ========================================================
echo.
echo   [1] Локальний запуск (http://localhost:3456)
echo       Для тестування або гри через Radmin VPN / LAN
echo.
echo   [2] Запуск із публічним HTTPS-посиланням (Тунель)
echo       Для гри з друзями по інтернету (мікрофон працює одразу)
echo.
echo   [3] Вийти
echo.
set /p choice="Оберіть режим [1-3]: "

if "%choice%"=="1" goto local
if "%choice%"=="2" goto tunnel
if "%choice%"=="3" exit /b 0
goto menu

:local
echo.
echo Запуск локального сервера на http://localhost:3456 ...
echo Щоб протестувати без друзів, відкрийте у браузері http://localhost:3456
echo PIN Майстра за замовчуванням: 1250
echo.
start "" "http://localhost:3456"
node server.js
pause
goto :eof

:tunnel
echo.
echo Запуск локального сервера у фоні...
start "Feria Polyglot Server" cmd /k "cd /d "%~dp0" && node server.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:3456"

where cloudflared >nul 2>&1
if %errorlevel%==0 (
  echo Виявлено cloudflared! Створення захищеного HTTPS-тунелю...
  echo Скопіюйте посилання вигляду https://....trycloudflare.com і надішліть гравцям.
  cloudflared tunnel --url http://localhost:3456
) else (
  echo Запуск безкоштовного HTTPS-тунелю через localtunnel...
  echo Скопіюйте отриманий https://...loca.lt URL і надішліть гравцям.
  echo Якщо localtunnel попросить пароль при першому вході — це ваш публічний IP ^(https://loca.lt/mytunnelpassword^).
  npx --yes localtunnel --port 3456
)
pause
goto :eof
