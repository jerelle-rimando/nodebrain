// Script injected into every frame of the recording window (addInitScript).
//
// 1. Fingerprint capture. At each user event it reads the target element's
//    DOM facts (label, placeholder, name attribute, test id, input type, URL
//    path, frame) and sends them to NodeBrain through the exposed binding.
//    It runs at event time because by the time Playwright's recorder reports
//    a click, a submit may already have navigated the page away.
// 2. The pill (top frame only): red dot, "Recording", live step count, Done,
//    and an X that asks once before throwing the recording away.
//
// It touches the page as little as it can: one custom element in a closed
// shadow root, marked aria-hidden so it stays out of accessibility snapshots.
// The binding and two window properties are visible to the site's own
// scripts; a hostile page could end the recording or send bad fingerprints,
// so NodeBrain never trusts these messages for anything security-relevant
// (password detection also checks the field itself; see recordingSession.ts).

export const RECORDER_BINDING = '__nodebrainRecorder';
export const PILL_HOST_ID = 'nodebrain-recorder';
export const SET_COUNT_FN = '__nodebrainRecorderSetCount';

export const PAGE_SCRIPT = `(() => {
  const BINDING = ${JSON.stringify(RECORDER_BINDING)};
  const HOST_ID = ${JSON.stringify(PILL_HOST_ID)};
  const SET_COUNT = ${JSON.stringify(SET_COUNT_FN)};
  if (window.__nodebrainRecorderInstalled) return;
  Object.defineProperty(window, '__nodebrainRecorderInstalled', { value: true });
  // Keep our own reference: page scripts run after this and could replace it.
  const send = window[BINDING];
  if (typeof send !== 'function') return;

  // ── Fingerprint capture ──────────────────────────────────────────────
  const ids = new WeakMap();
  // Element ids restart on every page load; docId tells documents apart.
  const docId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let nextId = 1;
  const idOf = (el) => { if (!ids.has(el)) ids.set(el, nextId++); return ids.get(el); };
  const clean = (s, max = 120) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, max) || undefined;
  const textOf = (el) => clean(el && (el.innerText || el.textContent));

  function labelOf(el) {
    try {
      if (el.labels && el.labels.length) return textOf(el.labels[0]);
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        // An element inside the control is its content (Select2 points at
        // the shown value), not its label.
        const t = by.split(/\\s+/).map((id) => document.getElementById(id)).filter((n) => n && !el.contains(n)).map(textOf).join(' ');
        if (t) return clean(t);
      }
      const wrap = el.closest('label');
      if (wrap) return textOf(wrap);
    } catch {}
    return undefined;
  }

  // Same retargeting Playwright's selector generator applies to clicks, so
  // both describe the same element.
  function interactive(el) {
    if (el.matches('input,textarea,select') || el.isContentEditable) return el;
    return el.closest('button,select,input,[role=button],[role=checkbox],[role=radio],a,[role=link]') || el;
  }

  function fingerprint(el) {
    const tag = el.tagName.toLowerCase();
    const attr = (n) => clean(el.getAttribute(n), 200);
    const isButtonLike = tag === 'button' || (tag === 'input' && /^(submit|button|reset)$/i.test(el.type));
    const fp = {
      tag,
      inputType: tag === 'input' ? (el.type || 'text').toLowerCase() : undefined,
      autocomplete: attr('autocomplete'),
      nameAttr: attr('name'),
      testId: attr('data-testid') || attr('data-test-id') || attr('data-test') || attr('data-qa') || attr('data-cy'),
      label: labelOf(el),
      placeholder: attr('placeholder'),
      urlPath: location.pathname,
      title: clean(document.title, 200),
      origin: location.origin,
      framePath: window === top ? undefined : [location.origin + location.pathname],
      // Strings the accessible name might have been computed from; used only
      // to pair this record with the recorder's action.
      names: [attr('aria-label'), labelOf(el), attr('placeholder'), attr('title'), attr('alt'),
              isButtonLike ? clean(el.value) : undefined, textOf(el)].filter(Boolean),
    };
    if (tag === 'select') fp.optionLabels = Array.from(el.selectedOptions || []).map((o) => clean(o.label || o.text));
    return fp;
  }

  function targetOf(e) {
    const path = e.composedPath ? e.composedPath() : [e.target];
    for (const n of path) if (n && n.id === HOST_ID) return null; // our pill
    let t = path[0];
    if (t && t.nodeType !== 1) t = t.parentElement;
    return t && t.nodeType === 1 ? t : null;
  }

  function capture(kind, e) {
    const raw = targetOf(e);
    if (!raw) return;
    const el = kind === 'click' ? interactive(raw) : raw;
    try {
      send({ type: 'event', kind, key: e.key, detail: e.detail, docId, elementId: idOf(el), ts: Date.now(), fp: fingerprint(el) });
    } catch {}
  }

  window.addEventListener('click', (e) => capture('click', e), true);
  window.addEventListener('input', (e) => capture('input', e), true);
  window.addEventListener('change', (e) => capture('change', e), true);
  window.addEventListener('keydown', (e) => {
    if (e.key && (e.key.length > 1 || e.ctrlKey || e.metaKey || e.altKey)) capture('keydown', e);
  }, true);

  // ── Options picked on mouse-down ─────────────────────────────────────
  // Many custom dropdowns (OrangeHRM, vue-select) choose the option on
  // mousedown and remove the list at once, so no click ever reaches it and
  // Playwright's recorder logs nothing. Measured on OrangeHRM: mousedown on
  // the option, the list removed ~2 ms later, mouseup on whatever was
  // underneath, no click. A dismissal (clicking elsewhere) has the same
  // shape except the mousedown is outside any option.
  //
  // So: on a mousedown inside an element with an explicit option-like role,
  // read it now, while it still exists. If a click reaches it within 500 ms
  // the list selects on click and the recorder logs that as usual; report
  // nothing. If it's gone or hidden by then, it was picked; report it. If
  // it's still showing (the person dragged off it), nothing was picked.
  // Native <option>s have no role attribute and never match.
  const PICKABLE = '[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=treeitem]';
  let pending = null;

  const shown = (el) => el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const accName = (el) => clean(el.getAttribute('aria-label'), 200) || textOf(el);
  const textOfId = (ids) => clean((ids || '').split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(textOf).join(' '));

  // The list's own label, else the form label next to it ("Employment
  // Status" above OrangeHRM's select), else the control that owns the list.
  function listLabel(opt) {
    const list = opt.closest('[role=listbox],[role=menu],[role=tree],[role=grid],[role=dialog]') || opt.parentElement;
    if (!list) return undefined;
    const own = clean(list.getAttribute('aria-label')) || textOfId(list.getAttribute('aria-labelledby'));
    if (own) return own;
    if (list.id) {
      const owner = document.querySelector('[aria-controls="' + CSS.escape(list.id) + '"],[aria-owns="' + CSS.escape(list.id) + '"]');
      // Only a real <label>: the owner's aria name is often its current
      // value (Select2's shows "Alaska"), which would read as the field's name.
      const real = owner && ((owner.labels && owner.labels[0]) || owner.closest('label'));
      if (real) { const l = textOf(real); if (l) return l; }
    }
    let a = list.parentElement;
    for (let i = 0; a && i < 6; i++, a = a.parentElement) {
      const lab = a.querySelector(':scope > label, :scope > * > label, :scope > legend');
      if (lab && !list.contains(lab)) return textOf(lab);
    }
    return undefined;
  }

  function nearestHeading(el) {
    const hs = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]'));
    let found;
    for (const h of hs) { if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = h; else break; }
    // Drop permalink marks docs sites append to headings (¶ # §).
    return found ? clean((textOf(found) || '').replace(/\\s*[¶#§]\\s*$/, '')) : undefined;
  }

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const raw = targetOf(e);
    const opt = raw && raw.closest(PICKABLE);
    if (!opt) return;
    const role = opt.getAttribute('role');
    const name = accName(opt);
    if (!name) return;
    // Options in an explicit listbox are located through it, which leaves
    // out the native <select> some widgets keep hidden but readable
    // (Select2: its <option>s also have the role "option"). The ordinal
    // counts the same set the locator will match.
    const inListbox = !!opt.closest('[role=listbox]');
    const pool = inListbox ? '[role=listbox] [role="' + role + '"]' : '[role="' + role + '"]';
    const same = Array.from(document.querySelectorAll(pool)).filter((o) => accName(o) === name);
    pending = {
      el: opt, clicked: false,
      msg: { type: 'pick', ts: Date.now(), docId, elementId: idOf(opt), role, name, inListbox, ordinal: Math.max(0, same.indexOf(opt)),
             sameCount: same.length, container: listLabel(opt), heading: nearestHeading(opt), fp: fingerprint(opt) },
    };
    const p = pending;
    setTimeout(() => {
      if (pending === p) pending = null;
      if (!p.clicked && !shown(p.el)) { try { send(p.msg); } catch {} }
    }, 500);
  }, true);
  window.addEventListener('click', (e) => {
    const t = targetOf(e);
    if (pending && t && pending.el.contains(t)) pending.clicked = true;
  }, true);

  if (window !== top) return;

  // ── Hide Playwright's recorder toolbar ───────────────────────────────
  // In the programmatic "api" recording mode Playwright still shows its own
  // toolbar (record / pick locator / assert buttons) in an <x-pw-glass>
  // element, and there's no option to turn it off in that mode. In this mode
  // the glass carries only that toolbar (hover highlights are off), so it is
  // hidden. x-pw-glass is a Playwright-internal tag name (playwright-core is
  // pinned); if a future version renames it, the toolbar just reappears.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('x-pw-glass { display: none !important; }');
    const adopt = () => {
      if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    };
    adopt();
    setInterval(adopt, 1000);
  } catch {}

  // ── Pill ─────────────────────────────────────────────────────────────
  let count = 0;
  let host, countEl, mainRow, confirmRow, savingRow;

  const css = \`
    .pill { display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px; border-radius: 999px;
      background: #1d2026; color: #f4f5f7; font: 500 14px/1.2 "Segoe UI", system-ui, -apple-system, sans-serif;
      box-shadow: 0 6px 24px rgba(0,0,0,.28), 0 0 0 1px rgba(255,255,255,.06); user-select: none; }
    .row { display: flex; align-items: center; gap: 10px; }
    .hidden { display: none; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #e5484d; animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
    .count { color: #a9afba; font-variant-numeric: tabular-nums; }
    button { all: unset; cursor: pointer; border-radius: 999px; font: inherit; }
    button:focus-visible { outline: 2px solid #7aa7ff; outline-offset: 2px; }
    .done { background: #f4f5f7; color: #1d2026; padding: 6px 14px; font-weight: 600; }
    .done:hover { background: #ffffff; }
    .x { width: 28px; height: 28px; display: grid; place-items: center; color: #a9afba; font-size: 18px; line-height: 1; }
    .x:hover { background: rgba(255,255,255,.1); color: #f4f5f7; }
    .danger { background: #e5484d; color: #fff; padding: 6px 14px; font-weight: 600; }
    .plain { padding: 6px 12px; color: #d5d8de; }
    .plain:hover { background: rgba(255,255,255,.1); }
  \`;

  const stepsText = (n) => n === 1 ? '1 step' : n + ' steps';
  function setCount(n) { count = n; if (countEl) countEl.textContent = stepsText(n); }
  Object.defineProperty(window, SET_COUNT, { value: setCount });

  function show(row) { for (const r of [mainRow, confirmRow, savingRow]) r.classList.toggle('hidden', r !== row); }

  function build() {
    host = document.createElement(HOST_ID);
    host.id = HOST_ID;
    host.setAttribute('aria-hidden', 'true');
    // The browser's top layer (popover) draws above every z-index, so site
    // overlays (cookie bars, bottom ads) can't cover the pill. The inline
    // !important styles undo the popover's default box and place it.
    host.setAttribute('popover', 'manual');
    host.style.cssText = [
      'all: initial', 'position: fixed', 'inset: auto', 'left: 50%', 'bottom: 20px', 'transform: translateX(-50%)',
      'margin: 0', 'padding: 0', 'border: 0', 'background: transparent', 'overflow: visible', 'display: block',
      'z-index: 2147483647',
    ].map((d) => d + ' !important').join(';');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>' + css + '</style>' +
      '<div class="pill">' +
        '<div class="row main"><span class="dot"></span><span>Recording</span><span class="count"></span>' +
          '<button class="done" type="button">Done</button>' +
          '<button class="x" type="button" title="Throw away this recording">\\u00d7</button></div>' +
        '<div class="row confirm hidden"><span>Throw away this recording?</span>' +
          '<button class="danger" type="button">Throw away</button>' +
          '<button class="plain" type="button">Keep recording</button></div>' +
        '<div class="row saving hidden"><span class="dot"></span><span class="saving-text">Finishing\\u2026</span></div>' +
      '</div>';
    mainRow = root.querySelector('.main');
    confirmRow = root.querySelector('.confirm');
    savingRow = root.querySelector('.saving');
    countEl = root.querySelector('.count');
    setCount(count);
    root.querySelector('.done').addEventListener('click', () => { show(savingRow); send({ type: 'done' }); });
    root.querySelector('.x').addEventListener('click', () => show(confirmRow));
    root.querySelector('.plain').addEventListener('click', () => show(mainRow));
    root.querySelector('.danger').addEventListener('click', () => {
      show(savingRow); root.querySelector('.saving-text').textContent = 'Throwing away\\u2026'; send({ type: 'discard' });
    });
    // Keep clicks on the pill from reaching the site's own handlers
    // (e.g. "click outside closes the menu").
    for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      root.addEventListener(t, (e) => e.stopPropagation());
    }
  }

  function mount() {
    if (!document.body) return;
    if (!host) build();
    if (!host.isConnected) document.documentElement.appendChild(host);
    // Re-enter the top layer if something (a re-render, a light-dismiss)
    // closed it. A site modal opened later can still sit above the pill.
    try {
      if (!host.matches(':popover-open')) host.showPopover();
    } catch {}
  }
  document.addEventListener('DOMContentLoaded', mount);
  // Single-page apps sometimes replace the whole document body.
  setInterval(mount, 1000);
  mount();
  send({ type: 'hello' }).then((r) => { if (r && typeof r.count === 'number') setCount(r.count); }).catch(() => {});
})();`;
