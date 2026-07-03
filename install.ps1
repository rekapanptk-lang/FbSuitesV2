# FbSuitesV2 Installer — PowerShell backend
$ErrorActionPreference = 'Stop'

# ─── CONFIG ───
$InstallDir  = "$env:ProgramFiles\FbSuitesV2"
$DataDir     = "$env:APPDATA\FbSuitesV2"
$RepoBase    = "https://raw.githubusercontent.com/rekapanptk-lang/FbSuitesV2/main"
$NodeVersion = "v20.18.0"
$NodeUrl     = "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-x64.msi"

# Files: repo path → destination filename (di InstallDir)
$RepoFiles = @(
    @{ Path = 'src/browser_scraper.js';  Dest = 'browser_scraper.js' },
    @{ Path = 'src/package.json';        Dest = 'package.json' },
    @{ Path = 'src/start.vbs';           Dest = 'start.vbs' },
    @{ Path = 'src/Tampermonkey.crx';    Dest = 'Tampermonkey.crx' },
    @{ Path = 'uninstall.bat';           Dest = 'uninstall.bat' }
)

# ─── HELPERS ───
function Write-Step { param($n, $total, $msg)
    Write-Host ""
    Write-Host "[$n/$total] " -NoNewline -ForegroundColor Cyan
    Write-Host $msg -ForegroundColor White
}
function Write-OK    { param($msg) Write-Host "      OK: $msg" -ForegroundColor Green }
function Write-Info  { param($msg) Write-Host "      $msg" -ForegroundColor Gray }
function Write-Err   { param($msg) Write-Host "      ERROR: $msg" -ForegroundColor Red }

Clear-Host
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "   FbSuitesV2 Installer" -ForegroundColor Cyan
Write-Host "   Repo: rekapanptk-lang/FbSuitesV2" -ForegroundColor Gray
Write-Host "============================================" -ForegroundColor Cyan

# ─── [1/6] Directories ───
Write-Step 1 6 "Preparing install directory..."
Write-Info "Install : $InstallDir"
Write-Info "Data    : $DataDir"
foreach ($d in @($InstallDir, $DataDir, "$DataDir\profiles")) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
Write-OK "Directories ready"

# ─── [2/6] Download files ───
Write-Step 2 6 "Downloading FbSuitesV2 files from GitHub..."
foreach ($f in $RepoFiles) {
    $url = "$RepoBase/$($f.Path)"
    $dest = Join-Path $InstallDir $f.Dest
    Write-Info "Fetching $($f.Path)..."
    try {
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
        Write-OK "$($f.Dest)"
    } catch {
        Write-Err "Failed: $($f.Path) — $($_.Exception.Message)"
        exit 1
    }
}

# ─── [3/6] Node.js ───
Write-Step 3 6 "Checking Node.js..."
$nodeOK = $false
try {
    $ver = & node --version 2>$null
    if ($ver) { Write-OK "Node.js already installed: $ver"; $nodeOK = $true }
} catch {}

if (-not $nodeOK) {
    Write-Info "Not found. Downloading Node.js $NodeVersion (~30MB)..."
    $msi = "$env:TEMP\node-installer.msi"
    try {
        Invoke-WebRequest -Uri $NodeUrl -OutFile $msi -UseBasicParsing
        Write-Info "Installing (silent, ~1-2 min)..."
        $proc = Start-Process msiexec -ArgumentList "/i", $msi, "/qn", "/norestart" -Wait -PassThru
        if ($proc.ExitCode -ne 0) { Write-Err "Node install exit code: $($proc.ExitCode)"; exit 1 }
        Remove-Item $msi -Force
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
        Write-OK "Node.js installed"
    } catch {
        Write-Err "Node install failed: $($_.Exception.Message)"; exit 1
    }
}

# ─── [4/6] npm install ───
Write-Step 4 6 "Installing npm packages..."
Set-Location $InstallDir
try {
    $out = & npm install --production --loglevel=error 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed"; Write-Host $out -ForegroundColor Red; exit 1 }
    Write-OK "npm packages installed"
} catch { Write-Err "npm exception: $($_.Exception.Message)"; exit 1 }

# ─── [5/6] Playwright Chromium ───
Write-Step 5 6 "Downloading Chromium browser (~200MB, 3-5 min)..."
try {
    $out = & npx playwright install chromium 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Err "Playwright install failed"; Write-Host $out -ForegroundColor Red; exit 1 }
    Write-OK "Chromium installed"
} catch { Write-Err "Playwright exception: $($_.Exception.Message)"; exit 1 }

# ─── [6/6] Shortcut + Registry ───
Write-Step 6 6 "Creating shortcut + registry entry..."

$shortcut = "$env:USERPROFILE\Desktop\FB Suites V2.lnk"
$wshell = New-Object -ComObject WScript.Shell
$sc = $wshell.CreateShortcut($shortcut)
$sc.TargetPath = "$InstallDir\start.vbs"
$sc.WorkingDirectory = $InstallDir
$sc.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
$sc.Save()
Write-OK "Desktop shortcut created"

$uninstKey = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FbSuitesV2"
New-Item -Path $uninstKey -Force | Out-Null
Set-ItemProperty $uninstKey "DisplayName"      "FB Suites V2"
Set-ItemProperty $uninstKey "DisplayVersion"   "2.0.0"
Set-ItemProperty $uninstKey "Publisher"        "Riko"
Set-ItemProperty $uninstKey "InstallLocation"  $InstallDir
Set-ItemProperty $uninstKey "UninstallString"  "`"$InstallDir\uninstall.bat`""
Set-ItemProperty $uninstKey "DisplayIcon"      "$env:SystemRoot\System32\shell32.dll,13"
Set-ItemProperty $uninstKey "NoModify"         1 -Type DWord
Set-ItemProperty $uninstKey "NoRepair"         1 -Type DWord
Write-OK "Add/Remove Programs entry created"

# ─── FINAL ───
Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "   INSTALL COMPLETE" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Shortcut : $shortcut" -ForegroundColor White
Write-Host "Data dir : $DataDir" -ForegroundColor White
Write-Host ""

# cookies.txt template
$cookiesPath = "$DataDir\cookies.txt"
if (-not (Test-Path $cookiesPath)) {
    $template = @"
# FbSuitesV2 - Cookie file
# Format per baris: ID``label``c_user|password|cookieString
#
# Contoh:
# 1``AkunFB01``100012345678|passtoyou|c_user=100012345678; xs=abc...; fr=xyz...
#
# Hapus semua line yang mulai dengan # ini, isi dengan akun, save.
"@
    $template | Set-Content -Path $cookiesPath -Encoding UTF8
    Write-Host "cookies.txt template dibuat di:" -ForegroundColor Yellow
    Write-Host "  $cookiesPath" -ForegroundColor White
    Write-Host "Notepad akan kebuka — isi dulu sebelum launch." -ForegroundColor Yellow
    Start-Process notepad.exe $cookiesPath
    Write-Host ""
}

$launch = Read-Host "Launch FB Suites V2 sekarang? (Y/N)"
if ($launch -match '^[Yy]') { Start-Process "$InstallDir\start.vbs" }
