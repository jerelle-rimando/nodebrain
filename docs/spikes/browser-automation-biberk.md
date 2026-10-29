# Spike: browser automation — biBerk (abandoned), then OrangeHRM + Take Control

The second attempt (2026-10-29) is at the end of this file. Everything above it is the
biBerk record from 2026-10-27.

Status as of 2026-10-27: **three runs done, all blocked by biBerk** (see "Runs"). The run-3
evidence points at automated-browser detection. Branch `spike/playwright-biberk`.
Paused after run 3 for a cost review. Spend so far: $1.63.

Goal (unchanged): learn where live browser automation breaks on a real portal,
not ship a feature. One day timebox; about an hour used so far, all on wiring.

## Done

**@playwright/mcp wired as a built-in server** (`SERVER_CONFIGS` in
`backend/src/mcp/toolRegistry.ts`, name `playwright`).
- Pinned `@playwright/mcp@0.0.83` (published 2026-09-28).
- `--browser msedge` uses the system Edge install, so nothing is bundled and no
  Chromium is downloaded. Checked: Edge launches and navigates.
- `--output-dir %TEMP%\nodebrain-playwright`. Without it the server writes snapshot
  files into the cwd, which in the packaged app is the install folder.
- `requiresCredential: false`, so it runs on bundled npm like the other built-ins.
- Checked: NodeBrain's own registry (`initializeToolRegistry`, throwaway data dir)
  reports `playwright CONNECTED 25 tools`, `getServerStatus` → `running`.

**Approval classification** (`DESTRUCTIVE_TOOLS` in `backend/src/agents/agentEngine.ts`).

| Approval | Tools | Why |
|---|---|---|
| Not gated | `browser_navigate`, `browser_navigate_back`, `browser_snapshot`, `browser_take_screenshot`, `browser_find`, `browser_wait_for`, `browser_console_messages`, `browser_network_requests`, `browser_network_request`, `browser_tabs`, `browser_hover`, `browser_resize`, `browser_close`, `browser_emulate_media` | These read the page or move around it, and can't submit anything. |
| Not gated | `browser_fill_form`, `browser_select_option` | They set field values without submitting. Batched form filling stays free. |
| **Gated** | `browser_click` | Any click can be a submit. |
| **Gated** | `browser_press_key` | Pressing Enter submits. |
| **Gated** | `browser_type` | Has a `submit: true` arg that presses Enter. |
| **Gated** | `browser_handle_dialog` | Accepting a confirm() is often the submit itself. |
| **Gated** | `browser_evaluate`, `browser_run_code_unsafe` | Arbitrary JS can do anything. |
| **Gated** | `browser_file_upload`, `browser_drag`, `browser_drop` | Upload sends local files to a remote site; drag/drop can trigger uploads. Fail closed. |

**The design problem this exposes (decision still open):** NodeBrain approves by
*tool name*, but "does this submit?" depends on the *target*. `browser_click` on a
dropdown and `browser_click` on "Get my quote" are the same tool, so they get the
same answer. With approval mode on, the current classification means:
- Interactive runs prompt on every click, which is dozens of prompts for one quote.
- Unattended runs abort on the first click (`UnattendedApprovalError`). So an
  unattended quote run is impossible with approval mode on.

Possible fixes, none built:
1. Gate by target. Resolve `target` (the snapshot ref) against the last snapshot and
   gate only `button`/`link` elements whose name matches submit/next/continue/quote/buy/bind.
   Use the ref, never the model-written `element` text, because the model can write
   anything there.
2. Gate per step in a recorded workflow, not per tool. A human marks the submit
   steps once, at record time.
3. Gate only the final irreversible step (bind/purchase/pay), not every page's "Next".
   For a quote (not a bind), arguably nothing needs approval.

Also: a tool this server adds in a future version is **not** gated by default. It is
on a built-in server, and only unknown *servers* fail closed.
`requiresApproval(fullToolName, serverName)` has no args, so (1) needs a signature
change in its three call sites.

## Found while wiring (affects the run)

- **Action results don't include the page.** `browser_navigate`, `browser_click` and the
  other actions return a *file path* to the snapshot, not the snapshot. NodeBrain's agent
  can't read that file. Only `browser_snapshot` returns the accessibility tree inline. So
  every step costs an extra tool call plus a full-page snapshot in context. Expect that
  to dominate tokens and model latency. Check for a flag that inlines snapshots before
  measuring cost.
- **Every agent gets 25 more tools in its prompt**, because the server has no
  credential gate. Fine on a spike branch; it must not merge to main like this.
- Not updated: the frontend integration cards (`IntegrationsPage.tsx`, `statusText.ts`),
  and `BUILTIN_INTEGRATIONS` in `telemetry-worker/src/index.ts` (it would be reported as
  'custom'). Not needed for the spike.
- Browser profile: the default is persistent (`%LOCALAPPDATA%\ms-playwright\mcp-msedge-profile`),
  so cookies survive between runs. For the timeout test, decide whether to add `--isolated`.

## Runs (2026-10-27)

Model `claude-sonnet-5-5` (ID and $2 / $10 per MTok checked against Anthropic's models
and pricing pages). Max 20 steps, approval mode off, human present. The agent can use only
the 25 playwright tools. Harness: `backend/src/_harness.ts`, with the cookie script in
`docs/spikes/biberk-accept-cookies.js`. The API key is read from a file outside the repo.
Run logs are in a session scratch folder, not the repo.

To make this model usable, `claude-sonnet-5-5` was added to `AVAILABLE_MODELS.anthropic`
and `MODEL_PRICING`. Without the first, `createAgent` silently swaps it for `claude-sonnet-4-6`.

**Network: all traffic in runs 2 and 3 went Philippines → US VPN (Hotspot Shield) → biBerk.**
Run 2 used the New York exit. Run 3 used a different exit, on which the user confirmed by
hand that the industry search works. Page-load times are inflated by VPN latency. Don't read
them as browser-automation overhead.

| Run | Network | Steps | Input tok | Output tok | Cost | Result |
|---|---|---|---|---|---|---|
| 1 | Philippines, direct | 4 | 28,903 | 638 | $0.064 | Homepage 403 from Azure Application Gateway. biBerk blocks Philippine IPs; the user's normal browser was blocked too. |
| 2 | US VPN | 13 | 259,182 | 2,014 | $0.539 | Homepage and quote page loaded. biBerk's API returned 403 from the quote page's first load, then the page showed "Access is temporarily restricted / unusual activity" and went to `/get-a-quote/error/0`. |
| 3 | US VPN, new exit | 20 of 20 | 501,012 | 2,349 | $1.026 | Same block as run 2, by both routes to the quote page (direct URL, and homepage → GL tile → Get a Quote). Task marked `failed` (see below). |

Run 3 detail:
- **Cookie banner handled at launch.** An init script (`docs/spikes/biberk-accept-cookies.js`,
  passed as `PLAYWRIGHT_MCP_INIT_SCRIPT` by the harness; it runs only on biberk.com) clicked biBerk's "Accept all" 0.4–3s after each
  page load. The agent made zero cookie-related tool calls (run 2: 2). The browser profile
  started empty (`PLAYWRIGHT_MCP_ISOLATED`), so no cookies carried over from run 2.
- **The block points at the automated browser, not the network.** On a VPN exit where the
  user's own browser gets industry suggestions, the automated Edge got 403 from
  `bspuser/current`, `LoadQuote` and `Keywords/Get` on every quote-page load. That included
  a load reached by ordinary clicks. The agent's report says the second route "loaded
  normally". The console log contradicts it: the 403s came at load both times.
  Caveat: run 3's first direct navigation could have flagged the session before the second
  route, and nobody has re-checked by hand since run 3.
- **New field facts:** the industry box is a read-only Angular Material input
  (`data-qa="autocompleteIndustryControl"`, `required`). `browser_type` on it times out
  after 5s; you have to click it to open the search dialog. A five-step progress bar
  suggests 5 pages of questions.
- **NodeBrain bug: a recovered tool error fails the whole task.** Three gated calls errored:
  two stale snapshot refs and one read-only fill. The agent recovered each time and finished
  normally on step 20. But the engine sets `destructiveFailRef` when any tool in
  `DESTRUCTIVE_TOOLS` fails, so the task ended `failed` ("a destructive tool call failed").
  The same set controls both approval and "a failure is fatal", so putting browser
  click/type in it makes every stale ref fatal. These need to be two separate lists.
- **Approval gate:** 9 of 21 tool calls would have stopped. None of them was a submit.
- **Stale refs:** the agent clicked `e96` while the element had become `f7e96` (refs gain a
  frame prefix after re-render). Two calls were lost to this.
- **Cost:** input reached about 36k tokens per step by step 20, about $0.07 per step. The
  20-step cap was hit without getting past the first field.
- **Timing:** 44.2s model, 33.0s tools (navigations took 8.3s, 5.5s and 1.6s over the VPN;
  the read-only timeout took 5.0s), 88s wall.

Run 2 detail:
- The quote page's API calls (`spa/api/bspuser/current`, `spa/api/Keywords/Get`,
  `quote/api/GetAQuote/LoadQuote`) were already **403 when the page first loaded**,
  before any typing. Typing "Roofing" in the industry dialog only made the block visible.
- **Cause not yet separated:** VPN IP reputation versus automated-browser detection. Next
  check: the user runs the same steps by hand in their normal browser over the same VPN.
  Don't try to evade the detection.
- Field inventory so far: one field. "What's your industry?" is an autocomplete text box
  with the placeholder "e.g. Handyman or Accountant". Clicking it opens a modal search
  dialog that asks you to pick the closest match, so the test data needs biBerk's own
  category name, not a NAICS code. A cookie banner appears on both the home and quote pages.
- **Approval gate:** 4 of the 15 tool calls would have stopped. Two were "Accept all
  cookies" clicks, and two were `browser_type` with no submit. None of the 4 submitted
  anything, which backs up the gate-by-target problem above.
- **Cost:** the first homepage snapshot (27 KB) raised input from about 7k to about 17.5k
  tokens per step, and it stays in context for the rest of the run. Late steps cost about
  $0.05 each and keep rising. The about-7k floor is the 25 tool schemas plus the system prompt.
- **Timing:** 40.2s model, 17.8s tools (the two navigations took 6.1s and 4.2s over the
  VPN), 69s wall. About 20s of the wall time was harness startup.
- Agent behaviour: it noticed the block, reported it accurately and didn't try to bypass
  it. It took 2 redundant snapshots of the same dialog.

## Not done

- A quote run that gets past the first field (blocked, see Runs).
- The session-timeout test.
- All the actual deliverables: the field inventory, the break-point list, timing
  (model vs. page load), the record/replay analysis, model and cost per run.

## To resume

1. **A model credential.** Neither the dev DB (`backend/data/nodebrain.db`) nor the
   installed app's DB (`%APPDATA%\nodebrain\data\nodebrain.db`) has one, and Ollama
   isn't installed (it is on PATH, but the folder is gone). Pick one:
   - Cloud (recommended for the run): an Anthropic or OpenAI key, added through the
     NodeBrain UI in dev, or handed to a harness by env var.
   - Local: install Ollama and `ollama pull qwen3:4b`. Earlier work found it too slow
     to drive steps (~9.4 tok/s), and a full-page snapshot per step makes that worse.
     Worth one attempt only to say plainly whether it works.
2. **Harness.** Write a throwaway `backend/src/_harness.ts` run with `npx tsx` and
   `NODEBRAIN_DATA_DIR=<scratch dir>`, `VAULT_SECRET=<anything>`. Import
   `./agents/agentEngine` *before* `./mcp/toolRegistry` (circular import). Then
   `initDb()`, `initVaultKey()`, `initializeToolRegistry()`. Create an agent with the
   key and run it through the normal task path, so tokens and cost land in the usage
   table via `recordUsage`. Run it interactively (human present) with approval mode
   **off**, so the run measures the browser and not the approval gate. Separately,
   record which steps the gate *would* have stopped.
3. **Instrument.** Log a timestamp around every LLM call and every MCP `callTool`,
   to separate model latency from page and tool time.
4. **Run** with the test data below. Log every field in order (label, input type,
   required?, covered by test data?) and every failure, tagged selector drift /
   unexpected modal / dynamic content / iframe / validation / timeout.
5. **Timeout test.** Partway through, stop sending actions and leave the session
   idle. Probe at about 15, 30 and 60 min; biBerk's real limit is unknown. Then let
   the agent continue. Record whether it notices (URL change, "session expired" text),
   errors usefully, or keeps clicking a dead page.

### Test data

ABC Roofing LLC · 123 Main St, Dallas, TX 75201 · FEIN 12-3456789 · LLC, est. 2019 ·
NAICS 238160 (roofing contractors) · 3 trucks, 3 drivers · no prior coverage, no claims.

---

# Second attempt (2026-10-29): OrangeHRM and Take Control

biBerk is abandoned: it is a direct-to-consumer site and defends itself like one. The real
target is authenticated carrier portals; one practitioner says those don't challenge you
after the first OTP. New targets: the OrangeHRM demo (Admin / admin123) for a full workflow,
and practice.expandtesting.com/otp-login for Take Control. VPN off: every run below went
direct from a Philippine residential ISP (PLDT). No evasion of any kind.

Spend this attempt: $1.19 (4 model runs). Total spike spend: $2.82.

## Engine changes (agentEngine.ts, toolRegistry.ts, routes, frontend)

**`DESTRUCTIVE_TOOLS` is split into two independent functions.**
- `approvalLevel(tool, args, lastSnapshot)` returns `'none' | 'ask' | 'always'`.
  - `none`: never stops. Browser navigate/read/screenshot/wait, NodeBrain's own servers.
  - `ask`: stops when approval mode is on. Typing into a field (`browser_type`, `fill_form`,
    `select_option`), ordinary clicks, keys other than Enter, every old `DESTRUCTIVE_TOOLS`
    entry, unknown custom servers, and any playwright tool a future version adds (this used
    to be open by default).
  - `always`: stops even with approval mode off, and aborts an unattended run.
    - A click on a button/link/menuitem whose label matches
      submit|save|confirm|pay|purchase|buy|bind|order|checkout|delete|remove|send.
      The label is read from the last snapshot by its ref, never from the model's `element` text.
    - Fail-closed cases: a button with no readable label (OrangeHRM's trash/edit icons are
      named with icon-font glyphs), a ref the last snapshot doesn't contain, a CSS-selector target.
    - Also: Enter, `type` with `submit: true`, accepting a dialog, `evaluate`,
      `run_code_unsafe`, `file_upload`.
- `failureIsFatal(tool, level, error)`.
  - Fatal: the external-write tools (Slack/GitHub/Telegram/filesystem/Notion writes), and an
    `always`-level browser action whose error doesn't show it never reached the page.
  - Not fatal: stale ref, `Timeout ...ms exceeded`, not visible/enabled/editable, all other
    browser errors, and pdf/file reader failures. The readers *were* fatal before, as a side
    effect of sharing the approval set: a behaviour change outside the browser.
- Unchanged: "fatal" only marks the task failed at the end. The loop keeps running, so an
  agent can still retry a failed submit.
- Check: `npx tsx src/_classify_check.ts <pagerep dir>` runs 27 cases against real
  OrangeHRM snapshots. All pass.

**Take Control.**
- An `ask_person_to_take_over` tool (server `browser-handoff`, arg `reason`: plain words for
  the person) is added to any agent that has playwright tools.
- The engine emits `browser:take_control_needed` and waits on a Promise. The Promise resolves
  on `POST /api/tasks/:taskId/take-control/:requestId {done}`, or when the task is cancelled
  (approval's wait can't be cancelled; see below).
- On resume the agent is told to take a new snapshot. Unattended runs stop with a plain message.
- Frontend `TakeControlModal`: "Your turn in the browser", the agent's sentence, and
  "Done, continue" / "Stop the task". No tool names, no JSON.
- Emits no telemetry. The scrubber allowlist is untouched.

**Known gap left alone (approval semantics):** `requestApproval`'s Promise isn't tied to the
task's abort signal. Stopping a task while an approval is open leaves the loop waiting forever.

## Runs (claude-sonnet-5-5, 8 browser tools + take control, approval mode off, human present)

The harness approves `always` calls itself and logs each one.

| Run | Steps | Input tok | Cost | Status | What actually happened |
|---|---|---|---|---|---|
| OrangeHRM 1 | 29 | 417,857 | $0.874 | completed | Logged in, opened Add Employee, filled names. Save gated `always` (correct). Site said "Employee Id already exists": the shared demo suggests IDs that are already taken. The task said leave other fields alone, so the agent stopped and asked. Nothing created. |
| OrangeHRM 2 | 13 | 51,521 | $0.117 | completed | Every navigation hit NodeBrain's 60s MCP request timeout (-32001). Page title loaded, body blank. Agent reported honestly and stopped. |
| OrangeHRM 3 | 12 | 47,224 | $0.108 | completed | Same as run 2. |
| OTP 1 | 6 | ~43k | $0.088 | completed | Typed email, clicked Send (gated `always`), saw the code page and handed over. Didn't use the code printed on the page. Nobody answered within the 20-minute wait, which the harness counts as "stop". The agent stopped cleanly. **Pause and stop paths verified; hand-back-and-resume not yet.** |

**All four ended `completed` even though none did the job.** This is separate from the
fatal-failure split: an agent that stops early and explains why is recorded as a success.

**OrangeHRM blank page, unresolved.**
- Reproducible through NodeBrain's launch path (`connectToServer` + `SERVER_CONFIGS.playwright`):
  7 of 8 navigations timed out at 60s.
- Launching the same package directly with the MCP SDK: 9 of 9 loaded, in 0.5–11s.
- example.com and expandtesting load fine through NodeBrain.
- Ruled out: proxy env, stderr pipe, client name, open-websearch running alongside,
  importing the backend.
- One lead: adding the `--isolated` *flag* got through once (23.8s), while
  `PLAYWRIGHT_MCP_ISOLATED` in the env did not. Too few samples to call it.
- Separately: NodeBrain's MCP request timeout (SDK default 60s) equals Playwright's 60s
  navigation timeout, so a slow page surfaces as an opaque protocol error.

Also from run 1: the agent's partial snapshots (`target`/`depth`) weren't tracked, so the
second Save was judged against the old page and landed on `always` only via fail-closed.
Fixed: the last snapshot of any kind is used now.

## Page representation (question for offline / local models; not fixed)

Measured with `src/_pagerep.ts` and `src/_collapse.ts` using count_tokens (Claude's
tokenizer; Qwen's will differ somewhat), on real OrangeHRM pages:

| Page | Raw HTML | Full a11y snapshot | Interactive-only (refs kept) | Rows collapsed (refs kept) | innerText (no refs) |
|---|---|---|---|---|---|
| Login | 8,524 | 884 | 132 | 54 | 141 |
| Dashboard | 201,957 | 4,850 | 502 | 305 | 1,001 |
| Employee list (grid, 50 rows) | 242,717 | 17,638 | 10,924 | 2,985 | 1,380 |
| Add employee | 174,633 | 2,476 | 577 | 347 | 317 |

Tool schemas: all 25 playwright tools are 6,161 tokens; the 8 used here are 2,077. Measured
per-step floor with 9 tools + system prompt + task: ~2,700 tokens before any page.

Findings:
- The smallest view the agent can still act on is the accessibility tree reduced to
  actionable elements with refs, with tables collapsed to one line per row. Raw HTML is out
  of the question; innerText has no refs, so the agent can't click anything.
- Forms fit a 4k context (54–577 tokens). Grids don't, unless paged (~3k for 50 rows).
- History is the real problem. Even the frontier run reached 36k input by step 27, because
  every earlier snapshot stays in context. A 4k model would need ≤3–4 tool schemas (~1k),
  only the current page, a one-line action log instead of transcripts, and paged grids.
  That is a different agent loop from today's, not a setting.
- Verdict: a 4B CPU model can't drive *exploratory* browser automation in NodeBrain's
  current loop. It might work for *replaying* a recorded workflow, where the model only
  matches one field per step against a compact page view. Untested: no local model was run,
  and 4B accuracy on these views is unknown.
