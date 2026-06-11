import CryptoJS from 'crypto-js';
import { dbRun, dbGet, dbAll } from '../db/database';
import { v4 as uuidv4 } from 'uuid';
import type { Credential } from '../../shared-types';

function getEncryptionKey(): string {
  const envKey = process.env.VAULT_SECRET;
  if (!envKey) {
    throw new Error('VAULT_SECRET is not set. NodeBrain cannot start without it.');
  }
  return CryptoJS.SHA256(envKey).toString();
}

export function encryptValue(plaintext: string): string {
  if (!plaintext) return '';
  return CryptoJS.AES.encrypt(plaintext, getEncryptionKey()).toString();
}

export function decryptValue(ciphertext: string): string {
  if (!ciphertext) return '';
  const plaintext = CryptoJS.AES.decrypt(ciphertext, getEncryptionKey()).toString(CryptoJS.enc.Utf8);
  if (!plaintext) {
    throw new Error('Failed to decrypt credential — VAULT_SECRET may have changed.');
  }
  return plaintext;
}

interface CredentialRow {
  id: string; name: string; provider: string;
  description: string | null; encrypted_value: string; created_at: string;
  base_url: string | null;
}

function rowToCredential(row: CredentialRow): Credential {
  return { id: row.id, name: row.name, provider: row.provider,
    description: row.description ?? undefined, createdAt: row.created_at,
    baseUrl: row.base_url ?? undefined };
}

export function getAllCredentials(): Credential[] {
  return dbAll<CredentialRow>('SELECT * FROM credentials ORDER BY created_at DESC').map(rowToCredential);
}

export function getCredentialById(id: string): Credential | null {
  const row = dbGet<CredentialRow>('SELECT * FROM credentials WHERE id = ?', [id]);
  return row ? rowToCredential(row) : null;
}

export function getCredentialValue(id: string): string | null {
  const row = dbGet<{ encrypted_value: string }>('SELECT encrypted_value FROM credentials WHERE id = ?', [id]);
  return row ? decryptValue(row.encrypted_value) : null;
}

export function createCredential(name: string, provider: string, value: string, description?: string, baseUrl?: string): Credential {
  const id = uuidv4();
  const now = new Date().toISOString();
  dbRun(
    'INSERT INTO credentials (id, name, provider, description, encrypted_value, created_at, base_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, name, provider, description ?? null, encryptValue(value), now, baseUrl ?? null],
  );
  return { id, name, provider, description, createdAt: now, baseUrl: baseUrl ?? undefined };
}

export function updateCredential(id: string, value: string): boolean {
  const existing = getCredentialById(id);
  if (!existing) return false;
  dbRun('UPDATE credentials SET encrypted_value=? WHERE id=?', [encryptValue(value), id]);
  return true;
}

export function deleteCredential(id: string): boolean {
  const existing = getCredentialById(id);
  if (!existing) return false;
  dbRun('DELETE FROM credentials WHERE id=?', [id]);
  return true;
}

export function getCredentialForProvider(provider: string): string | null {
  const row = dbGet<{ encrypted_value: string }>('SELECT encrypted_value FROM credentials WHERE provider=? LIMIT 1', [provider]);
  return row ? decryptValue(row.encrypted_value) : null;
}

export function getBaseUrlForProvider(provider: string): string | null {
  const row = dbGet<{ base_url: string | null }>('SELECT base_url FROM credentials WHERE provider=? LIMIT 1', [provider]);
  return row?.base_url ?? null;
}
