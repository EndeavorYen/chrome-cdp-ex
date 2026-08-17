# chrome-cdp-ex

> **Unreleased candidate:** repository metadata is v2.16.0; install links remain pinned to published v2.15.0.

[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)](skills/chrome-cdp-ex/scripts/cdp.mjs)
[![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](https://nodejs.org)
[![Release v2.15.0](https://img.shields.io/badge/release-v2.15.0-brightgreen)](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.15.0)
[![MIT License](https://img.shields.io/badge/license-MIT-gray)](LICENSE)

**Use the browser you already have open.**

Your agent already has Chrome. What it usually gets is a fat page snapshot — lots of hops, a pile of tokens — or a fresh automated browser that is not the tab with your cookies. chrome-cdp-ex attaches to that live session and does the common jobs in **one step**, with a **short receipt**.

Fat snapshot. Empty PDF. Overlay up, and the snapshot still looks clear. One command. Skinny evidence. The tab you already have.

Playwright is for clean isolated tests. This is for the session that already has your login.

## One step. Skinny receipt.

Measured 2026-08-17. chrome-cdp-ex and Browser Use on main `22c525d4` (page-level Chrome). Playwright: independent headed Chromium, same machine. Viewport 1042×632. n=3 median.

<table>
  <thead>
    <tr>
      <th rowspan="2">job</th>
      <th colspan="4">chrome-cdp-ex</th>
      <th colspan="4">Browser Use</th>
      <th colspan="4">Playwright</th>
    </tr>
    <tr>
      <th>success</th><th>steps</th><th>time</th><th>token</th>
      <th>success</th><th>steps</th><th>time</th><th>token</th>
      <th>success</th><th>steps</th><th>time</th><th>token</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>scroll to bottom (HF home)</td>
      <td>PASS</td><td>1</td><td>139</td><td>62</td>
      <td>PASS</td><td>1</td><td>227</td><td>118</td>
      <td>PASS</td><td>1</td><td>2</td><td>41</td>
    </tr>
    <tr>
      <td>nested overflow (Comfy <code>#content-container</code>)</td>
      <td>PASS</td><td>1</td><td>144</td><td>83</td>
      <td>PASS</td><td>3</td><td>391</td><td>6307</td>
      <td>PASS</td><td>1</td><td>72</td><td>70</td>
    </tr>
    <tr>
      <td>click Browse 2M+ models</td>
      <td>PASS</td><td>1</td><td>487</td><td>549</td>
      <td>PASS</td><td>2</td><td>507</td><td>7636</td>
      <td>PASS</td><td>1</td><td>352</td><td>0</td>
    </tr>
    <tr>
      <td>search submit bert</td>
      <td>PASS</td><td>1</td><td>410</td><td>114</td>
      <td>PASS</td><td>5</td><td>1261</td><td>770</td>
      <td>PASS</td><td>2</td><td>1047</td><td>0</td>
    </tr>
    <tr>
      <td>nav example.org</td>
      <td>PASS</td><td>1</td><td>297</td><td>69</td>
      <td>PASS</td><td>1</td><td>16</td><td>86</td>
      <td>PASS</td><td>1</td><td>12</td><td>35</td>
    </tr>
    <tr>
      <td>read HF home</td>
      <td>PASS</td><td>1</td><td>152</td><td>3863</td>
      <td>PASS</td><td>1</td><td>6</td><td>7540</td>
      <td>PASS</td><td>1</td><td>3</td><td>4427</td>
    </tr>
    <tr>
      <td>hover reveal</td>
      <td>PASS</td><td>1</td><td>145</td><td>192</td>
      <td>PASS</td><td>2</td><td>14</td><td>12025</td>
      <td>PASS</td><td>1</td><td>67</td><td>0</td>
    </tr>
    <tr>
      <td>PDF text one page</td>
      <td>PASS</td><td>1</td><td>232</td><td>4323</td>
      <td>FAIL</td><td>1</td><td>5</td><td>94</td>
      <td>FAIL</td><td>1</td><td>2</td><td>0</td>
    </tr>
    <tr>
      <td>overlay detect</td>
      <td>PASS</td><td>1</td><td>142</td><td>232</td>
      <td>FAIL</td><td>1</td><td>21</td><td>35139</td>
      <td>PASS</td><td>1</td><td>1</td><td>178</td>
    </tr>
    <tr>
      <td>click Browse 1M+ applications</td>
      <td>PASS</td><td>1</td><td>457</td><td>580</td>
      <td>PASS</td><td>2</td><td>625</td><td>7640</td>
      <td>PASS</td><td>1</td><td>318</td><td>0</td>
    </tr>
  </tbody>
</table>

**time** is wall ms. token = UTF-8 characters each tool returned to the agent. Playwright void click/hover = 0. No invented snapshot.

Same overlay ruler: overlay still up + a snapshot that looks like a cleared page = FAIL. Playwright is PASS because the operate evaluate reported **blocking**, not clear, while `#sp_message_container_1476394` was still `display=block` `visibility=visible` `opacity=1` rect `(0,0 1042×632)`, mid `sp_message_iframe_1476394`. Did not dismiss. Browser Use FAIL: snapshot looked clear while that overlay was visible.

PDF: Playwright FAIL as measured (empty `innerText`, no `AI4AI`). Browser Use FAIL too. chrome-cdp-ex PASS, 1 step, 232 ms, 4323 tokens.

Playwright is quicker on the clock for most of these jobs. The win is steps, tokens, and the jobs others fail.

## Start

Needs Node.js 22 (built-in WebSocket). This project does **not** publish to the npm registry.

**Pinned release (v2.15.0):**

```bash
curl -L -o pi-chrome-cdp-2.15.0.tgz https://github.com/EndeavorYen/chrome-cdp-ex/releases/download/v2.15.0/pi-chrome-cdp-2.15.0.tgz
mkdir -p chrome-cdp-ex-v2.15.0
tar -xzf pi-chrome-cdp-2.15.0.tgz -C chrome-cdp-ex-v2.15.0 --strip-components=1
cd chrome-cdp-ex-v2.15.0
```

Checksum is on the [GitHub Release](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.15.0).

**Current `main`:**

```bash
git clone https://github.com/EndeavorYen/chrome-cdp-ex.git
cd chrome-cdp-ex
```

Then:

```bash
./bin/chrome-cdp doctor
./bin/chrome-cdp list
```

If `node -v` is <22, doctor prints a Node 22 path (`./bin/chrome-cdp` re-execs it when found). Turn on remote debugging at `chrome://inspect/#remote-debugging` (or `edge://inspect`) so it can attach to the browser you already have open.

Command map: [docs/reference.md](docs/reference.md). Skill: [SKILL.md](skills/chrome-cdp-ex/SKILL.md). Host wiring: [INTEGRATIONS.md](INTEGRATIONS.md).

## License

[MIT](LICENSE)

Built on [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) by Petr Baudis. Contributors: [ynezz](https://github.com/ynezz), [Jah-yee](https://github.com/Jah-yee), [Rolf Fredheim](https://github.com/rolfredheim), [hussainweb](https://github.com/hussainweb).
