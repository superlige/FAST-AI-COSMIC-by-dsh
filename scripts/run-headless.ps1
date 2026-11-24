# 在真机工程里无头跑一次 dsh（命令行配置 cosmic），量用时。
# 用法：pwsh scripts/run-headless.ps1 -Profile cosmic -Out <输出.jsonl> -Task "<需求>" [-Cwd D:\kingdee\zlgd_ygpt2.0]
# 输出：-Out 是 dsh 的 --json 事件流，-Out.err 是标准错误；最后一行打印退出码和秒数。
# 配置先用 node scripts/setup-dsh-profiles.mjs 建好。dsh 用的是本仓库上一级的 deepseek-harness 检出。
param(
  [Parameter(Mandatory)] [string] $Profile,
  [Parameter(Mandatory)] [string] $Out,
  [Parameter(Mandatory)] [string] $Task,
  [string] $Cwd = 'D:\kingdee\zlgd_ygpt2.0'
)
$env:PATH = "D:\nodejs24;$env:PATH"
$dsh = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$env:TSX_TSCONFIG_PATH = "$dsh\tsconfig.json"
$Out = [System.IO.Path]::GetFullPath($Out)
Set-Location $Cwd
$t0 = Get-Date
& node --import "file:///$($dsh -replace '\\','/')/node_modules/tsx/dist/esm/index.mjs" "$dsh\apps\cli\src\bin.ts" --profile $Profile --json $Task 1> $Out 2> "$Out.err"
$code = $LASTEXITCODE
"exit=$code seconds=$([int]((Get-Date) - $t0).TotalSeconds)"
