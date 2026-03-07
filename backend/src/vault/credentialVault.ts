import CryptoJS from 'crypto-js';
import { dbRun, dbGet, dbAll } from '../db/database';
import { v4 as uuidv4 } from 'uuid';
import type { Credential } from '../../shared-types';

function getEncryptionKey(): string {
  const envKey = process.env.VAULT_SECRET ?? 'nodebrain-local-vault-key-change-in-production';
  return CryptoJS.SHA256(envKey).toString();
}

export function encryptValue(plaintext: string): string {
  return CryptoJS.AES.encrypt(plaintext, getEncryptionKey()).toString();
}

export function decryptValue(ciphertext: string): string {
  return CryptoJS.AES.decrypt(ciphertext, getEncryptionKey()).toString(CryptoJS.enc.Utf8);
}

interface CredentialRow {
  id: string; name: string; provider: string;
  description: string | null; encrypted_value: string; created_at: string;
}

function rowToCredential(row: CredentialRow): Credential {
  return { id: row.id, name: row.name, provider: row.provider,
    description: row.description ?? undefined, createdAt: row.created_at };
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

export function createCredential(name: string, provider: string, value: string, description?: string): Credential {
  const id = uuidv4();
  const now = new Date().toISOString();
  dbRun(
    'INSERT INTO credentials (id, name, provider, description, encrypted_value, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name, provider, description ?? null, encryptValue(value), now],
  );
  return { id, name, provider, description, createdAt: now };
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
