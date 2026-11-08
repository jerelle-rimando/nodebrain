// Resolves the vault key — the secret that encrypts stored credentials.
//
// It lives only in Windows Credential Manager (via keytar). Builds up to 0.5.0
// also kept a plaintext copy in nodebrain-store.json, beside the database it
// decrypts; that copy is migrated out here and never written again.
//
// The store keeps vaultKeyCheck instead: a one-way fingerprint of the key. It
// reveals nothing about a 256-bit random key, but lets us tell "the key went
// missing" from "fresh install" and "a different key is in Credential Manager"
// from "the right one", so neither silently mints a new key and orphans the
// user's credentials.
//
// A Credential Manager error is never treated as "not found": keytar resolves
// null only for ERROR_NOT_FOUND and rejects on anything else.
//
// Kept free of Electron imports so every path can be exercised with fakes.

import * as crypto from 'crypto';

export const VAULT_SERVICE = 'NodeBrain';
export const VAULT_ACCOUNT = 'vault-secret';

export interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

export interface VaultStore {
  getLegacySecret(): string | undefined;   // nodebrain-store.json "vaultSecret"
  deleteLegacySecret(): void;
  getCheck(): string | undefined;          // "vaultKeyCheck"
  setCheck(check: string): void;
  isSetupComplete(): boolean;
}

export interface VaultUi {
  log(msg: string): void;
  // Non-blocking: startup carries on with the legacy copy.
  warnNotMigrated(reason: string): void;
  // Non-blocking general warning.
  warn(message: string, detail: string): void;
  // Blocking. Resolves only if the user chose `continueLabel`; Quit never
  // resolves (the app exits).
  stop(message: string, detail: string, continueLabel: string): Promise<void>;
}

// Which candidate keys decrypt this install's existing encrypted data.
// samples = how many encrypted values were tested (0: nothing to lose).
// null = the probe itself failed.
export type ProbeResult = { samples: number; works: boolean[] } | null;

export interface VaultDeps {
  keytar: KeytarLike | null;               // null: the module failed to load
  keytarLoadError?: string;
  probeKeys(candidates: string[]): Promise<ProbeResult>;
  store: VaultStore;
  ui: VaultUi;
  randomSecret?: () => string;
}

export function vaultKeyCheck(secret: string): string {
  return crypto.createHash('sha256').update(`nodebrain-vault-key-check\0${secret}`).digest('hex').slice(0, 16);
}

type Read = { ok: true; value: string | null } | { ok: false; error: string };

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

async function readKey(d: VaultDeps): Promise<Read> {
  if (!d.keytar) return { ok: false, error: `the keytar module could not be loaded (${d.keytarLoadError ?? 'unknown error'})` };
  try {
    const value = await d.keytar.getPassword(VAULT_SERVICE, VAULT_ACCOUNT);
    return { ok: true, value: value || null };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

// Writes, then reads back. Only a matching read-back counts as stored.
async function writeKey(d: VaultDeps, secret: string): Promise<string | null> {
  if (!d.keytar) return `the keytar module could not be loaded (${d.keytarLoadError ?? 'unknown error'})`;
  try {
    await d.keytar.setPassword(VAULT_SERVICE, VAULT_ACCOUNT, secret);
  } catch (err) {
    return `write failed: ${errText(err)}`;
  }
  const back = await readKey(d);
  if (!back.ok) return `read-back failed: ${back.error}`;
  if (back.value !== secret) return 'read-back returned a different value';
  return null;
}

function dropLegacy(d: VaultDeps, secret: string): void {
  // Fingerprint first: if the process dies between the two writes, the next
  // launch still knows a key is expected.
  d.store.setCheck(vaultKeyCheck(secret));
  d.store.deleteLegacySecret();
}

export const CREDENTIAL_MANAGER_HELP =
  'NodeBrain keeps the key that protects your saved passwords in Windows Credential Manager. ' +
  'It may be blocked by a work or school policy, or the Credential Manager service may be turned off.';

async function generate(d: VaultDeps): Promise<string> {
  const random = d.randomSecret ?? (() => crypto.randomBytes(32).toString('hex'));
  for (;;) {
    const secret = random();
    const err = await writeKey(d, secret);
    if (!err) {
      d.store.setCheck(vaultKeyCheck(secret));
      return secret;
    }
    d.ui.log(`vault key: could not store a new key: ${err}`);
    // A key we can't store is lost at exit, and with it every credential
    // saved this session — refuse rather than pretend.
    await d.ui.stop(
      "NodeBrain can't store its saved-password key",
      `${CREDENTIAL_MANAGER_HELP}\n\nNodeBrain can't start without it.\n\nDetails: ${err}`,
      'Try again',
    );
  }
}

// Credential Manager and the settings file hold different keys. Earlier builds
// always preferred Credential Manager and overwrote the file with it, so this
// means a settings write failed or something edited one of them. Rather than
// guess, test which key actually decrypts this install's data.
async function resolveDisagreement(d: VaultDeps, cm: string, legacy: string): Promise<string> {
  const { ui } = d;
  ui.log('vault key: Credential Manager and settings-file copies DISAGREE — testing which decrypts existing data');
  let result: ProbeResult;
  try { result = await d.probeKeys([cm, legacy]); } catch (err) { ui.log(`vault key: probe threw: ${errText(err)}`); result = null; }

  const leaveBoth = (why: string): string => {
    // Both copies stay exactly as they are; the Credential Manager copy is
    // what earlier builds used, so behaviour is unchanged.
    ui.log(`vault key: leaving both copies untouched — ${why}`);
    ui.warn(
      'NodeBrain found two different saved-password keys',
      `${why}\n\nBoth have been kept and nothing was deleted. NodeBrain is using the one in Windows Credential Manager. ` +
      "If saved passwords, secret workflow values or integration keys don't work, they may need re-entering.",
    );
    return cm;
  };

  if (!result) return leaveBoth("NodeBrain couldn't check which key your saved data uses.");

  const [cmWorks, legacyWorks] = result.works;
  ui.log(`vault key: probe — ${result.samples} encrypted value(s); Credential Manager key ${cmWorks ? 'works' : 'fails'}, settings-file key ${legacyWorks ? 'works' : 'fails'}`);

  if (result.samples === 0) {
    // Nothing encrypted yet: neither key protects anything, so nothing can be
    // lost. Keep the one earlier builds used.
    dropLegacy(d, cm);
    return cm;
  }
  if (cmWorks && !legacyWorks) {
    dropLegacy(d, cm);
    return cm;
  }
  if (legacyWorks && !cmWorks) {
    // The Credential Manager key decrypts none of the data, so replacing it
    // loses nothing — but only drop the file copy once the write verifies.
    const err = await writeKey(d, legacy);
    if (err) {
      ui.log(`vault key: couldn't replace the Credential Manager key (${err}) — keeping the settings-file copy`);
      ui.warnNotMigrated(err);
      return legacy;
    }
    ui.log('vault key: replaced the Credential Manager key with the settings-file key and verified');
    dropLegacy(d, legacy);
    return legacy;
  }
  return leaveBoth(cmWorks
    ? 'Both keys appear to unlock your saved data, which should not happen.'
    : "Neither key unlocks your saved data.");
}

export async function resolveVaultSecret(d: VaultDeps): Promise<string> {
  const { store, ui } = d;
  let legacy: string | undefined;
  try { legacy = store.getLegacySecret() || undefined; } catch { /* unreadable */ }

  for (;;) {
    const read = await readKey(d);

    if (!read.ok) {
      ui.log(`vault key: Credential Manager read failed: ${read.error}`);
      if (legacy) {
        // Can't verify or migrate; the legacy copy is still the working key.
        ui.warnNotMigrated(read.error);
        return legacy;
      }
      // Never generate here: the real key may be in Credential Manager and
      // just unreadable right now — a new one would overwrite it.
      await ui.stop(
        "NodeBrain can't read its saved-password key",
        `${CREDENTIAL_MANAGER_HELP}\n\nNodeBrain can't start without it.\n\nDetails: ${read.error}`,
        'Try again',
      );
      continue;
    }

    const cm = read.value;
    const check = store.getCheck();

    if (cm && legacy) {
      if (cm === legacy) {
        ui.log('vault key: both copies match — removing the plaintext copy');
        dropLegacy(d, cm);
        return cm;
      }
      return resolveDisagreement(d, cm, legacy);
    }

    if (cm) {
      if (check && check !== vaultKeyCheck(cm)) {
        ui.log("vault key: Credential Manager key doesn't match this install's fingerprint");
        await ui.stop(
          "The saved-password key in Windows Credential Manager doesn't match this NodeBrain install",
          "Your saved passwords, secret workflow values and integration keys were protected with a different key, so NodeBrain can't read them with this one. " +
          "If you carry on, NodeBrain will use the key that's there now and you'll need to re-enter those.",
          'Continue anyway',
        );
      }
      if (check !== vaultKeyCheck(cm)) store.setCheck(vaultKeyCheck(cm));
      return cm;
    }

    // Credential Manager definitely has no key.
    if (legacy) {
      const err = await writeKey(d, legacy);
      if (err) {
        ui.log(`vault key: migration to Credential Manager failed (${err}) — keeping the settings-file copy`);
        ui.warnNotMigrated(err);
        return legacy;
      }
      ui.log('vault key: migrated to Credential Manager and verified — removing the plaintext copy');
      dropLegacy(d, legacy);
      return legacy;
    }

    // Neither copy. A fresh install — unless this install had a key before.
    if (check || store.isSetupComplete()) {
      ui.log(`vault key: MISSING (fingerprint ${check ? 'present' : 'absent'}, setup ${store.isSetupComplete() ? 'complete' : 'not complete'})`);
      await ui.stop(
        "NodeBrain's saved-password key is missing",
        'The key that protects your saved passwords is no longer in Windows Credential Manager, so they can\'t be read — ' +
        'nor can secret values recorded in workflows, or integration settings that hold keys or tokens. ' +
        'Everything else in your workflows is not affected.\n\n' +
        "If you carry on, NodeBrain will create a new key and you'll need to re-enter those.",
        'Create a new key',
      );
    }
    return generate(d);
  }
}
