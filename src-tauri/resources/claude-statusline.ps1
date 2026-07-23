# AI Terminal managed Claude Code status line.
$rawInput = [Console]::In.ReadToEnd()
try { $data = $rawInput | ConvertFrom-Json } catch { exit 0 }

function Format-Tokens([double]$n) {
    if ($n -lt 1000) { return ('{0:0}' -f $n) }
    if ($n -lt 10000) { return ('{0:0.0}k' -f ($n / 1000)) }
    if ($n -lt 1000000) { return ('{0:0}k' -f ($n / 1000)) }
    if ($n -lt 10000000) { return ('{0:0.0}M' -f ($n / 1000000)) }
    return ('{0:0}M' -f ($n / 1000000))
}
function Number-OrZero($value) {
    if ($null -eq $value) { return [double]0 }
    return [double]$value
}

$model = if ($data.model.display_name) { [string]$data.model.display_name } elseif ($data.model.id) { [string]$data.model.id } else { 'Claude' }
$effort = if ($data.effort.level) { [string]$data.effort.level } else { 'default' }
$agent = if ($data.agent.name) { "Claude:$($data.agent.name)" } else { 'Claude' }
$rightPlain = "$agent · $model · $effort"
if ($data.fast_mode -eq $true) { $rightPlain += ' · Fast' }
$rightRest = $rightPlain.Substring($agent.Length)

$inputTokens = Number-OrZero $data.context_window.total_input_tokens
$outputTokens = Number-OrZero $data.context_window.total_output_tokens
$cacheRead = Number-OrZero $data.context_window.current_usage.cache_read_input_tokens
$cacheWrite = Number-OrZero $data.context_window.current_usage.cache_creation_input_tokens
$cost = Number-OrZero $data.cost.total_cost_usd
$subscription = $null -ne $data.rate_limits
$parts = [System.Collections.Generic.List[string]]::new()
if ($inputTokens -gt 0) { $parts.Add("↑$(Format-Tokens $inputTokens)") }
if ($outputTokens -gt 0) { $parts.Add("↓$(Format-Tokens $outputTokens)") }
if ($cacheRead -gt 0) { $parts.Add("R$(Format-Tokens $cacheRead)") }
if ($cacheWrite -gt 0) { $parts.Add("W$(Format-Tokens $cacheWrite)") }
if ($cacheRead -gt 0 -and $inputTokens -gt 0) { $parts.Add(('CH{0:0.0}%' -f ($cacheRead * 100 / $inputTokens))) }
if ($cost -gt 0 -or $subscription) {
    $costText = ('$' + ('{0:0.000}' -f $cost))
    if ($subscription) { $costText += ' (sub)' }
    $parts.Add($costText)
}
$windowText = Format-Tokens (Number-OrZero $data.context_window.context_window_size)
$contextText = if ($null -ne $data.context_window.used_percentage) {
    ('{0:0.0}%/{1} (auto)' -f [double]$data.context_window.used_percentage, $windowText)
} else { "?/$windowText (auto)" }
$parts.Add($contextText)
$left = $parts -join ' '

$cols = 80
if ($env:COLUMNS -match '^\d+$') { $cols = [int]$env:COLUMNS }
# Leave room for Claude's own status-line padding so it does not ellipsize the
# model/effort tail at the terminal's right edge.
$contentCols = [Math]::Max(20, $cols - 6)
$availableLeft = [Math]::Max(0, $contentCols - $rightPlain.Length - 2)
if ($left.Length -gt $availableLeft) {
    $costCompact = ('$' + ('{0:0.000}' -f $cost))
    if ($subscription) { $costCompact += ' (sub)' }
    $left = "$costCompact $contextText"
}
if ($left.Length -gt $availableLeft) { $left = $contextText }
if ($left.Length -gt $availableLeft) { $left = '' }
$padding = [Math]::Max(1, $contentCols - $left.Length - $rightPlain.Length)
$esc = [char]27
Write-Output ("${esc}[0m$left" + (' ' * $padding) + "${esc}[38;5;173m$agent${esc}[0m$rightRest${esc}[0m")
