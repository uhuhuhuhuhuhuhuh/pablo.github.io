@echo off
setlocal
cd /d S:\train_ic2

echo.
echo Infinite Corridor IC2C exact-chunk catalog builder v1.1
echo ============================================================
echo Trainer state: S:\train_ic2\ic2-bulk-state.sqlite3
echo Output:        S:\train_ic2\corpus\
echo Resume state:  S:\train_ic2\ic2-corpus-build-state.sqlite3
echo Work records:  S:\train_ic2\ic2-corpus-build-work\
echo.
echo ENGINE: multiprocessing FastCDC workers ^(real separate Python processes^)
echo WORKERS: auto, capped at 8 logical workers
echo STREAM:  8 MiB HTTP blocks per worker
echo.
echo Existing verified sources and .records files are reused.
echo Active partial source streams are not resumable inside a single file.
echo Raw source files are NOT stored.
echo ============================================================
echo.
if not exist "build_ic2_corpus_catalog.py" (
  echo ERROR: build_ic2_corpus_catalog.py is not in S:\train_ic2
  echo Copy tools\build_ic2_corpus_catalog.py there first.
  pause
  exit /b 1
)
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 -u build_ic2_corpus_catalog.py --workers 0 --stream-mib 8 --retry-errors
) else (
  python -u build_ic2_corpus_catalog.py --workers 0 --stream-mib 8 --retry-errors
)
echo.
pause
