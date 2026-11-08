// Every path through resolveVaultSecret, with fake keytar / store / dialogs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVaultSecret, vaultKeyCheck, ProbeResult, VaultDeps } from '../vaultKey';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const NEW = 'n'.repeat(64);
const QUIT = new Error('QUIT');

interface Opts {
  cm?: string;
  cmReadErr?: string | ((call: number) => string | null);
  cmWriteErr?: string | (() => string | null);
  cmReadBackWrong?: boolean;
  noKeytar?: boolean;
  json?: string;
  check?: string;
  setup?: boolean;
  stopAnswers?: Array<'continue' | 'quit'>;
  probe?: ProbeResult | 'throw';
}

function harness(o: Opts) {
  const state = {
    cm: o.cm as string | undefined,
    json: o.json,
    check: o.check,
    stops: [] as string[],
    warns: [] as string[],
    notMigrated: [] as string[],
    logs: [] as string[],
    probes: [] as string[][],
    readCalls: 0,
  };
  const answers = [...(o.stopAnswers ?? [])];
  const deps: VaultDeps = {
    keytar: o.noKeytar ? null : {
      async getPassword() {
        state.readCalls++;
        const err = typeof o.cmReadErr === 'function' ? o.cmReadErr(state.readCalls) : o.cmReadErr;
        if (err) throw new Error(err);
        return state.cm ?? null;
      },
      async setPassword(_s, _a, v) {
        const err = typeof o.cmWriteErr === 'function' ? o.cmWriteErr() : o.cmWriteErr;
        if (err) throw new Error(err);
        state.cm = o.cmReadBackWrong ? 'garbage' : v;
      },
    },
    keytarLoadError: o.noKeytar ? 'Cannot find module keytar.node' : undefined,
    randomSecret: () => NEW,
    async probeKeys(candidates) {
      state.probes.push(candidates);
      if (o.probe === 'throw') throw new Error('spawn failed');
      return o.probe ?? null;
    },
    store: {
      getLegacySecret: () => state.json,
      deleteLegacySecret: () => { state.json = undefined; },
      getCheck: () => state.check,
      setCheck: (c) => { state.check = c; },
      isSetupComplete: () => !!o.setup,
    },
    ui: {
      log: (m) => { state.logs.push(m); },
      warnNotMigrated: (r) => { state.notMigrated.push(r); },
      warn: (m) => { state.warns.push(m); },
      stop: async (message) => {
        state.stops.push(message);
        if (answers.shift() !== 'continue') throw QUIT;
      },
    },
  };
  return { state, run: () => resolveVaultSecret(deps) };
}

// ── Migration from the plaintext copy ────────────────────────────────────────

test('both present and matching: JSON copy deleted, fingerprint set', async () => {
  const { state, run } = harness({ cm: A, json: A });
  assert.equal(await run(), A);
  assert.equal(state.json, undefined);
  assert.equal(state.cm, A);
  assert.equal(state.check, vaultKeyCheck(A));
});

test('JSON only: written to Credential Manager, verified, then JSON deleted', async () => {
  const { state, run } = harness({ json: A, setup: true });
  assert.equal(await run(), A);
  assert.equal(state.cm, A);
  assert.equal(state.json, undefined);
  assert.equal(state.check, vaultKeyCheck(A));
});

test('JSON only, write fails: JSON kept and used, warned, no fingerprint', async () => {
  const { state, run } = harness({ json: A, cmWriteErr: 'Access is denied.', setup: true });
  assert.equal(await run(), A);
  assert.equal(state.json, A);
  assert.equal(state.check, undefined);
  assert.equal(state.notMigrated.length, 1);
});

test('JSON only, read-back returns a different value: JSON kept', async () => {
  const { state, run } = harness({ json: A, cmReadBackWrong: true, setup: true });
  assert.equal(await run(), A);
  assert.equal(state.json, A);
  assert.equal(state.check, undefined);
  assert.equal(state.notMigrated.length, 1);
});

test('JSON only, read-back throws: JSON kept', async () => {
  const { state, run } = harness({ json: A, cmReadErr: (n) => (n >= 2 ? 'boom' : null), setup: true });
  assert.equal(await run(), A);
  assert.equal(state.json, A);
  assert.equal(state.notMigrated.length, 1);
});

test('JSON only, Credential Manager read errors: JSON kept and used, CM untouched', async () => {
  const { state, run } = harness({ json: A, cmReadErr: 'A specified logon session does not exist.' });
  assert.equal(await run(), A);
  assert.equal(state.json, A);
  assert.equal(state.cm, undefined);
  assert.equal(state.notMigrated.length, 1);
});

test('JSON only, keytar fails to load: JSON kept and used', async () => {
  const { state, run } = harness({ json: A, noKeytar: true });
  assert.equal(await run(), A);
  assert.equal(state.json, A);
  assert.equal(state.notMigrated.length, 1);
});

// ── The two copies disagree ──────────────────────────────────────────────────

test('disagree, CM key decrypts the data: JSON copy deleted', async () => {
  const { state, run } = harness({ cm: A, json: B, probe: { samples: 3, works: [true, false] } });
  assert.equal(await run(), A);
  assert.deepEqual(state.probes, [[A, B]]);
  assert.equal(state.cm, A);
  assert.equal(state.json, undefined);
  assert.equal(state.check, vaultKeyCheck(A));
});

test('disagree, JSON key decrypts the data: CM replaced, verified, JSON deleted', async () => {
  const { state, run } = harness({ cm: A, json: B, probe: { samples: 3, works: [false, true] } });
  assert.equal(await run(), B);
  assert.equal(state.cm, B);
  assert.equal(state.json, undefined);
  assert.equal(state.check, vaultKeyCheck(B));
});

test('disagree, JSON key works but CM write fails: JSON kept and used, CM not trusted', async () => {
  const { state, run } = harness({ cm: A, json: B, cmWriteErr: 'Access is denied.', probe: { samples: 3, works: [false, true] } });
  assert.equal(await run(), B);
  assert.equal(state.json, B);
  assert.equal(state.check, undefined);
  assert.equal(state.notMigrated.length, 1);
});

test('disagree, nothing encrypted yet: CM key kept, JSON deleted', async () => {
  const { state, run } = harness({ cm: A, json: B, probe: { samples: 0, works: [false, false] } });
  assert.equal(await run(), A);
  assert.equal(state.json, undefined);
  assert.equal(state.check, vaultKeyCheck(A));
});

test('disagree, neither key decrypts: both left untouched, dialog shown', async () => {
  const { state, run } = harness({ cm: A, json: B, probe: { samples: 3, works: [false, false] } });
  assert.equal(await run(), A);
  assert.equal(state.cm, A);
  assert.equal(state.json, B);
  assert.equal(state.check, undefined);
  assert.equal(state.warns.length, 1);
});

test('disagree, both keys "decrypt": both left untouched, dialog shown', async () => {
  const { state, run } = harness({ cm: A, json: B, probe: { samples: 3, works: [true, true] } });
  assert.equal(await run(), A);
  assert.equal(state.json, B);
  assert.equal(state.warns.length, 1);
});

test('disagree, probe fails: both left untouched, dialog shown', async () => {
  const { state, run } = harness({ cm: A, json: B, probe: null });
  assert.equal(await run(), A);
  assert.equal(state.json, B);
  assert.equal(state.warns.length, 1);
});

test('disagree, probe throws: both left untouched, dialog shown', async () => {
  const { state, run } = harness({ cm: A, json: B, probe: 'throw' });
  assert.equal(await run(), A);
  assert.equal(state.json, B);
  assert.equal(state.warns.length, 1);
});

// ── No legacy copy ───────────────────────────────────────────────────────────

test('fresh install: key generated and stored, fingerprint written, nothing in JSON', async () => {
  const { state, run } = harness({});
  assert.equal(await run(), NEW);
  assert.equal(state.cm, NEW);
  assert.equal(state.json, undefined);
  assert.equal(state.check, vaultKeyCheck(NEW));
  assert.equal(state.stops.length, 0);
});

test('fresh install, CM write fails: stop dialog, Quit stores nothing', async () => {
  const { state, run } = harness({ cmWriteErr: 'Access is denied.' });
  await assert.rejects(run(), QUIT);
  assert.equal(state.cm, undefined);
  assert.equal(state.check, undefined);
});

test('fresh install, CM write fails then Try again succeeds', async () => {
  let n = 0;
  const { state, run } = harness({ cmWriteErr: () => (n++ === 0 ? 'Access is denied.' : null), stopAnswers: ['continue'] });
  assert.equal(await run(), NEW);
  assert.equal(state.cm, NEW);
  assert.equal(state.stops.length, 1);
});

test('CM read error with no JSON copy: stops, never generates', async () => {
  const { state, run } = harness({ cmReadErr: 'boom', check: vaultKeyCheck(A), setup: true });
  await assert.rejects(run(), QUIT);
  assert.equal(state.cm, undefined);
  assert.equal(state.check, vaultKeyCheck(A));
});

test('CM read error recovers on Try again: existing key used', async () => {
  const { state, run } = harness({ cm: A, cmReadErr: (n) => (n === 1 ? 'boom' : null), check: vaultKeyCheck(A), setup: true, stopAnswers: ['continue'] });
  assert.equal(await run(), A);
  assert.equal(state.stops.length, 1);
});

test('keytar missing, no JSON copy: stops', async () => {
  const { run } = harness({ noKeytar: true, setup: true });
  await assert.rejects(run(), QUIT);
});

test('normal launch after migration: no dialogs', async () => {
  const { state, run } = harness({ cm: A, check: vaultKeyCheck(A), setup: true });
  assert.equal(await run(), A);
  assert.equal(state.stops.length + state.warns.length + state.notMigrated.length, 0);
});

test('key missing after migration: stop, Quit changes nothing', async () => {
  const { state, run } = harness({ check: vaultKeyCheck(A), setup: true });
  await assert.rejects(run(), QUIT);
  assert.equal(state.cm, undefined);
  assert.equal(state.check, vaultKeyCheck(A));
});

test('key missing after migration: Create a new key', async () => {
  const { state, run } = harness({ check: vaultKeyCheck(A), setup: true, stopAnswers: ['continue'] });
  assert.equal(await run(), NEW);
  assert.equal(state.cm, NEW);
  assert.equal(state.check, vaultKeyCheck(NEW));
});

test('no key anywhere but setup complete: treated as missing, not fresh', async () => {
  const { state, run } = harness({ setup: true });
  await assert.rejects(run(), QUIT);
  assert.equal(state.cm, undefined);
});

test('CM key mismatches fingerprint: Quit leaves fingerprint alone', async () => {
  const { state, run } = harness({ cm: B, check: vaultKeyCheck(A), setup: true });
  await assert.rejects(run(), QUIT);
  assert.equal(state.check, vaultKeyCheck(A));
});

test('CM key mismatches fingerprint: Continue anyway adopts it', async () => {
  const { state, run } = harness({ cm: B, check: vaultKeyCheck(A), setup: true, stopAnswers: ['continue'] });
  assert.equal(await run(), B);
  assert.equal(state.check, vaultKeyCheck(B));
});

test('CM key present, no fingerprint, no JSON: adopted', async () => {
  const { state, run } = harness({ cm: A });
  assert.equal(await run(), A);
  assert.equal(state.check, vaultKeyCheck(A));
});
