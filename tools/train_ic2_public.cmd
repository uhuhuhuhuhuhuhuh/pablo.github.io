@echo off
setlocal
cd /d "%~dp0"
echo.
echo Infinite Corridor IC2.1 Public Knowledge Trainer
echo ------------------------------------------------
echo This downloads a bounded public/open corpus and creates:
echo   ic2-public-knowledge.json
echo.
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 train_ic2_knowledge.py --public-pack --archive-items 40 --commons-items 40 --gutenberg-items 20 --max-file-mb 8 --max-total-gb 2 --output "%~dp0..\ic2-public-knowledge.json"
) else (
  python train_ic2_knowledge.py --public-pack --archive-items 40 --commons-items 40 --gutenberg-items 20 --max-file-mb 8 --max-total-gb 2 --output "%~dp0..\ic2-public-knowledge.json"
)
echo.
echo If training succeeded, ic2-public-knowledge.json is in the repository root.
echo Commit that file to publish the baseline.
echo.
pause
