// ═══════════════════════════════════════════════════════════════════════════
//  Auth Utilities — Encryption, JWT, Password Hashing
// ═══════════════════════════════════════════════════════════════════════════

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET || '';

if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 32) {
  console.warn('WARNING: ENCRYPTION_KEY not set or too short. Token encryption is insecure!');
}

if (!JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET not set. JWT tokens are insecure!');
}

// Derive a 32-byte key from the env variable
function getKey(): Buffer {
  const key = ENCRYPTION_KEY || 'default-insecure-key-change-immediately!!';
  return scryptSync(key, 'meta-ads-mcp-salt', 32);
}

// ── AES-256-GCM Token Encryption ──
export function encryptToken(plainText: string): string {
  const key = getKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

export function decryptToken(encrypted: string): string {
  const key = getKey();
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted token format');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encryptedText = parts[2];
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ── JWT ──
export function signJwt(payload: Record<string, unknown>, expiresIn: string | number = '7d'): string {
  const secret = JWT_SECRET || 'insecure-default-secret';
  return jwt.sign(payload, secret, { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] });
}

export function verifyJwt(token: string): Record<string, unknown> | null {
  try {
    return jwt.verify(token, JWT_SECRET || 'insecure-default-secret') as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Password Hashing ──
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ── API Key Generation ──
export function generateApiKey(): string {
  return 'mak_' + randomBytes(32).toString('hex');
}

export function generatePassword(length = 16): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let pw = '';
  const rb = randomBytes(length);
  for (let i = 0; i < length; i++) {
    pw += chars[rb[i] % chars.length];
  }
  return pw;
}
