let meta = #{
    name: "musk-live-path",
    description: "Implement musk/live-path GitHub issues: shrink the live operator surface, then PK vs main",
    when_to_use: "Use on branch musk/live-path to close #375-#388: SKILL/help/README shrink, one-line receipts, doctor short form, docs-contract unlock, PK vs c332afc",
    phases: [
        #{ title: "Unlock", detail: "docs-contract no longer freezes the 81-command card" },
        #{ title: "Implement", detail: "operator card, doctor/receipts, merge-gate docs" },
        #{ title: "Verify", detail: "adversarial review of live path vs leftover tree" },
        #{ title: "Fix", detail: "apply surviving issues" },
        #{ title: "Prove", detail: "npm test, lint, check:docs" },
        #{ title: "PK", detail: "operator-surface board vs main c332afc" },
    ],
};

let done_schema = #{
    "type": "object",
    "required": ["ok", "summary"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "summary": #{ "type": "string" },
    },
};
let verdict_schema = #{
    "type": "object",
    "required": ["pass", "issues"],
    "properties": #{
        "pass": #{ "type": "boolean" },
        "issues": #{
            "type": "array",
            "items": #{ "type": "string" },
        },
    },
};
let prove_schema = #{
    "type": "object",
    "required": ["ok", "output"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "output": #{ "type": "string" },
    },
};

let repo = "D:\\Code\\chrome-cdp-ex";
let baseline = "c332afca49296a55a16fc82008c98fc6506177f9";
let branch = "musk/live-path";

fn text_of(r, field) {
    if r != () && r.success && r.output != () {
        let obj = r.output;
        if field == "summary" {
            if obj.summary != () { obj.summary } else { "" }
        } else if field == "output" {
            if obj.output != () { obj.output } else { "" }
        } else {
            ""
        }
    } else {
        ""
    }
}

fn is_ok(r) {
    r != () && r.success && r.output != () && r.output.ok == true
}

let survivors = "";
survivors += "doctor list open nav perceive text click fill press select scroll eval inject ";
survivors += "cascade waitfor dismiss-modal elshot shot spawn-debug-browser stop";

let keep = "";
keep += "Keep: live attach; per-tab daemon; Electron CDP_PORT not 9222; Chrome 136 default-profile physics; ";
keep += "zero runtime npm deps; secrets redacted; click --js as a FLAG not jsclick product name; ";
keep += "eval --b64 as a FLAG not eval64 product name. Leftover handlers may stay in the tree. ";
keep += "Do not rm cdp.mjs modules. Do not commit. Do not rebase. Do not push. Do not open a PR. ";
keep += "Do not use an isolated worktree. Edit this checkout on branch " + branch + ".\n";

let rules = "";
rules += "Workspace: " + repo + "\n";
rules += "Branch must be " + branch + " at or after " + baseline + ".\n";
rules += "Use read_file, grep, search_replace, write, list_dir, run_terminal_command. Read before edit.\n";
rules += keep;

// --- Unlock ---------------------------------------------------------------
phase("Unlock");

let unlock_p = "";
unlock_p += rules;
unlock_p += "GitHub #376 (parent #375): docs-contract must not freeze the 81-command always-loaded card.\n";
unlock_p += "Also relax gates that would block #377 README front door and #388 merge-gate shrink.\n\n";
unlock_p += "Read and change:\n";
unlock_p += "- scripts/check-docs-contract.mjs\n";
unlock_p += "- tests/docs-contract.test.mjs\n";
unlock_p += "- any test that greps always-loaded SKILL.md for leftover command names\n\n";
unlock_p += "Required behavior after this change:\n";
unlock_p += "1. Always-loaded skills/chrome-cdp-ex/SKILL.md is required to name SURVIVORS only: " + survivors + ".\n";
unlock_p += "2. Leftover command names may live in skills/chrome-cdp-ex/references/commands.md. ";
unlock_p += "Missing leftover names in SKILL.md must NOT fail check:docs.\n";
unlock_p += "3. README.md must NOT be required to name all 81 commands. docs/reference.md may keep the catalog.\n";
unlock_p += "4. README first screen must be allowed to lead with live-session + doctor/list WITHOUT ";
unlock_p += "experiment/pk-324-scoreboard.svg as first glance. Linking docs/pk-324-board.md below the fold is enough. ";
unlock_p += "Keep SVG files in the tree. Relax checkReadmePkTableContract / checkReadmeFirstScreenOrder / ";
unlock_p += "checkReadmeFaceContract so they no longer force the 10/8/9 scoreboard as the front door. ";
unlock_p += "Still require live-session hook and doctor then list Quick Start.\n";
unlock_p += "5. checkSelfImprovementLoopContract must not make 10-round benchmark:campaign a merge-gate ";
unlock_p += "for CLAUDE.md / CONTRIBUTING.md. The historical runbook docs/self-improvement-loop.md may stay, ";
unlock_p += "but CLAUDE.md verification block for this workstream is npm test / npm run lint / npm run check:docs.\n";
unlock_p += "6. Killer Path docs/examples/killer-path.md may keep extra examples; do not require record-actions / ";
unlock_p += "replay / export-playwright / report / --since-action as always-loaded SKILL liturgy.\n";
unlock_p += "7. Update tests that expect stdout 'Docs contract OK: 81 commands checked' if you change that message. ";
unlock_p += "Catalog length may still be 81 in COMMANDS; the card is not 81.\n";
unlock_p += "8. tests/docs-contract.test.mjs SKILL.md-specific assertions that demand leftover verbs, HuggingFace ";
unlock_p += "models?search, leftover-ax, verify-click, overlay, scanshot, record, call as required reading — drop or ";
unlock_p += "point them at references/commands.md.\n";
unlock_p += "Also scan tests/pdf-text.test.mjs, tests/table-docs-honesty.test.mjs, tests/hermes-electron-port.test.mjs ";
unlock_p += "if they freeze SKILL.md lab law. Update those SKILL assertions; keep PDF/table implementation tests.\n\n";
unlock_p += "Run npm run check:docs after edits if node_modules exists; if it fails only because SKILL/README still ";
unlock_p += "have old chrome, that is OK for this phase — later phases shrink those files. Failures that still require ";
unlock_p += "leftover names IN SKILL.md or PK SVG as README first screen are NOT OK — keep fixing the checker.\n";
unlock_p += "Return ok=true if the checker no longer forbids the planned SKILL/README shrink.\n";

let unlock = agent(unlock_p, #{
    label: "unlock:docs-contract",
    capability_mode: "all",
    output_schema: done_schema,
});
log("unlock ok=" + is_ok(unlock).to_string() + " " + text_of(unlock, "summary"));

// --- Implement (parallel, disjoint files after unlock) --------------------
phase("Implement");

let docs_p = "";
docs_p += rules;
docs_p += "Implement GitHub #385 #379 #377 #387 on this checkout. Read each file before editing.\n\n";
docs_p += "SURVIVOR verbs on the live card: " + survivors + ".\n";
docs_p += "click --js is a flag. eval --b64 is a flag. Do not advertise jsclick/eval64/call as product names.\n\n";
docs_p += "#385 skills/chrome-cdp-ex/SKILL.md: rewrite always-loaded body to a one-screen 5-step golden path: ";
docs_p += "doctor or list -> list/open/nav -> perceive -> click/fill/press/select/scroll -> one-line evidence. ";
docs_p += "Keep YAML frontmatter trigger (live Chrome/Electron, do not use Playwright by default). ";
docs_p += "Keep short Chrome 136 note: default profile cannot enable CDP; persistent non-default daily dir or isolated spawn; ask first. ";
docs_p += "Keep Electron CDP_PORT example 9333 not 9222. Keep pointers to references/commands.md, recipes.md, troubleshooting.md. ";
docs_p += "DROP from SKILL.md: HuggingFace models?search, leftover-AX tautology, cap-swap sampling, hover leftover recapture, ";
docs_p += "24-command remember list, PDF-plugin receipt essay, verify-click/overlay/frame/report/record as required next steps, ";
docs_p += "MCP confirm:true, six hosts, batch --compact liturgy. Grep SKILL.md after edit: no models?search, no leftover-ax, no cap-swap.\n\n";
docs_p += "#379 Default cdp help (no args) must list survivors, not 81 rows. Find renderCliHelp / COMMAND_SURFACE help in ";
docs_p += "skills/chrome-cdp-ex/scripts/cdp.mjs and scripts/lib/command-surface.mjs. Add a short default help for the card; ";
docs_p += "cdp help <leftover> may still print leftover help. README must not market an 81-command catalog as the product.\n\n";
docs_p += "#377 README.md first screen: attach to the tab you already have; Quick Start ./bin/chrome-cdp doctor then list; ";
docs_p += "Chrome 136 honesty. Move or drop the 10/8/9 PK SVG from above the fold. docs/pk-324-board.md and experiment/pk-324-*.svg stay in the tree. ";
docs_p += "May keep a below-fold link to the engineer grid. Keep MIT license. Do not restore a ten-row lab table in README.\n\n";
docs_p += "#387 SKILL.md and README Quick start must not require MCP, setup.mjs --for, or six-host live-validated loops. ";
docs_p += "INTEGRATIONS.md may remain; README may link it below the fold. Do not delete mcp-server.mjs or hosts/*.md.\n\n";
docs_p += "Do not expand SCOPE into Runtime v3 rewrites. Return ok=true when SKILL is one-screen golden path and README leads with live-session.\n";

let code_p = "";
code_p += rules;
code_p += "Implement GitHub #383 and #386 in skills/chrome-cdp-ex/scripts/cdp.mjs and helpers under scripts/lib/. ";
code_p += "Read existing doctor and action-receipt code before editing. Prefer smallest change.\n\n";
code_p += "#383 doctor / ready default text: Node version, CDP reachability/port, next command (list or spawn-with-ask). ";
code_p += "No wizard novel, no leftover perceive <id> -C -d 8 sample as the next probe. list is the tab source of truth. ";
code_p += "KEEP: live 9222 / CDP_PORT / existing tab daemon attach (issues #358-#374). ";
code_p += "KEEP: Electron live daemon must not recommend occupying 9222. ";
code_p += "KEEP: spawn-debug-browser --help must not launch. Chrome 136 empty 9222 is not quit-Dock-and-it-will-listen. ";
code_p += "Update tests that snapshot the doctor wizard essay to the short form.\n\n";
code_p += "#386 Default stdout for mutating survivors click fill press select scroll nav: one line outcome + next command. ";
code_p += "Happy-path nav stays URL+title. Happy-path scroll to bottom stays skinny metrics. ";
code_p += "Happy-path click/fill/press must not reprint Outcome/Receipt/Verdict as three sentences. ";
code_p += "Failed dispatch still prints classified Kind + one Next command. ";
code_p += "Do not delete scripts/lib/action-recovery.mjs. Off-default --qa/--summary/JSON may remain. ";
code_p += "Rewrite or drop unit tests that freeze fat leftover-AX receipts as the SUCCESS contract for the default path. ";
code_p += "Do not silently restore HuggingFace SKILL law in code comments.\n\n";
code_p += "Return ok=true when doctor is short and default mutating stdout is one line.\n";

let gates_p = "";
gates_p += rules;
gates_p += "Implement GitHub #388. Files: CLAUDE.md, CONTRIBUTING.md, docs/self-improvement-loop.md if needed, AGENTS.md if it still polices npm publish as an agent process.\n\n";
gates_p += "Ordinary and musk/live-path merges must NOT require npm run benchmark:campaign 10+ rounds, adversarial seeds, ";
gates_p += "or validation phases 4-7. Default local gate: npm test, npm run lint, npm run check:docs. ";
gates_p += "Focused npm run smoke:live when attach/perceive/act code changes AND a browser exists.\n";
gates_p += "Do not delete scripts/benchmark-*.mjs or validation/. Historical runbook may stay but must not be the contributor/agent merge instruction.\n";
gates_p += "Drop @/Users/simon/.codex/ includes from AGENTS.md if still present (leftover chrome).\n";
gates_p += "Return ok=true when CLAUDE.md/CONTRIBUTING.md no longer list 10-round mixed campaign as required.\n";

let implemented = parallel([
    #{ prompt: docs_p, label: "impl:operator-docs", capability_mode: "all", output_schema: done_schema },
    #{ prompt: code_p, label: "impl:doctor-receipts", capability_mode: "all", output_schema: done_schema },
    #{ prompt: gates_p, label: "impl:merge-gates", capability_mode: "all", output_schema: done_schema },
]);
let ii = 0;
for slot in implemented {
    log("implement slot " + ii.to_string() + " ok=" + is_ok(slot).to_string() + " " + text_of(slot, "summary"));
    ii += 1;
}

// --- Verify ---------------------------------------------------------------
phase("Verify");

let v_skill = "";
v_skill += "Adversarially review ALWAYS-LOADED skills/chrome-cdp-ex/SKILL.md in " + repo + ".\n";
v_skill += "Use read_file and grep. Do not trust memory. pass=true only if ALL hold; else list file+problem.\n";
v_skill += "Must: one-screen 5-step golden path; survivors " + survivors + "; Chrome 136 short note; Electron CDP_PORT; references/ pointers.\n";
v_skill += "Must NOT contain: models?search, leftover-ax, cap-swap, a 24-name remember list, stdio MCP as required, six-host matrix, ";
v_skill += "verify-click/overlay/report/record as the default next step after act.\n";
v_skill += "Leftover modules existing in the tree is fine. SKILL still naming them is a fail.\n";

let v_readme = "";
v_readme += "Adversarially review README.md default help path in " + repo + ".\n";
v_readme += "Use read_file. pass=true only if ALL hold.\n";
v_readme += "Must: live-session hook; Quick Start ./bin/chrome-cdp doctor then list; Chrome 136 limitation somewhere; MIT/LICENSE.\n";
v_readme += "Must NOT: PK scoreboard SVG as the first claim/first glance; 81-command catalog as the product; ten-row lab table.\n";
v_readme += "Linking docs/pk-324-board.md below the fold is OK. INTEGRATIONS.md below the fold is OK.\n";
v_readme += "Also grep default CLI help if you can run node skills/chrome-cdp-ex/scripts/cdp.mjs help — default help must not dump 81 rows.\n";

let v_code = "";
v_code += "Adversarially review doctor and default action stdout in " + repo + ".\n";
v_code += "Read doctor implementation and action evidence wrappers. pass=true only with evidence.\n";
v_code += "Doctor default text must be short (Node / port / next). Must not recommend occupying 9222 when an Electron daemon is live.\n";
v_code += "Default click/fill/press/scroll/nav happy path must not print Recovery/Hint/Outcome as three sentences.\n";
v_code += "Failed dispatch still has Kind + Next. Leftover action-recovery.mjs in the tree is not a fail.\n";

let verified = parallel([
    #{ prompt: v_skill, label: "verify:skill", capability_mode: "read-only", output_schema: verdict_schema },
    #{ prompt: v_readme, label: "verify:readme-help", capability_mode: "read-only", output_schema: verdict_schema },
    #{ prompt: v_code, label: "verify:doctor-receipts", capability_mode: "read-only", output_schema: verdict_schema },
]);

let issues = [];
let vi = 0;
for v in verified {
    if v == () || v.success != true {
        issues.push("verifier slot " + vi.to_string() + " failed or returned nothing");
    } else {
        if v.output.pass != true {
            if v.output.issues != () {
                for iss in v.output.issues {
                    issues.push(iss);
                }
            } else {
                issues.push("verifier slot " + vi.to_string() + " pass=false with empty issues");
            }
        }
    }
    vi += 1;
}
log("verify issues=" + issues.len().to_string());

// --- Fix ------------------------------------------------------------------
if issues.len() > 0 {
    phase("Fix");
    let fix_p = "";
    fix_p += rules;
    fix_p += "Fix surviving review issues on musk/live-path. Do not expand scope. Do not commit.\n";
    fix_p += "Issues JSON:\n" + json_encode(issues) + "\n";
    let fix = agent(fix_p, #{ label: "fix", capability_mode: "all", output_schema: done_schema });
    log("fix ok=" + is_ok(fix).to_string() + " " + text_of(fix, "summary"));
}

// --- Prove ----------------------------------------------------------------
phase("Prove");
let prove_p = "";
prove_p += rules;
prove_p += "From " + repo + " run:\n";
prove_p += "1. npm test\n";
prove_p += "2. npm run lint\n";
prove_p += "3. npm run check:docs\n";
prove_p += "Capture real stdout/stderr. If failures are caused by this branch, fix them and re-run the failing command once.\n";
prove_p += "Do not require benchmark:campaign. Do not commit.\n";
prove_p += "Return ok=true only if npm test AND npm run check:docs exit 0. Put command output in output (trim if huge).\n";

let prove = agent(prove_p, #{
    label: "prove:tests",
    capability_mode: "all",
    output_schema: prove_schema,
});
let proved = prove != () && prove.success && prove.output != () && prove.output.ok == true;
log("prove ok=" + proved.to_string());

if proved != true {
    phase("Fix");
    let fix2_p = "";
    fix2_p += rules;
    fix2_p += "Tests or check:docs failed. Fix the musk/live-path checkout so npm test and npm run check:docs pass.\n";
    fix2_p += "Last prove output:\n" + json_encode(text_of(prove, "output")) + "\n";
    fix2_p += "Then re-run npm test and npm run check:docs. Return ok=true only if both exit 0.\n";
    let fix2 = agent(fix2_p, #{ label: "fix:prove", capability_mode: "all", output_schema: prove_schema });
    prove = fix2;
    proved = prove != () && prove.success && prove.output != () && prove.output.ok == true;
    log("prove-after-fix ok=" + proved.to_string());
}

// --- PK -------------------------------------------------------------------
phase("PK");
let pk_p = "";
pk_p += rules;
pk_p += "GitHub #384: write docs/musk-pk-vs-main.md comparing THIS checkout to git show " + baseline + " (un-deleted main).\n";
pk_p += "Do not rebase. Baseline SHA is " + baseline + ".\n\n";
pk_p += "Board 1 operator surface — measure both sides with tools, not guesses:\n";
pk_p += "- skills/chrome-cdp-ex/SKILL.md byte size (git show " + baseline + ":skills/chrome-cdp-ex/SKILL.md vs working tree)\n";
pk_p += "- commands named on the card: high-signal list in SKILL + default `node skills/chrome-cdp-ex/scripts/cdp.mjs help` row count\n";
pk_p += "- golden-path steps described on the card\n";
pk_p += "- if you can run doctor/help without a browser, include default stdout char counts for help and doctor\n\n";
pk_p += "Board 2 #324 jobs vs itself: same 10 jobs, 1042x632, n=3. Columns: c332afc | musk/live-path.\n";
pk_p += "If no live browser, write Board 2 as NOT MEASURED this run with the reason; do not invent PASS/FAIL.\n";
pk_p += "Must-not-regress checklist (code/docs evidence, not vibes): live attach story, Electron CDP_PORT, Chrome 136 honesty, zero runtime deps, secret redaction.\n";
pk_p += "Add-back log: empty is allowed; note that empty may mean under-deleted. Do not silently restore SKILL law.\n";
pk_p += "Also comment a short status on GitHub issue #375 listing which children are implemented vs blocked, using gh if authenticated, else skip comments.\n";
pk_p += "Return ok=true if docs/musk-pk-vs-main.md exists with Board 1 numbers from actual git/file measurement.\n";

let pk = agent(pk_p, #{
    label: "pk:vs-main",
    capability_mode: "all",
    output_schema: done_schema,
});
log("pk ok=" + is_ok(pk).to_string() + " " + text_of(pk, "summary"));

let report = "";
report += "# musk-live-path run\n\n";
report += "- unlock: " + text_of(unlock, "summary") + "\n";
report += "- prove_ok: " + proved.to_string() + "\n";
report += "- pk: " + text_of(pk, "summary") + "\n";
report += "- verify_issues: " + issues.len().to_string() + "\n";
report += "- prove_output:\n" + text_of(prove, "output") + "\n";
let path = write_scratch_file("musk-live-path.md", report);

complete(#{
    ok: proved && is_ok(pk),
    summary: "musk-live-path prove_ok=" + proved.to_string() + " pk=" + is_ok(pk).to_string(),
    issues_found: issues.len(),
    report: path,
    prove_output: text_of(prove, "output"),
});
