$ErrorActionPreference = "Continue"

$AppFolder = Split-Path -Parent $MyInvocation.MyCommand.Path
$JobDir = Join-Path $env:TEMP "qss-pro-cad-worker"
$HeartbeatPath = Join-Path $JobDir "worker.heartbeat"
$LogPath = Join-Path $AppFolder "cad-worker.log"

New-Item -ItemType Directory -Force -Path $JobDir | Out-Null

$mutex = New-Object System.Threading.Mutex($false, "Global\QSSProCadConversionWorker4175")
if (-not $mutex.WaitOne(0)) {
  exit 0
}

function Write-WorkerLog {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

Write-WorkerLog "CAD conversion worker started."

try {
  while ($true) {
    Set-Content -LiteralPath $HeartbeatPath -Value (Get-Date -Format "o") -Encoding UTF8

    $jobs = Get-ChildItem -LiteralPath $JobDir -Filter "*.job.json" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime
    foreach ($jobFile in $jobs) {
      $runningPath = [System.IO.Path]::ChangeExtension($jobFile.FullName, ".running.json")
      try {
        Move-Item -LiteralPath $jobFile.FullName -Destination $runningPath -ErrorAction Stop
      } catch {
        continue
      }

      $job = $null
      $resultPath = $runningPath -replace "\.running\.json$", ".result.json"
      try {
        $job = Get-Content -LiteralPath $runningPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($job.id) {
          $resultPath = Join-Path $JobDir ("{0}.result.json" -f $job.id)
        }

        $logFile = Join-Path $JobDir ("{0}.accore.log" -f $job.id)
        Write-WorkerLog ("Converting {0}" -f $job.inputPath)

        $output = & $job.accoreConsoleExe /i $job.inputPath /s $job.scriptPath 2>&1
        $exitCode = $LASTEXITCODE
        $outputText = ($output | Out-String)
        Set-Content -LiteralPath $logFile -Value $outputText -Encoding UTF8

        $outputCreated = $false
        if ($job.expectedOutputPath) {
          $outputCreated = Test-Path -LiteralPath $job.expectedOutputPath
        }

        $result = [ordered]@{
          ok = $outputCreated
          exitCode = $exitCode
          outputCreated = $outputCreated
          expectedOutputPath = $job.expectedOutputPath
          log = if ($outputText.Length -gt 1200) { $outputText.Substring(0, 1200) } else { $outputText }
          error = if ($outputCreated) { "" } else { "AutoCAD did not create the expected DXF output." }
          completedAt = (Get-Date -Format "o")
        }
        $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultPath -Encoding UTF8
        Write-WorkerLog ("Completed {0}; outputCreated={1}; exitCode={2}" -f $job.id, $outputCreated, $exitCode)
      } catch {
        $result = [ordered]@{
          ok = $false
          exitCode = $null
          outputCreated = $false
          spawnError = $_.Exception.Message
          error = $_.Exception.Message
          completedAt = (Get-Date -Format "o")
        }
        $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultPath -Encoding UTF8
        Write-WorkerLog ("Failed job {0}: {1}" -f $runningPath, $_.Exception.Message)
      } finally {
        Remove-Item -LiteralPath $runningPath -Force -ErrorAction SilentlyContinue
      }
    }

    Start-Sleep -Milliseconds 700
  }
} finally {
  try { $mutex.ReleaseMutex() | Out-Null } catch {}
  $mutex.Dispose()
}
