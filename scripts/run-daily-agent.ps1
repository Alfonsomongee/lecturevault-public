# LectureVault — Ejecutor del Agente Diario de Campus
# Invocado automáticamente de lunes a viernes a las 23:30 por el Programador de Tareas de Windows.

$ErrorActionPreference = 'Continue'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $ProjectRoot

$LogDir = Join-Path $ProjectRoot 'data\logs'
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$LogFile = Join-Path $LogDir 'auto-daily.log'
$Timestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
Add-Content -Path $LogFile -Value "`n==============================================================="
Add-Content -Path $LogFile -Value "[$Timestamp] Iniciando agente diario LectureVault (auto:daily)"
Add-Content -Path $LogFile -Value "==============================================================="

# Código 75 = el perfil del navegador estaba ocupado (otra captura abierta): se reintenta cada 10 min, hasta 6 veces
$ExitCode = 0
for ($attempt = 1; $attempt -le 6; $attempt++) {
    & npm.cmd run auto:daily -- --speed 2 --silent *>> $LogFile
    $ExitCode = $LASTEXITCODE
    if ($ExitCode -ne 75) { break }
    Add-Content -Path $LogFile -Value "[$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] Perfil ocupado (intento $attempt/6); reintento en 10 min"
    Start-Sleep -Seconds 600
}

$EndTimestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
Add-Content -Path $LogFile -Value "[$EndTimestamp] Finalizado con código $ExitCode"
exit $ExitCode
