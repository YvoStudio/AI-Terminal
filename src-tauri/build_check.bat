@echo off
set PATH=C:\Users\Yvo\.cargo\bin;%PATH%
cd /d G:\AI\ai-terminal\src-tauri
cargo check
echo EXIT_CODE: %ERRORLEVEL%
