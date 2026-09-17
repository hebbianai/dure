$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$fullControl = [Security.AccessControl.FileSystemRights]::FullControl

function New-PrivateSecurity([bool] $directory) {
    $security = if ($directory) {
        [Security.AccessControl.DirectorySecurity]::new()
    } else {
        [Security.AccessControl.FileSecurity]::new()
    }
    $security.SetOwner($owner)
    $security.SetAccessRuleProtection($true, $false)
    $inheritance = if ($directory) {
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    foreach ($sid in @($owner, $system)) {
        $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $sid, $fullControl, $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        ))
    }
    return $security
}

function Assert-PrivateSecurity($security) {
    if (-not $security.GetOwner([Security.Principal.SecurityIdentifier]).Equals($owner) -or
        -not $security.AreAccessRulesProtected) {
        throw 'The owner or inherited permissions are not private.'
    }
    $principals = @{}
    foreach ($rule in $security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        $sid = $rule.IdentityReference
        if ($rule.IsInherited -or
            $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.FileSystemRights -ne $fullControl -or
            $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or
            (-not $sid.Equals($owner) -and -not $sid.Equals($system))) {
            throw 'Permissions must grant access only to the current user and SYSTEM.'
        }
        $principals[$sid.Value] = $true
    }
    if (-not $principals.ContainsKey($owner.Value) -or -not $principals.ContainsKey($system.Value)) {
        throw 'Private user and SYSTEM permissions are missing.'
    }
}

function Assert-PathType([string] $pathname, [bool] $directory) {
    $attributes = [IO.File]::GetAttributes($pathname)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        (($attributes -band [IO.FileAttributes]::Directory) -ne 0) -ne $directory) {
        throw "The private storage path has an unsafe type: $pathname"
    }
}

function Assert-PrivatePath([string] $pathname, [bool] $directory) {
    Assert-PathType $pathname $directory
    $sections = [Security.AccessControl.AccessControlSections]'Owner, Access'
    $security = if ($directory) {
        [IO.Directory]::GetAccessControl($pathname, $sections)
    } else {
        [IO.File]::GetAccessControl($pathname, $sections)
    }
    Assert-PrivateSecurity $security
}

function Invoke-PrivateStorage($request) {
    switch ($request.operation) {
        'directory' {
            if ($request.create) {
                # Existing directories are inspected, never reowned or repaired.
                [void][IO.Directory]::CreateDirectory($request.pathname, (New-PrivateSecurity $true))
            }
            Assert-PrivatePath $request.pathname $true
        }
        'inspect' {
            Assert-PrivatePath $request.directory $true
            Assert-PrivatePath $request.pathname $false
        }
        { $_ -in 'createFile', 'ensureFile' } {
            $create = $request.operation -eq 'createFile'
            if (-not $create) {
                try {
                    Assert-PathType $request.pathname $false
                } catch [IO.FileNotFoundException] {
                    # The OpenOrCreate constructor applies the ACL before publication.
                }
            }
            $mode = if ($create) { [IO.FileMode]::CreateNew } else { [IO.FileMode]::OpenOrCreate }
            $stream = [IO.FileStream]::new(
                $request.pathname, $mode, $fullControl, [IO.FileShare]'ReadWrite, Delete',
                4096, [IO.FileOptions]::None, (New-PrivateSecurity $false)
            )
            try {
                if ($create) {
                    $bytes = [Convert]::FromBase64String($request.sourceBase64)
                    $stream.Write($bytes, 0, $bytes.Length)
                    $stream.Flush($true)
                } else {
                    Assert-PrivateSecurity ($stream.GetAccessControl())
                }
            } finally {
                $stream.Dispose()
            }
        }
        default { throw 'Unknown private storage operation.' }
    }
}

try {
    # Load the built-in parser directly; isolated profiles must not trigger module discovery.
    Import-Module ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'))
    foreach ($request in ([Console]::In.ReadToEnd() | ConvertFrom-Json)) {
        Invoke-PrivateStorage $request
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
    exit 1
}
