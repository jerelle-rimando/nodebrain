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

// The element facts the recorder captures at event time (label, name
// attribute, test id, input type, page path, frame…), as page-side source.
// Shared with workflow repair (replay/repair.ts), which reads the same facts
// from the element a person points at, so a repaired step's fingerprint is
// built exactly like a recorded one. Defines clean, textOf, labelOf,
// interactive and fingerprint; expects `document`, `location` and `window`.
export const ELEMENT_FACTS_SOURCE = `  const clean = (s, max = 120) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, max) || undefined;
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
    if (!isButtonLike) fp.fieldIndex = fieldIndexOf(el);
    return fp;
  }

  // Where a field sits among the page's visible fill-in fields, from 1. Pages
  // often label fields uselessly ("Input: Text"); the position still tells
  // two of them apart.
  function fieldIndexOf(el) {
    try {
      if (!el.matches('input,textarea,select')) return undefined;
      const fields = Array.from(document.querySelectorAll('input,textarea,select')).filter((f) =>
        f === el || (!/^(hidden|submit|button|reset|image)$/i.test(f.type || '') && f.getClientRects().length > 0));
      const i = fields.indexOf(el);
      return i >= 0 ? i + 1 : undefined;
    } catch { return undefined; }
  }

`;

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
${ELEMENT_FACTS_SOURCE}  function targetOf(e) {
    const path = e.composedPath ? e.composedPath() : [e.target];
    for (const n of path) if (n && n.id === HOST_ID) return null; // our pill
    let t = path[0];
    if (t && t.nodeType !== 1) t = t.parentElement;
    return t && t.nodeType === 1 ? t : null;
  }

  // A click on a plain box drawn around one text field (Roblox's
  // div[data-testid=text-input-container] around its password input) is
  // about the field: the box has nothing to find it by on a redesigned page.
  // Only text-entry fields count (a checkbox's wrapper is often the real
  // control), only a field at most three levels down, and only when the
  // field fills a good part of the box, so a click on a big container that
  // happens to hold one field stays a click on that container.
  const TEXT_FIELD = 'input:not([type]),input[type=text],input[type=password],input[type=email],input[type=tel],' +
    'input[type=url],input[type=search],input[type=number],input[type=date],input[type=datetime-local],' +
    'input[type=month],input[type=time],input[type=week],textarea,select,[contenteditable=""],[contenteditable=true]';
  function fieldInside(el) {
    try {
      if (el.matches('input,textarea,select,button,a,label,[role],[contenteditable]')) return null;
      const fields = Array.from(el.querySelectorAll(TEXT_FIELD)).filter((f) => f.getClientRects().length > 0);
      if (fields.length !== 1) return null;
      const f = fields[0];
      let depth = 0;
      for (let p = f.parentElement; p && p !== el; p = p.parentElement) depth++;
      if (depth > 2) return null;
      const a = el.getBoundingClientRect();
      const b = f.getBoundingClientRect();
      if (b.width * b.height <= 0 || a.width * a.height > 4 * b.width * b.height) return null;
      return f;
    } catch { return null; }
  }

  // ── Pop-ups and banners: when each appeared ───────────────────────────
  // A cookie banner or "what's new" box shows up on its own; a confirm
  // dialog shows up because the person just clicked something. Which one a
  // clicked layer was decides whether its step may be marked "doesn't always
  // appear" (reviewDraft.ts maybeOptional). So: the times of the person's
  // own mouse-downs and key presses, and the first time each candidate layer
  // was seen showing (checked every 250 ms). Candidates: the page's
  // top-level boxes (where banners are put) and anything marked as a dialog.
  const actTimes = [];
  const seenAt = new WeakMap();
  const noteAct = (e) => {
    if (!e.isTrusted || !targetOf(e)) return;
    actTimes.push(Date.now());
    if (actTimes.length > 50) actTimes.shift();
  };
  window.addEventListener('mousedown', noteAct, true);
  window.addEventListener('keydown', noteAct, true);
  const up = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
  const styleOf = (n) => { try { return getComputedStyle(n); } catch { return null; } };
  function showing(n) {
    const r = n.getBoundingClientRect();
    if (r.width * r.height <= 0) return false;
    const s = styleOf(n);
    return !!s && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }
  // The box or something inside it: a banner's host is often empty itself,
  // with its content fixed to the screen (or in a shadow root).
  function showingDeep(n) {
    if (showing(n)) return true;
    const queue = [n];
    let looked = 0;
    while (queue.length && looked < 80) {
      const x = queue.shift();
      looked++;
      const kids = [...(x.children || []), ...(x.shadowRoot ? x.shadowRoot.children : [])];
      for (const k of kids) { if (showing(k)) return true; queue.push(k); }
    }
    return false;
  }
  function scanLayers() {
    const now = Date.now();
    const candidates = [...(document.body ? document.body.children : [])];
    for (const n of document.querySelectorAll('dialog,[role=dialog],[role=alertdialog],[aria-modal=true]')) candidates.push(n);
    for (const n of candidates) {
      if (seenAt.has(n)) continue;
      try { if (showingDeep(n)) seenAt.set(n, now); } catch {}
    }
  }
  setInterval(scanLayers, 250);

  const DIALOG = 'dialog,[role=dialog],[role=alertdialog],[aria-modal=true]';
  const CONSENT = /cookie|consent|privacy (settings|preferences|choices|center|centre)|tracking technolog|personal data|gdpr|ccpa|do not sell/i;
  const VENDOR = /onetrust|usercentrics|cookiebot|didomi|trustarc|truste|quantcast|cookieyes|osano|termly|iubenda|cookielaw|(^|[^a-z])uc-|(^|[^a-z])cmp([^a-z]|$)/i;
  const PROMO = /newsletter|subscribe|what'?s new|special offer|\\d+ ?% off|discount|limited time|new feature|sign up for (our|email)/i;
  const DISMISS = /^(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|ok(ay)?|got it|close|close layer|dismiss|no,? thanks|not now|maybe later|reject( all)?|deny|decline|skip|continue without accepting|×|✕|x)$/i;

  // The layer a clicked element sits in: the nearest dialog, or the nearest
  // box fixed or stuck to the screen. Undefined for ordinary page content.
  function layerOf(el) {
    let layer = null;
    let top = null;
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = up(n)) {
      const s = styleOf(n);
      if (!layer && (n.matches(DIALOG) || (s && (s.position === 'fixed' || s.position === 'sticky')))) layer = n;
      top = n;
    }
    if (!layer) return undefined;
    // When it appeared: the layer's own time, else its top-level box's,
    // but only a box that is a layer itself (fixed, or with no size of its
    // own around fixed content), not the page's main container.
    let appeared = seenAt.get(layer);
    if (appeared === undefined && top && top !== layer) {
      const s = styleOf(top);
      const r = top.getBoundingClientRect();
      if (s && (s.position === 'fixed' || s.position === 'absolute' || r.width * r.height <= 0)) appeared = seenAt.get(top);
    }
    // Asked for: one of the person's own actions in the 1.75 s before it
    // was first seen (the scan runs every 250 ms). Not known: not counted
    // as unasked.
    const unasked = appeared !== undefined && !actTimes.some((t) => t <= appeared && t >= appeared - 1750);
    const words = String(layer.innerText || layer.textContent || '').slice(0, 4000);
    const marks = [];
    for (let n = layer; n && n !== document.documentElement; n = up(n)) {
      marks.push(n.id || '', typeof n.className === 'string' ? n.className : '', n.getAttribute('data-testid') || '', n.tagName.toLowerCase());
    }
    for (let n = el; n && n !== layer; n = up(n)) marks.push(n.id || '', n.getAttribute('data-testid') || '');
    const name = clean(el.getAttribute('aria-label') || el.innerText || el.textContent || el.value, 60) || '';
    return {
      node: layer,
      facts: {
        unasked,
        consent: CONSENT.test(words),
        vendor: VENDOR.test(marks.join(' ')) || /usercentrics|onetrust|cookiebot|didomi|trustarc/i.test(words),
        promo: PROMO.test(words),
        dismissWord: DISMISS.test(name),
      },
    };
  }

  // ── Buttons that answer a question ────────────────────────────────────
  // Yes / No under "Does your business currently have workers' comp?" is a
  // choice, like picking from a list. A clicked button counts when it sits
  // in a group of 2–6 buttons with no boxes to fill, none of which moves
  // the form along (Next, Back, Submit…), under a question: a heading or
  // label ending in "?", or a fieldset / radio group's own label.
  const MOVER = /^(next|continue|back|previous|prev|submit|save|cancel|close|skip|done|finish|get (a|my) quote|sign ?in|log ?in|sign ?up|search|go|apply|ok|okay|start|start over|edit|delete|remove|add|more|less|show more|learn more)$/i;
  const BUTTONS = 'button,[role=button],input[type=button],input[type=submit]';
  const buttonName = (n) => clean(n.getAttribute('aria-label') || n.innerText || n.textContent || n.value, 80);
  function questionFor(box) {
    for (let n = box, d = 0; n && d < 4; n = n.parentElement, d++) {
      if (n.matches('fieldset')) { const lg = n.querySelector('legend'); if (lg && textOf(lg)) return textOf(lg); }
      if (n.matches('[role=radiogroup],[role=group]')) { const l = n.getAttribute('aria-label'); if (l) return clean(l); }
      let p = n.previousElementSibling;
      for (let i = 0; p && i < 3; i++, p = p.previousElementSibling) {
        if (p.matches('h1,h2,h3,h4,h5,h6,[role=heading],legend,label,p,span,div') && !p.querySelector(BUTTONS + ',input,select,textarea')) {
          const t = textOf(p);
          if (t && t.length <= 200 && /\\?\\s*$/.test(t)) return t;
        }
      }
    }
    return undefined;
  }
  function choiceGroupOf(el) {
    if (!el.matches(BUTTONS)) return undefined;
    let box = el.parentElement;
    for (let d = 0; d < 3 && box && box !== document.body; d++, box = box.parentElement) {
      const buttons = Array.from(box.querySelectorAll(BUTTONS)).filter((b) => showing(b));
      if (buttons.length < 2) continue;
      if (buttons.length > 6 || box.querySelector('input:not([type=button]):not([type=submit]):not([type=hidden]):not([type=radio]):not([type=checkbox]),select,textarea')) return undefined;
      const names = buttons.map(buttonName);
      if (names.some((n) => !n || MOVER.test(n)) || new Set(names).size !== names.length) return undefined;
      const question = questionFor(box);
      return question ? { question, options: names } : undefined;
    }
    return undefined;
  }

  function capture(kind, e) {
    const raw = targetOf(e);
    if (!raw) return;
    let el = kind === 'click' ? interactive(raw) : raw;
    let wrapped = false;
    if (kind === 'click') {
      const inner = fieldInside(el);
      if (inner) { el = inner; wrapped = true; }
    }
    try {
      const fp = fingerprint(el);
      if (wrapped) fp.wrapped = true;
      let layer;
      if (kind === 'click') {
        try { fp.choiceGroup = choiceGroupOf(el); } catch {}
        try { layer = layerOf(el); } catch {}
        if (layer) fp.layer = layer.facts;
      }
      const elementId = idOf(el);
      send({ type: 'event', kind, key: e.key, detail: e.detail, docId, elementId, ts: Date.now(), fp });
      // Did the click put the layer away, with the page staying where it
      // was? Checked a moment later; a page that navigated never answers.
      if (layer) {
        const href = location.href;
        setTimeout(() => {
          let gone = false;
          try { gone = location.href === href && (!layer.node.isConnected || !showingDeep(layer.node)); } catch {}
          try { send({ type: 'layerDone', docId, elementId, gone }); } catch {}
        }, 900);
      }
    } catch {}
  }

  // ── What a box shows once the page has formatted it ──────────────────
  // Playwright's recorder reads a box's value on the input event, at the
  // window, before the page's own listener runs. A page that formats as you
  // type ("285000" → "285,000") rewrites the value after that read, and no
  // further input event follows, so the recorder keeps the raw value with
  // the last keystroke added to the previous formatting: "28,500" + "0" =
  // "28,5000". So shortly after each keystroke, and when the box loses focus,
  // the value is read again and sent when the page changed it. Never for a
  // password box.
  const rawSeen = new WeakMap();
  function settledValue(el, raw) {
    const now = el.value;
    if (typeof now === 'string' && now !== raw) {
      try { send({ type: 'settled', docId, elementId: idOf(el), raw, value: now }); } catch {}
    }
  }
  function watchValue(e) {
    const el = targetOf(e);
    if (!el || typeof el.value !== 'string' || (el.type || '').toLowerCase() === 'password') return;
    const raw = el.value;
    rawSeen.set(el, raw);
    setTimeout(() => { if (rawSeen.get(el) === raw) settledValue(el, raw); }, 60);
  }

  window.addEventListener('click', (e) => capture('click', e), true);
  window.addEventListener('input', (e) => { capture('input', e); watchValue(e); }, true);
  window.addEventListener('change', (e) => capture('change', e), true);
  window.addEventListener('focusout', (e) => {
    const el = targetOf(e);
    if (el && rawSeen.has(el)) settledValue(el, rawSeen.get(el));
  }, true);
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
          '<button class="danger" type="button">Delete</button>' +
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
      show(savingRow); root.querySelector('.saving-text').textContent = 'Deleting workflow\\u2026'; send({ type: 'discard' });
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
