## Admiral Agent Monitor — 5-minute loop
## Checks agent status + recent logs for patterns/errors

$baseUrl = "http://localhost:3031/api"
$interval = 300  # 5 minutes

function Get-AgentSummary {
    $profiles = Invoke-RestMethod "$baseUrl/profiles"
    
    Write-Host "`n$(Get-Date -Format 'HH:mm:ss') ========== AGENT STATUS CHECK ==========" -ForegroundColor Cyan
    Write-Host ""
    
    foreach ($p in $profiles) {
        $gs = $p.gameState
        $fuel = if ($gs.ship.fuel) { $gs.ship.fuel } else { "?" }
        $cargo = if ($gs.ship.cargo) { $gs.ship.cargo } else { "?" }
        $status = if ($p.running) { "RUNNING" } else { "STOPPED" }
        $conn = if ($p.connected) { "OK" } else { "DISC" }
        
        $color = if (-not $p.running -or -not $p.connected) { "Red" } 
                 elseif ($p.activity -match "Error|error|fail") { "Yellow" }
                 else { "Green" }
        
        Write-Host "[$conn/$status] $($p.name)" -ForegroundColor $color -NoNewline
        Write-Host " | $($gs.credits)cr | $($gs.system) | Fuel:$fuel | Cargo:$cargo" -NoNewline
        Write-Host " | $($p.activity)" -ForegroundColor DarkGray
        
        # Pull recent logs
        try {
            $logs = Invoke-RestMethod "$baseUrl/profiles/$($p.id)/logs"
            $recent = $logs | Select-Object -Last 20
            
            $errors = @()
            $toolErrors = @()
            $cooldowns = 0
            $invalidParams = @()
            $repeatedActions = @()
            
            foreach ($log in $recent) {
                $s = $log.summary
                $d = $log.detail
                $t = $log.type
                
                # Count cooldown hits
                if ($s -match "cooldown active|ACTION BLOCKED") { $cooldowns++ }
                
                # Collect tool errors
                if ($t -eq "tool_result" -and $s -match "^Error:") {
                    $toolErrors += "  ERR: $s"
                }
                
                # Invalid param patterns  
                if ($s -match "invalid_payload|Unknown|invalid_poi|invalid_type") {
                    $invalidParams += "  BAD_PARAM: $s"
                }
            }
            
            # Report issues
            if ($cooldowns -gt 0) {
                Write-Host "  [!] $cooldowns cooldown hits in last 20 entries" -ForegroundColor Yellow
            }
            if ($toolErrors.Count -gt 0) {
                foreach ($e in ($toolErrors | Select-Object -Unique)) {
                    Write-Host "  $e" -ForegroundColor Red
                }
            }
            if ($invalidParams.Count -gt 0) {
                foreach ($e in ($invalidParams | Select-Object -Unique)) {
                    Write-Host "  $e" -ForegroundColor Magenta
                }
            }
        } catch {
            Write-Host "  [!] Could not fetch logs: $_" -ForegroundColor Red
        }
    }
    
    Write-Host "`n--- Patterns to watch: cooldowns, invalid_payload, invalid_poi, repeated errors ---" -ForegroundColor DarkGray
    Write-Host "Next check in $($interval/60) minutes..." -ForegroundColor DarkGray
}

# Run immediately, then loop
while ($true) {
    try {
        Get-AgentSummary
    } catch {
        Write-Host "$(Get-Date -Format 'HH:mm:ss') Monitor error: $_" -ForegroundColor Red
    }
    
    # Wait 5 minutes (check every 10s if we should abort)
    $waited = 0
    while ($waited -lt $interval) {
        $waited += 10
        # Just yield, don't use Start-Sleep — instead use a .NET timer
        [System.Threading.Thread]::Sleep(10000)
    }
}
