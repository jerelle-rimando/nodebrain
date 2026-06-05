# NodeBrain dev uninstall script
# Run from PowerShell as Administrator

function Remove-WithLogging {
    param([string]$Path, [switch]$Recurse)
    if (-not (Test-Path $Path)) { return }
    try {
        if ($Recurse) {
            Remove-Item -Recurse -Force $Path -ErrorAction Stop
        } else {
            Remove-Item -Force $Path -ErrorAction Stop
        }
    } catch {
        Write-Warning "Failed to remove '$Path': $_"
    }
}

# --- Stop Electron shell ---
Write-Host "Stopping NodeBrain processes..." -ForegroundColor Yellow
taskkill /IM "NodeBrain.exe" /F 2>$null

# --- Stop only the NodeBrain backend node.exe (port 3001) ---
# Does NOT kill unrelated node processes on the machine.
$netstatLine = netstat -ano | Where-Object { $_ -match ':3001\s+.*LISTENING' } | Select-Object -First 1
if ($netstatLine) {
    $backendPid = $netstatLine.Trim() -split '\s+' | Select-Object -Last 1
    if ($backendPid -match '^\d+$') {
        $proc = Get-Process -Id ([int]$backendPid) -ErrorAction SilentlyContinue
        if ($proc -and $proc.Name -eq 'node') {
            Write-Host "  Stopping NodeBrain backend (node.exe PID $backendPid, port 3001)..." -ForegroundColor Yellow
            Stop-Process -Id ([int]$backendPid) -Force
        } elseif ($proc) {
            Write-Warning "  Port 3001 is held by '$($proc.Name)' (PID $backendPid) -- not node.exe, skipping."
        }
    }
} else {
    Write-Host "  NodeBrain backend (port 3001) not running -- skipping." -ForegroundColor Cyan
}

# --- Remove vault secret from Windows Credential Manager (keytar service "NodeBrain", account "vault-secret") ---
Write-Host "Removing vault secret from Windows Credential Manager..." -ForegroundColor Yellow
cmdkey /delete:"NodeBrain/vault-secret" | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  Vault secret removed." -ForegroundColor Green
} else {
    Write-Host "  Vault secret not found in Credential Manager (skipping)." -ForegroundColor Cyan
}

# --- Remove application files ---
Write-Host "Removing application files..." -ForegroundColor Yellow
Remove-WithLogging "C:\Users\$env:USERNAME\AppData\Local\Programs\NodeBrain" -Recurse
Remove-WithLogging "C:\Users\$env:USERNAME\AppData\Roaming\NodeBrain" -Recurse
Remove-WithLogging "C:\Users\$env:USERNAME\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\NodeBrain.lnk"
Remove-WithLogging "C:\Users\$env:USERNAME\Desktop\NodeBrain.lnk"
Remove-WithLogging "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\NodeBrain" -Recurse

# --- Remove build artifacts ---
Write-Host "Removing dist-electron..." -ForegroundColor Yellow
Remove-WithLogging "dist-electron" -Recurse

# --- Clear electron-builder cache ---
Write-Host "Clearing electron-builder cache..." -ForegroundColor Yellow
Remove-WithLogging "$env:LOCALAPPDATA\electron-builder\Cache\nsis" -Recurse
Remove-WithLogging "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign" -Recurse
Remove-WithLogging "$env:LOCALAPPDATA\electron-builder" -Recurse

Write-Host "Done. NodeBrain fully removed." -ForegroundColor Green
Write-Host "Developers: run 'npm run dist' to rebuild." -ForegroundColor Cyan
Write-Host "Users: download a fresh installer at nodebrain.app/download" -ForegroundColor Cyan
