# Codex for OSS Phase 0 Design

## Objective

Prepare a claim-honest launch and application evidence surface for `chrome-cdp-ex` v2.14.0 before any external promotion. Phase 0 must prove the current release with a fresh live benchmark, publish a reproducible Codex-host validation path, provide a host capability matrix, produce a short demo from safe local fixtures, and freeze an adoption baseline.

## Scope

Phase 0 changes only this repository and a feature worktree. It does not submit the Codex for OSS form, open external pull requests, post to communities, publish a GitHub Release, or modify the user's live browser profile. All browser evidence comes from disposable local debug-browser fixtures.

## Evidence Model

The repository will add a versioned `chrome-cdp-ex.host-validation.v1` manifest. Each supported host has one of three statuses:

- `documented`: installation and routing instructions exist, but no current host smoke is claimed.
- `setup-smoke`: configuration generation or MCP initialization was exercised without a full live browser loop.
- `live-validated`: the host route completed install/setup, live perception, mutation with Action Receipt, causal follow-up perception, and report handoff against a safe local fixture.

Only Codex is promoted to `live-validated` in Phase 0. Cross-host support remains documented without implying that every host was exercised in this run.

## Deliverables

### Current release proof

Run the existing ten-round mixed campaign against v2.14.0, covering MCP, CLI, Killer Path, large-app stress, and all five real-app profiles. Update the README and benchmark HTML only when all campaign gates pass. Keep the raw campaign JSON as a local verification artifact rather than committing a large generated trace.

### Codex Killer Path

Publish `docs/examples/codex-killer-path.md` with the exact Codex skill installation route and the validated sequence:

```text
install -> setup -> doctor -> list/open -> perceive -> act -> Action Receipt -> perceive --since-action -> report
```

The document identifies the validation date, release, environment, safe fixture boundary, commands, expected evidence schemas, and limits of the claim. It does not claim a native Codex plugin, hosted service, or validation of a personal logged-in page.

### Host Validation Matrix

Publish `docs/benchmarks/host-validation.v1.json` as the machine-readable source and render a concise human matrix in `INTEGRATIONS.md`. A deterministic checker rejects version drift, unknown statuses, missing supported hosts, duplicate hosts, missing evidence paths, invalid validation dates, or a `live-validated` entry without the required capability evidence.

### Demo

Produce a 60-second MP4 and poster image from safe local-fixture evidence. The demo shows the problem, Codex route, live perception, action evidence, causal follow-up, report handoff, and the claim boundary. It contains no cookies, personal tabs, credentials, or private page content.

### Application Evidence Baseline

Publish `docs/outreach/codex-for-oss-evidence.md` with a dated snapshot of repository activity, traffic, releases/downloads, external contribution, curated recognition, Codex maintenance history, and remaining adoption gaps. Separate direct adoption from mirrors, search indexes, and ecosystem recognition.

## Claim Boundaries

- `Validated with Codex` means the documented Codex CLI-skill route completed the safe live loop in this Phase 0 run.
- The v2.14.0 benchmark replaces the stale v2.12.0 release snapshot only after a passing ten-round campaign.
- GitHub stars, clones, visitors, downloads, and references are reported as distinct signals; none is relabeled as users.
- Awesome-list inclusion is described as curated ecosystem recognition, not endorsement, installation, or broad adoption.
- The project remains a fork in GitHub metadata; the evidence page explains independent evolution without claiming upstream stars.
- The three current high-severity npm audit findings are transitive development-tool findings. They are recorded as a follow-up risk and are not presented as runtime vulnerabilities or silently auto-fixed in Phase 0.

## Verification

Phase 0 is acceptable only when:

- the host-validation checker and focused tests pass;
- the full test suite, lint, docs contract, package dry-run, and setup verification pass;
- the ten-round mixed live campaign passes all rounds and quality gates;
- the README and benchmark page identify v2.14.0 and the 2026-08-12 run without retaining contradictory v2.12.0 “latest” claims;
- the demo assets exist, are readable, and contain only safe fixture material;
- the application evidence page distinguishes measured facts, inferences, and gaps;
- no external submission or publication occurred.
