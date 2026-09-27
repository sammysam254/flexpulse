@echo off
setlocal
call "%~dp0Setup.bat" %*
exit /b %errorlevel%
