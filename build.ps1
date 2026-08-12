param(
    [ValidateSet("win-x64", "win-arm64")]
    [string]$Runtime = "win-x64"
)

$ErrorActionPreference = "Stop"
$projectRoot = $PSScriptRoot
$projectFile = Join-Path $projectRoot "DvbServer.csproj"
$publishDirectory = Join-Path $projectRoot "publish"
$publishedCache = Join-Path $publishDirectory "cache"
$cacheBackup = Join-Path $projectRoot (".publish-cache-" + [Guid]::NewGuid().ToString("N"))

if (Test-Path -LiteralPath $publishedCache) {
    Move-Item -LiteralPath $publishedCache -Destination $cacheBackup
}

try {
    if (Test-Path -LiteralPath $publishDirectory) {
        Remove-Item -LiteralPath $publishDirectory -Recurse -Force
    }

    dotnet publish $projectFile `
        --configuration Release `
        --runtime $Runtime `
        --self-contained true `
        -p:PublishSingleFile=true `
        -p:DebugType=None `
        --output $publishDirectory

    if ($LASTEXITCODE -ne 0) {
        throw "Publish failed with exit code $LASTEXITCODE."
    }
}
finally {
    if (Test-Path -LiteralPath $cacheBackup) {
        New-Item -ItemType Directory -Path $publishDirectory -Force | Out-Null
        Move-Item -LiteralPath $cacheBackup -Destination $publishedCache
    }
}


Write-Host ""
Write-Host "Ready-to-run application created in: $publishDirectory" -ForegroundColor Green
Write-Host "Start it with: .\publish\DvbServer.exe"
