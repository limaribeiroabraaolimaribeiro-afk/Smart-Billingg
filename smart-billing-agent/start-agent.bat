@echo off
title Smart Billing Agent - WhatsApp
cd /d "%~dp0"

if not exist ".env" (
  echo [ERRO] Arquivo .env nao encontrado nesta pasta.
  echo Rode install-agent.bat primeiro e preencha o .env.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [ERRO] Dependencias nao instaladas.
  echo Rode install-agent.bat primeiro.
  echo.
  pause
  exit /b 1
)

:loop
echo ============================================
echo  Smart Billing Agent - iniciando...
echo  Mantenha esta janela aberta para ficar conectado.
echo  Feche esta janela para desconectar o WhatsApp.
echo ============================================
echo.

node src\index.js

echo.
echo [Smart Billing Agent] O processo encerrou (codigo %errorlevel%).
echo Reiniciando em 5 segundos... (feche esta janela para parar)
timeout /t 5 >nul
goto loop
