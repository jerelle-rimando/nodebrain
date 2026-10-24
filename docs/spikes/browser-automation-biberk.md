# Spike: browser automation on biBerk's GL quote flow — PAUSED

Status as of 2026-10-24: **wiring done, run not started.** Branch `spike/playwright-biberk`.
Paused because no model can drive the agent yet (see "To resume").

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

## Not done

- The quote run itself: nothing has been sent to biberk.com yet.
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
