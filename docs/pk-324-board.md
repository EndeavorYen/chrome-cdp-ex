# Live-session PK board (issue #324)

Measured 2026-08-17. chrome-cdp-ex and Browser Use on main `22c525d4` (page-level Chrome). Playwright: same machine, headed Chromium, 1042×632, n=3 median. Token = UTF-8 characters each tool returned to the agent. Playwright void click/hover = 0. No invented snapshot.

Win score for the 10 jobs: chrome-cdp-ex **10 PASS**, Browser Use **8 PASS**, Playwright **9 PASS**.

README first screen keeps that score and the steps / token / time bar charts. This page is the engineer grid.

| job | chrome-cdp-ex success / steps / time / token | Browser Use | Playwright |
|---|---|---|---|
| scroll to bottom (HF home) | PASS / 1 / 139 / 62 | PASS / 1 / 227 / 118 | PASS / 1 / 2 / 41 |
| nested overflow (Comfy `#content-container`) | PASS / 1 / 144 / 83 | PASS / 3 / 391 / 6307 | PASS / 1 / 72 / 70 |
| click Browse 2M+ models | PASS / 1 / 487 / 549 | PASS / 2 / 507 / 7636 | PASS / 1 / 352 / 0 |
| search submit bert | PASS / 1 / 410 / 114 | PASS / 5 / 1261 / 770 | PASS / 2 / 1047 / 0 |
| nav example.org | PASS / 1 / 297 / 69 | PASS / 1 / 16 / 86 | PASS / 1 / 12 / 35 |
| read HF home | PASS / 1 / 152 / 3863 | PASS / 1 / 6 / 7540 | PASS / 1 / 3 / 4427 |
| hover reveal | PASS / 1 / 145 / 192 | PASS / 2 / 14 / 12025 | PASS / 1 / 67 / 0 |
| PDF text one page | PASS / 1 / 232 / 4323 | FAIL / 1 / 5 / 94 | FAIL / 1 / 2 / 0 |
| overlay detect | PASS / 1 / 142 / 232 | FAIL / 1 / 21 / 35139 | PASS / 1 / 1 / 178 |
| click Browse 1M+ applications | PASS / 1 / 457 / 580 | PASS / 2 / 625 / 7640 | PASS / 1 / 318 / 0 |

## Notes that travel with this board

- time is wall ms. token = UTF-8 chars returned to the agent. Playwright void click/hover = 0. No invented snapshot.
- Do not average time across these heterogeneous jobs. Four jobs chrome-cdp-ex is slower than Browser Use on wall clock: nav example.org (297 vs 16), read HF home (152 vs 6), hover reveal (145 vs 14), overlay detect (142 vs 21).
- Overlay ruler: overlay still up + snapshot looks like a cleared page = FAIL. Playwright PASS because operate evaluate reported **blocking**, not clear, while `#sp_message_container_1476394` was still display=block visibility=visible opacity=1 rect (0,0 1042×632), mid `sp_message_iframe_1476394`. Did not dismiss. Browser Use FAIL: snapshot looked clear while that overlay was visible.
- PDF: Playwright FAIL (empty innerText, no AI4AI). Browser Use FAIL too. chrome-cdp-ex PASS.
