<#
  One-time IIS setup for the Quant/Terminal dashboard.

  Run this yourself in an elevated PowerShell (Run as Administrator) —
  it was deliberately NOT run automatically: it modifies live IIS server
  state (new site, new app pool, a server-wide ARR setting) on a machine
  that's also hosting hayyaak.com's real site, and that's the kind of
  change that should get a human's eyes on it first.

  Idempotent: safe to re-run. Existing site/pool/setting is left alone
  rather than duplicated or reset.

  What this does NOT do (out of scope / needs your action separately):
    - DNS: trade.hayyaak.com currently has no DNS record at all (checked
      2026-08-01). forex.hayyaak.com and hayyaak.trade already resolve to
      Cloudflare IPs, matching hayyaak.com's own pattern — but whether
      Cloudflare is actually configured to route those to THIS machine as
      the origin is set in your Cloudflare dashboard, not here.
    - SSL/TLS: no certificate is bound to these new bindings. If Cloudflare
      is in "Flexible" SSL mode for this zone, that's fine — Cloudflare
      terminates HTTPS at its edge and talks to this origin over plain
      HTTP, which is exactly what these http-only bindings expect. If
      Cloudflare is in "Full" or "Full (strict)" mode, or if you want TLS
      directly on this box, you need a certificate bound to real HTTPS
      bindings — this script doesn't create those since it can't obtain a
      certificate on your behalf.
    - Firewall / router port-forwarding for 80/443 to this machine — not
      configurable from IIS.
#>

$ErrorActionPreference = 'Stop'

$siteName     = 'QuantTerminal'
$poolName     = 'QuantTerminalPool'
$physicalPath = 'C:\inetpub\wwwroot\projects\hayyaak_QT'
$hostnames    = @('fx.hayyaak.com')

Import-Module WebAdministration

# --- App pool: No Managed Code (static site, no ASP.NET) -------------------
if (-not (Test-Path "IIS:\AppPools\$poolName")) {
    New-WebAppPool -Name $poolName | Out-Null
    Set-ItemProperty "IIS:\AppPools\$poolName" -Name managedRuntimeVersion -Value ''
    Write-Host "Created app pool '$poolName' (No Managed Code)."
} else {
    Write-Host "App pool '$poolName' already exists — leaving it as-is."
}

# --- Site + bindings ---------------------------------------------------------
if (-not (Test-Path "IIS:\Sites\$siteName")) {
    $firstBinding = "*:80:$($hostnames[0])"
    New-Website -Name $siteName -PhysicalPath $physicalPath -ApplicationPool $poolName `
        -HostHeader $hostnames[0] -Port 80 | Out-Null
    Write-Host "Created site '$siteName' bound to $($hostnames[0])."
    foreach ($h in ($hostnames | Select-Object -Skip 1)) {
        New-WebBinding -Name $siteName -Protocol http -Port 80 -HostHeader $h
        Write-Host "Added binding for $h."
    }
} else {
    Write-Host "Site '$siteName' already exists — checking bindings only."
    $existing = (Get-WebBinding -Name $siteName | Select-Object -ExpandProperty bindingInformation)
    foreach ($h in $hostnames) {
        $already = $existing | Where-Object { $_ -like "*:80:$h" }
        if (-not $already) {
            New-WebBinding -Name $siteName -Protocol http -Port 80 -HostHeader $h
            Write-Host "Added missing binding for $h."
        } else {
            Write-Host "Binding for $h already present."
        }
    }
}

# --- ARR reverse-proxy feature (server-wide, required for web.config's
#     ProxyApi rule to actually forward instead of failing) -----------------
$proxyEnabled = Get-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' `
    -Filter 'system.webServer/proxy' -Name enabled -ErrorAction SilentlyContinue
if (-not $proxyEnabled -or $proxyEnabled.Value -ne $true) {
    Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' `
        -Filter 'system.webServer/proxy' -Name enabled -Value $true
    Write-Host "Enabled ARR reverse-proxy feature server-wide (affects only rules that explicitly use it — no other site's behavior changes)."
} else {
    Write-Host "ARR reverse-proxy feature already enabled."
}

Write-Host ""
Write-Host "Done. Verify with: & 'C:\Windows\System32\inetsrv\appcmd.exe' list site `"$siteName`""
Write-Host "Then, with the proxy running (cd C:\proxy-server; npm start), test from this machine:"
Write-Host "  curl.exe -H `"Host: fx.hayyaak.com`" http://127.0.0.1/api/fx/klines?symbol=EURUSD"
Write-Host "That confirms IIS -> ARR -> the Node proxy end-to-end, independent of DNS/Cloudflare."
