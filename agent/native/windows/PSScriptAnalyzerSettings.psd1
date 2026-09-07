# PSScriptAnalyzer configuration for the Windows shell layer (agent/native/windows/**),
# the PowerShell analog of the repo's ShellCheck gate. It runs every default rule EXCEPT
# a handful of pure-convention ones that fight this code's shape without catching a
# defect — the same spirit in which the bash layer uses `|| true` freely:
#
#   PSUseApprovedVerbs / PSUseSingularNouns  — house naming (Report-Creds, Get-ConfigErrors)
#                                              is clearer here than the approved-verb rewrite.
#   PSUseShouldProcessForStateChangingFunctions — these are a launcher's internal helpers,
#                                              not exported cmdlets an operator -WhatIf's.
#   PSAvoidUsingEmptyCatchBlock              — best-effort process kills / cleanup, the
#                                              deliberate twin of the bash `2>/dev/null || true`.
#   PSUseBOMForUnicodeEncodedFile            — a BOM would corrupt a `#!/usr/bin/env pwsh`
#                                              shebang and is not wanted on these files.
#
# Correctness rules (assignment to automatic variables, uninitialised vars, unreachable
# code, etc.) stay ON, and any Error-severity finding fails the gate.
@{
    ExcludeRules = @(
        'PSUseApprovedVerbs'
        'PSUseSingularNouns'
        'PSUseShouldProcessForStateChangingFunctions'
        'PSAvoidUsingEmptyCatchBlock'
        'PSUseBOMForUnicodeEncodedFile'
    )
}
