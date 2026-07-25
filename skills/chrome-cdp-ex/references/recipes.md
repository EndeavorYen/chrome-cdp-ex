# chrome-cdp-ex recipes

Situational playbooks for common live-browser work. Commands use repository-relative invocations; replace `<target>`, selectors, refs, and URLs with the live values from `list` / `perceive`.

| Situation | Start with | Goal |
| --- | --- | --- |
| Review this UI | `doctor`, `list`, `perceive` | Gather structured layout/content evidence before pixels. |
| Click did nothing | action evidence, `overlay`, `frame`, fresh `perceive` | Classify no-change instead of retrying blindly. |
| Why is this blue (cascade) | `cascade` | Find the winning CSS rule and source line. |
| Cannot close modal | `overlay`, `dismiss-modal` | Close the top modal without firing background shortcuts. |
| Multi-tab OAuth | `list`, `target`, `use` | Keep app and auth tabs straight through redirects. |
| Form fill + verify | `fill`, `verify-click`, `perceive --since-action` | Prove input and submit effects. |
| CSS inject prototype | `cascade`, `inject --css`, `inject --remove` | Test style changes live without editing source. |

## Review this UI

1. Confirm the bridge is healthy and discover the tab:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs doctor
node skills/chrome-cdp-ex/scripts/cdp.mjs list
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
```

2. Use the structured output first: headings, landmarks, visible text, element positions, style hints, and console health.
3. For subjective visual quality, capture only the relevant component:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs elshot <target> @3
node skills/chrome-cdp-ex/scripts/cdp.mjs shot <target> --annotate
```

4. Finish with a handoff if the review spans multiple actions:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs report <target>
```

## Click did nothing

1. Read the action evidence from the failed or no-change click before retrying:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs click <target> @5 --format json
```

2. If it says `no-change`, `overlay`, `wrong-frame`, `stale-ref`, or `selector`, run the printed recovery command. Useful manual probes:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs overlay <target> @5
node skills/chrome-cdp-ex/scripts/cdp.mjs frame <target> --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
```

3. Verify the intended semantic effect, not just dispatch:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs verify-click <target> @5 --expect-text "Saved"
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> --since-action
```

## Why is this blue (cascade)

Use `cascade` when you need to know which CSS rule wins and where to edit it:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
node skills/chrome-cdp-ex/scripts/cdp.mjs cascade <target> @3 background-color
node skills/chrome-cdp-ex/scripts/cdp.mjs cascade <target> ".btn-primary" background-color --format json
```

Read the winning rule, overridden rules, inherited values, source file, line number, and edit recommendation from the output.

## Cannot close modal

1. Diagnose what blocks the target:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs overlay <target>
node skills/chrome-cdp-ex/scripts/cdp.mjs overlay <target> @5
```

2. Prefer the modal-aware closer; it tries an explicit close control before Escape and avoids Space:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs dismiss-modal <target>
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> --since-action
```

3. If the overlay remains, run a fresh `perceive` and use the exact close button ref or selector.

## Multi-tab OAuth

1. Name the app tab before starting the auth flow:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs list
node skills/chrome-cdp-ex/scripts/cdp.mjs use <app-target> --name app
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive app -C -d 8
```

2. After clicking the sign-in control, list tabs and bind the provider tab:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs click app @7 --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs list
node skills/chrome-cdp-ex/scripts/cdp.mjs target --url accounts.google.com
node skills/chrome-cdp-ex/scripts/cdp.mjs use <oauth-target> --name oauth
```

3. Complete provider prompts on `oauth`, then return to `app` and verify the signed-in state:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive oauth -C -d 8
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive app -C -d 8
node skills/chrome-cdp-ex/scripts/cdp.mjs report app
```

## Form fill + verify

1. Perceive fresh refs and fill fields:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> -C -d 8
node skills/chrome-cdp-ex/scripts/cdp.mjs fill <target> @3 "Ada Lovelace" --format json
node skills/chrome-cdp-ex/scripts/cdp.mjs fill <target> @4 "ada@example.com" --format json
```

2. Submit and verify with expected text or request evidence:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs verify-click <target> @8 --expect-text "Thanks"
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> --since-action
node skills/chrome-cdp-ex/scripts/cdp.mjs report <target> --last 5
```

3. For React-controlled inputs that ignore plain filling, use the existing React setter path:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs fill <target> --react @3 "Ada Lovelace" --format json
```

## CSS inject prototype

1. Inspect the current source of the style:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs cascade <target> ".card" box-shadow
```

2. Inject a temporary CSS prototype:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs inject <target> --css ".card { box-shadow: 0 16px 40px rgba(15, 23, 42, 0.18); }"
node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> --since-action
node skills/chrome-cdp-ex/scripts/cdp.mjs elshot <target> ".card"
```

3. Remove all injected elements before handing off or testing source edits:

```bash
node skills/chrome-cdp-ex/scripts/cdp.mjs inject <target> --remove
node skills/chrome-cdp-ex/scripts/cdp.mjs report <target>
```
