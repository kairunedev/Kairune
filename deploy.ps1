# Deploy Kairune to VPS (SSH host: nodess)
$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot
$Archive = Join-Path $env:TEMP "kairune-deploy.tgz"

Write-Host ">> Packaging..." -ForegroundColor Cyan
Push-Location $ProjectDir
tar --exclude=node_modules --exclude=.git -czf $Archive .
Pop-Location

Write-Host ">> Uploading to nodess..." -ForegroundColor Cyan
scp $Archive nodess:/tmp/kairune-deploy.tgz

Write-Host ">> Installing on VPS..." -ForegroundColor Cyan
ssh nodess @"
set -e
tar -xzf /tmp/kairune-deploy.tgz -C /var/www/kairune
cd /var/www/kairune
npm ci --omit=dev
pm2 restart kairune
rm -f /tmp/kairune-deploy.tgz
curl -s http://127.0.0.1:3040/health
"@

Write-Host ">> Done. Live at http://206.189.34.168" -ForegroundColor Green
