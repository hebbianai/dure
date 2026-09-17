param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Launch", "VerifyAndStop")]
  [string]$Mode
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (
  -not $env:GITHUB_WORKSPACE -or
  -not $env:RUNNER_TEMP -or
  $env:GITHUB_RUN_ID -notmatch "^[0-9]+$" -or
  $env:GITHUB_RUN_ATTEMPT -notmatch "^[0-9]+$"
) {
  throw "Windows desktop smoke requires GITHUB_WORKSPACE and RUNNER_TEMP"
}

$workspace = [System.IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
$runnerTemp = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)
$receiptPath = Join-Path $env:RUNNER_TEMP "dure-windows-smoke.json"
$installRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $runnerTemp "dure-windows-install-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT")
)
$bundleDirectory = [System.IO.Path]::GetFullPath(
  (Join-Path $workspace "src-tauri\target\release\bundle\nsis")
)
$appPath = [System.IO.Path]::GetFullPath(
  (Join-Path $installRoot "dure.exe")
)
$hmuxRuntimePath = [System.IO.Path]::GetFullPath(
  (Join-Path $installRoot "hmux-runtime.exe")
)
$hmuxCliPath = [System.IO.Path]::GetFullPath(
  (Join-Path $installRoot "hmux.exe")
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class DureWindowProbe {
    private delegate bool EnumWindowsCallback(IntPtr handle, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    public static IntPtr FindVisibleWindow(uint expectedProcessId) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((handle, data) => {
            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            if (processId == expectedProcessId && IsWindowVisible(handle)) {
                found = handle;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@

function Assert-OwnedInstallRoot {
  $runnerTempPrefix = $runnerTemp.TrimEnd("\") + "\"
  if (-not $installRoot.StartsWith(
    $runnerTempPrefix,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Windows desktop install root escaped RUNNER_TEMP"
  }
}

function Resolve-Installer {
  if (-not (Test-Path -LiteralPath $bundleDirectory -PathType Container)) {
    throw "Windows NSIS bundle directory is missing: $bundleDirectory"
  }
  $setups = @(
    Get-ChildItem -LiteralPath $bundleDirectory -Filter "*-setup.exe" -File
  )
  if ($setups.Count -ne 1) {
    throw "expected exactly one Windows NSIS setup executable"
  }
  return [System.IO.Path]::GetFullPath($setups[0].FullName)
}

function Invoke-CheckedProcess(
  [string]$FilePath,
  [string[]]$ArgumentList,
  [string]$Label
) {
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  foreach ($argument in $ArgumentList) {
    $startInfo.ArgumentList.Add($argument)
  }
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) {
    throw "$Label did not start"
  }
  try {
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
      throw "$Label exited with code $($process.ExitCode)"
    }
  }
  finally {
    $process.Dispose()
  }
}

function Assert-AppPath {
  if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
    throw "Windows desktop executable is missing: $appPath"
  }
  $installPrefix = $installRoot.TrimEnd("\") + "\"
  if (-not $appPath.StartsWith(
    $installPrefix,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Windows desktop executable escaped the install root"
  }
}

function Assert-NativeSidecars {
  $installPrefix = $installRoot.TrimEnd("\") + "\"
  foreach ($sidecar in @($hmuxRuntimePath, $hmuxCliPath)) {
    if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) {
      throw "Windows desktop sidecar is missing: $sidecar"
    }
    if (-not $sidecar.StartsWith(
      $installPrefix,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      throw "Windows desktop sidecar escaped the install root: $sidecar"
    }
  }

  $buildInfoText = (
    & $hmuxRuntimePath "--no-autostart" "hmux-build-info" | Out-String
  ).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "bundled Windows Hmux runtime did not report build information"
  }
  $buildInfo = $buildInfoText | ConvertFrom-Json
  if ($buildInfo.productProfile -ne "structured-terminal-v1") {
    throw "bundled Windows Hmux runtime has the wrong product profile"
  }

  $cliHelp = (& $hmuxCliPath "--help" 2>&1 | Out-String)
  if (
    $LASTEXITCODE -ne 0 -or
    -not $cliHelp.Contains("Attach to and inspect Hmux sessions")
  ) {
    throw "bundled Windows Hmux CLI did not expose its reviewed command surface"
  }
  Write-Output "native Windows Hmux sidecars are executable"
}

function Write-Receipt(
  [AllowNull()][System.Diagnostics.Process]$Process,
  [IntPtr]$WindowHandle,
  [string]$InstallerPath
) {
  $processId = 0
  $executablePath = $appPath
  $startedUtcTicks = 0
  if ($null -ne $Process) {
    $processId = $Process.Id
    $executablePath = $Process.Path
    $startedUtcTicks = $Process.StartTime.ToUniversalTime().Ticks
  }
  $receipt = [ordered]@{
    schemaVersion = 2
    installRoot = $installRoot
    installerPath = $InstallerPath
    processId = $processId
    executablePath = $executablePath
    startedUtcTicks = $startedUtcTicks
    windowHandle = $WindowHandle.ToInt64()
  }
  $receipt | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding utf8
}

if ($Mode -eq "Launch") {
  Assert-OwnedInstallRoot
  if (Test-Path -LiteralPath $receiptPath) {
    throw "Windows desktop smoke receipt already exists: $receiptPath"
  }
  if (Test-Path -LiteralPath $installRoot) {
    throw "Windows desktop install root already exists: $installRoot"
  }

  $installerPath = Resolve-Installer
  Write-Receipt -Process $null -WindowHandle ([IntPtr]::Zero) -InstallerPath $installerPath
  Invoke-CheckedProcess `
    -FilePath $installerPath `
    -ArgumentList @("/S", "/NS", "/D=$installRoot") `
    -Label "Windows NSIS installer"
  Assert-AppPath
  Assert-NativeSidecars

  $launched = Start-Process -FilePath $appPath -PassThru
  $observed = Get-Process -Id $launched.Id -ErrorAction Stop
  Write-Receipt `
    -Process $observed `
    -WindowHandle ([IntPtr]::Zero) `
    -InstallerPath $installerPath

  $windowHandle = [IntPtr]::Zero
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    $observed = Get-Process -Id $launched.Id -ErrorAction Stop
    $windowHandle = [DureWindowProbe]::FindVisibleWindow([uint32]$observed.Id)
    if ($windowHandle -ne [IntPtr]::Zero) {
      break
    }
  }
  if ($windowHandle -eq [IntPtr]::Zero) {
    throw "Dure did not expose a visible Windows window within 15 seconds"
  }
  Write-Receipt `
    -Process $observed `
    -WindowHandle $windowHandle `
    -InstallerPath $installerPath
  Write-Output "visible installed Dure window ready: pid=$($observed.Id) handle=$($windowHandle.ToInt64())"
  exit 0
}

if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
  Write-Output "No Windows desktop smoke receipt exists; nothing to stop"
  exit 0
}

$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
Assert-OwnedInstallRoot
if (
  $receipt.schemaVersion -ne 2 -or
  -not [string]::Equals(
    $receipt.installRoot,
    $installRoot,
    [System.StringComparison]::OrdinalIgnoreCase
  )
) {
  throw "Windows desktop smoke receipt is invalid"
}

$ownedProcess = $null
$verificationFailure = $null
$stopFailure = $null
try {
  if ($receipt.processId -gt 0) {
    $candidate = Get-Process -Id $receipt.processId -ErrorAction Stop
    if (-not [string]::Equals(
      $candidate.Path,
      $receipt.executablePath,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      throw "Windows desktop smoke process executable changed"
    }
    if ($candidate.StartTime.ToUniversalTime().Ticks -ne $receipt.startedUtcTicks) {
      throw "Windows desktop smoke process generation changed"
    }
    $ownedProcess = $candidate
    if ($receipt.windowHandle -gt 0) {
      $windowHandle = [DureWindowProbe]::FindVisibleWindow([uint32]$candidate.Id)
      if ($windowHandle -eq [IntPtr]::Zero) {
        throw "Dure no longer has a visible Windows window"
      }
      if ($windowHandle.ToInt64() -ne $receipt.windowHandle) {
        throw "Dure Windows window identity changed"
      }
      Write-Output "verified installed Dure cold launch: pid=$($candidate.Id) handle=$($windowHandle.ToInt64())"
    }
  }
}
catch {
  $verificationFailure = $_
}
finally {
  if ($null -ne $ownedProcess) {
    try {
      Stop-Process -InputObject $ownedProcess
      if (-not $ownedProcess.WaitForExit(10000)) {
        throw "Dure Windows process did not exit after an exact-generation stop"
      }
    }
    catch {
      $stopFailure = $_
    }
  }
}

$uninstallerPath = Join-Path $installRoot "uninstall.exe"
if (Test-Path -LiteralPath $uninstallerPath -PathType Leaf) {
  Invoke-CheckedProcess `
    -FilePath $uninstallerPath `
    -ArgumentList @("/S") `
    -Label "Windows NSIS uninstaller"
} elseif (Test-Path -LiteralPath $installRoot -PathType Container) {
  Remove-Item -LiteralPath $installRoot -Recurse -Force
}

for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
  if (-not (Test-Path -LiteralPath $installRoot)) {
    break
  }
  Start-Sleep -Milliseconds 250
}
if (Test-Path -LiteralPath $installRoot) {
  throw "Windows NSIS uninstaller left the install root behind: $installRoot"
}

Remove-Item -LiteralPath $receiptPath
if ($null -ne $verificationFailure) {
  throw $verificationFailure
}
if ($null -ne $stopFailure) {
  throw $stopFailure
}
