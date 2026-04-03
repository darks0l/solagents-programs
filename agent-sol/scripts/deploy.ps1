# Deploy script for solagents.dev
# Usage: .\scripts\deploy.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "Building site..." -ForegroundColor Cyan
Push-Location "$root\web"
npx vite build --outDir ../site
Pop-Location

Write-Host "Linking to Vercel project 'solagents'..." -ForegroundColor Cyan
Push-Location "$root\site"
if (Test-Path .vercel) { Remove-Item -Recurse -Force .vercel }
vercel link --yes --project solagents
vercel deploy --prod --yes
Pop-Location

Write-Host "✅ Deployed to solagents.dev" -ForegroundColor Green
