# PMBrain 启动脚本
# 每次运行：同步所有 source → 启动 serve

Write-Host "=== PMBrain 启动 ===" -ForegroundColor Cyan

# 同步所有注册的 source
Write-Host "[1/2] 同步 source..." -ForegroundColor Yellow
bun src/cli.ts sync --all

# 补全 embedding
Write-Host "[2/2] 补全 embedding..." -ForegroundColor Yellow
bun src/cli.ts embed --stale

Write-Host "=== 启动完成 ===" -ForegroundColor Green
Write-Host "数据库已同步，可直接使用 CLI 查询" -ForegroundColor Green
