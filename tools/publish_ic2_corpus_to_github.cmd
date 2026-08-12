@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "SOURCE=S:\train_ic2\corpus"
set "CLONE=S:\train_ic2\pablo-pages-publish"
set "REPO=https://github.com/uhuhuhuhuhuhuhuh/pablo.github.io.git"

echo.
echo Infinite Corridor IC2C corpus publisher
echo ============================================================
echo Source: %SOURCE%
echo Repo:   %REPO%
echo Clone:  %CLONE%
echo ============================================================
echo.

if not exist "%SOURCE%\index.json" (
  echo ERROR: %SOURCE%\index.json does not exist.
  echo Run build_ic2_corpus_catalog.py first.
  pause
  exit /b 1
)
if not exist "%SOURCE%\chunks" (
  echo ERROR: %SOURCE%\chunks does not exist.
  pause
  exit /b 1
)

where git >nul 2>nul
if errorlevel 1 (
  echo ERROR: Git is not installed or is not in PATH.
  echo Install Git for Windows and sign in with Git Credential Manager, then rerun.
  pause
  exit /b 1
)

if not exist "%CLONE%\.git" (
  if exist "%CLONE%" rmdir /s /q "%CLONE%"
  git clone "%REPO%" "%CLONE%"
  if errorlevel 1 goto :fail
) else (
  pushd "%CLONE%"
  git fetch origin main
  if errorlevel 1 goto :failpop
  git checkout main
  if errorlevel 1 goto :failpop
  git pull --ff-only origin main
  if errorlevel 1 goto :failpop
  popd
)

echo Copying generated catalog into repository corpus\ ...
if exist "%CLONE%\corpus" rmdir /s /q "%CLONE%\corpus"
mkdir "%CLONE%\corpus" >nul 2>nul
robocopy "%SOURCE%" "%CLONE%\corpus" /MIR /NFL /NDL /NJH /NJS /NP
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 (
  echo ERROR: robocopy failed with code %RC%.
  pause
  exit /b %RC%
)

pushd "%CLONE%"
git add -A corpus
for /f %%A in ('git status --porcelain -- corpus') do set "CHANGED=1"
if not defined CHANGED (
  echo Nothing changed. The repository already has this corpus catalog.
  popd
  pause
  exit /b 0
)

git commit -m "Publish IC2C exact-chunk corpus catalog"
if errorlevel 1 goto :failpop
git push origin main
if errorlevel 1 goto :failpop
popd

echo.
echo Published corpus/ to GitHub Pages source repository.
echo GitHub Pages will deploy the new catalog automatically.
pause
exit /b 0

:failpop
popd
:fail
echo.
echo ERROR: Git operation failed. Make sure Git Credential Manager is signed in
 echo and that your account can push to uhuhuhuhuhuhuhuh/pablo.github.io.
pause
exit /b 1
