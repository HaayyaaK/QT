# Deployment Checklist — Production IIS Testing

Moving this dashboard + its proxy from dev to the hosting device, to measure the real-world
Kraken checksum drift rate (see `PROJECT_STATUS.md`) and confirm the three fixes in commit
`0ab4020` hold up outside the dev environment.

## What to copy

This is a flat, single-directory repo — there's no `/src` or `/test` subfolder to worry about.
Copy the **whole repo folder** as-is:

- `TradingDashboard.html`, `cryptoProviders.js`, `cryptoProviders.test.js`, `taEngine.js`,
  `taEngine.test.js`, `support.js`, `web.config`, `iis-setup.ps1`, `package.json`, `README.md`,
  `PROJECT_STATUS.md`, this file, `.gitignore`, `.vscode/`.
- No `node_modules/` to bring — `npm test` uses Node's built-in test runner, zero dependencies.

Separately, copy **`C:\proxy-server`** (a distinct project, not part of this repo — see its own
README). It needs its own `.env` (copy `.env.example` and fill in real API keys on the hosting
device — **do not commit or copy a populated `.env` through this repo's git history**, it isn't
tracked here for exactly that reason).

## Path assumptions to check before running `iis-setup.ps1`

`iis-setup.ps1` hardcodes the site's physical path:

```powershell
$physicalPath = 'C:\Users\Haayy\Documents\MyPersonal\Trading Dashboard DC'
```

If the hosting device will have this repo at a **different** path, edit that line first —
`New-Website -PhysicalPath $physicalPath` uses it literally at site-creation time. If the
hosting device happens to use the same Windows username and you place the repo at the identical
path, no edit needed.

The proxy's location is **not** path-sensitive the same way: `web.config`'s ARR rewrite rule
targets `http://127.0.0.1:8787` (a loopback port), not a file path. `C:\proxy-server` on the
hosting device just needs to be wherever you choose to run `npm start` from — it doesn't have to
match the dev machine's path, as long as it's listening on 127.0.0.1:8787 when IIS starts
serving requests.

## Checklist

**On the hosting device:**

- [ ] Copy this repo folder to its target location (matching `iis-setup.ps1`'s `$physicalPath`,
      or edit that line to match wherever you put it)
- [ ] Copy `C:\proxy-server` (or your chosen location) separately
- [ ] In the proxy folder: `copy .env.example .env`, fill in real API keys, `npm start`
- [ ] Confirm `npm test` passes in the dashboard repo (40/40 expected) before touching IIS
- [ ] Run `iis-setup.ps1` elevated (Run as Administrator) — idempotent, safe to re-run,
      doesn't touch any existing unrelated site
- [ ] Verify the reverse-proxy path end-to-end, independent of DNS/Cloudflare (see README's
      "Production deployment (IIS)" section for the exact `curl.exe -H "Host: ..."` command)
- [ ] Load the dashboard in a real browser against the production URL (not `file://`, not
      localhost) with DevTools open

**Measuring the checksum drift rate:**

- [ ] Watch the console for `[WARN] Kraken book checksum mismatch` over a sustained window
      (10-15 minutes)
- [ ] Record: how many mismatches, average interval between them, any visible order-book
      hiccup when one occurs
- [ ] Compare against the dev-machine baseline in `PROJECT_STATUS.md` (~1 per 10-15s) — much
      lower suggests the dev-network path itself was the driver; similar suggests it's inherent
      to this delta stream regardless of network

**Also worth re-confirming on production** (cheap to check while already testing):

- [ ] Full failover chain still transitions cleanly (Kraken → Bitstamp → Gemini → Binance)
- [ ] No double-connect on page load (should be fixed by commit `0ab4020`, but confirm — a
      different browser/OS combination is a fair thing to double-check)
- [ ] Recovery cooldown holds (no rapid flapping after a forced failover)

## Reporting back

Once you have production numbers, update the "Open item: live drift rate" section in
`PROJECT_STATUS.md` with what was actually observed, and note whether it changes the assessment
of the checksum feature's real-world behavior.
