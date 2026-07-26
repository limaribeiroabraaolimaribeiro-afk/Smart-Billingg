@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  Smart Billing Agent - Instalacao
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado no PATH.
  echo Instale o Node.js 22 ou superior em https://nodejs.org e rode este script novamente.
  echo.
  pause
  exit /b 1
)

echo Node.js detectado:
node -v
echo.

echo Instalando dependencias (npm install)...
call npm install
if errorlevel 1 (
  echo.
  echo [ERRO] Falha ao instalar dependencias. Veja o erro acima.
  pause
  exit /b 1
)
echo.

if not exist ".env.example" (
  echo [ERRO] .env.example nao encontrado nesta pasta.
  pause
  exit /b 1
)

if exist ".env" (
  echo Arquivo .env ja existe - nao foi sobrescrito.
) else (
  copy ".env.example" ".env" >nul
  echo Criado ".env" a partir de ".env.example".
)

echo.
echo ============================================
echo  Proximo passo: edite o arquivo .env
echo ============================================
echo Preencha em .env:
echo   SUPABASE_URL                  (URL do seu projeto Supabase)
echo   WHATSAPP_AGENT_FUNCTION_URL   (URL da function whatsapp-agent-api)
echo   WHATSAPP_AGENT_TOKEN          (mesmo valor cadastrado como secret no Supabase)
echo   COMPANY_ID                    (UUID da sua empresa no Smart Billing)
echo.
echo Depois de preencher, rode start-agent.bat.
echo Veja o passo a passo completo em README.md.
echo.
pause
