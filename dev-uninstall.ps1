# NodeBrain dev uninstall script
# Run from PowerShell as Administrator

Write-Host "Stopping NodeBrain processes..." -ForegroundColor Yellow
taskkill /IM "NodeBrain.exe" /F 2>$null
# Warning: this kills ALL node.exe processes on your machine, not just NodeBrain
taskkill /IM "node.exe" /F 2>$null

Write-Host "Removing application files..." -ForegroundColor Yellow
Remove-Item -Recurse -Force "C:\Users\$env:USERNAME\AppData\Local\Programs\NodeBrain" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "C:\Users\$env:USERNAME\AppData\Roaming\NodeBrain" -ErrorAction SilentlyContinue
Remove-Item -Force "C:\Users\$env:USERNAME\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\NodeBrain.lnk" -ErrorAction SilentlyContinue
Remove-Item -Force "C:\Users\$env:USERNAME\Desktop\NodeBrain.lnk" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\NodeBrain" -ErrorAction SilentlyContinue

Write-Host "Removing dist-electron..." -ForegroundColor Yellow
Remove-Item -Recurse -Force "dist-electron" -ErrorAction SilentlyContinue

Write-Host "Clearing electron-builder NSIS cache..." -ForegroundColor Yellow
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electron-builder\Cache\nsis" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electron-builder" -ErrorAction SilentlyContinue

Write-Host "Done. NodeBrain fully removed." -ForegroundColor Green
Write-Host "Developers: run 'npm run dist' to rebuild." -ForegroundColor Cyan
Write-Host "Users: download a fresh installer at nodebrain.app/download" -ForegroundColor Cyan