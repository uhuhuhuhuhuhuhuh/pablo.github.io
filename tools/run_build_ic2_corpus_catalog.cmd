@echo off
setlocal
cd /d S:\train_ic2

echo.
echo Infinite Corridor IC2C exact-chunk catalog builder
echo ============================================================
echo Trainer state: S:\train_ic2\ic2-bulk-state.sqlite3
echo Output:        S:\train_ic2\corpus\
echo Resume state:  S:\train_ic2\ic2-corpus-build-state.sqlite3
echo Work records:  S:\train_ic2\ic2-corpus-build-work\
echo.
echo NOTE: The old bulk trainer did not retain chunk hashes, so this builder
echo       must re-stream the already-learned public source objects once.
echo       Raw source files are NOT stored.
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
  py -3 -u build_ic2_corpus_catalog.py --workers 2 --retry-errors
) else (
  python -u build_ic2_corpus_catalog.py --workers 2 --retry-errors
)
echo.
pause
