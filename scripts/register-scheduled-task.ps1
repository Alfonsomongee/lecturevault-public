# Registra la tarea programada en Windows para ejecutar LectureVault de lunes a viernes a las 00:00 (12 de la madrugada)

$ErrorActionPreference = 'Stop'
$TaskName = 'LectureVault-DailyAuto'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RunnerScript = Join-Path $PSScriptRoot 'run-daily-agent.ps1'

$Action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Minimized -ExecutionPolicy Bypass -File `"$RunnerScript`"" `
    -WorkingDirectory $ProjectRoot

$Trigger = New-ScheduledTaskTrigger `
    -Weekly `
    -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday `
    -At '23:30'

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 6)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description 'Revisa de lunes a viernes a las 23:30 las asignaturas del campus VIU, graba clases nuevas a 2x, transcribe, genera apuntes y sube a GitHub.' `
    -Force | Out-Null

Write-Host "✅ Tarea programada '$TaskName' registrada correctamente (lunes a viernes a las 23:30; no hay clases los fines de semana)."
Write-Host "   Si usas el workflow de GitHub Actions (.github/workflows/daily-agent.yml), desactiva esta tarea para no grabar dos veces:"
Write-Host "   Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
