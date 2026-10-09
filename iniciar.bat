@echo off
chcp 65001 >nul
title PLANTA GRANULADORA EL PILAR - Sistema de mantenimiento
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  No se encontro Node.js en esta computadora.
  echo  Descargue e instale la version LTS desde https://nodejs.org
  echo  y despues vuelva a abrir este archivo.
  echo.
  pause
  exit /b 1
)

rem Abre el navegador dos segundos despues, cuando el sistema ya esta en marcha.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"

node --disable-warning=ExperimentalWarning server.js

echo.
echo  El sistema se detuvo.
pause
