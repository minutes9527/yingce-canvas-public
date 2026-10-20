$ErrorActionPreference = 'Stop'
$env:FRAMEFIELD_TRUSTED_WEB_ORIGINS = 'https://min99.cc,https://www.min99.cc'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '请先安装 Node.js 20 LTS。' }
if (-not (Test-Path 'node_modules')) { npm install }
npm run build
npm start
