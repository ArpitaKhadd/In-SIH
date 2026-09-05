import { query, transaction, setCurrentUser, DbProfile } from '@/lib/db/local';
import { createHash, randomBytes } from 'crypto';
import { createSession as createSessionCore, getSession as getSessionCore, deleteSession as deleteSessionCore } from './session';

// Re-export session functions using shared store
export const createSession = createSessionCore;
export const getSession = getSessionCore;
export const deleteSession = deleteSessionCore;

export interface SessionData {
  userId: string;
  role: string;
  expiresAt: number;
}

export interface PasswordStrengthResult {
  score: number;
  feedback: string[];
  isStrong: boolean;
}

export function validatePasswordStrength(password: string): PasswordStrengthResult {
  const feedback: string[] = [];
  let score = 0;

  if (password.length >= 8) score += 1;
  else feedback.push("At least 8 characters");

  if (/[A-Z]/.test(password)) score += 1;
  else feedback.push("One uppercase letter");

  if (/[a-z]/.test(password)) score += 1;
  else feedback.push("One lowercase letter");

  if (/[0-9]/.test(password)) score += 1;
  else feedback.push("One number");

  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  else feedback.push("One special character");

  return {
    score,
    feedback,
    isStrong: score >= 4,
  };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = createHash('sha256').update(salt + password).digest('hex');
  return `${salt}:${hash}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, hash] = storedHash.split(':');
  const computedHash = createHash('sha256').update(salt + password).digest('hex');
  return hash === computedHash;
}

export async function createUser(email: string, password: string, displayName: string, role: string = 'citizen'): Promise<{ userId: string; profile: DbProfile } | { error: string }> {
  const existing = await query<{ user_id: string }>('SELECT user_id FROM profiles WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return { error: 'Email already registered' };
  }

  const passwordHash = await hashPassword(password);
  const userId = crypto.randomUUID();

  try {
    await transaction(async (client) => {
      // Insert into users table (for password)
      await client.query(
        `INSERT INTO users (id, email, password_hash, email_verified, created_at, updated_at)
         VALUES ($1, $2, $3, true, NOW(), NOW())`,
        [userId, email, passwordHash]
      );
      // Insert into profiles table
      await client.query(
        `INSERT INTO profiles (user_id, email, display_name, role, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())`,
        [userId, email, displayName, role]
      );
    });
  } catch (err) {
    console.error('createUser error:', err);
    return { error: 'Registration failed' };
  }

  const profileResult = await query<DbProfile>(
    'SELECT * FROM profiles WHERE user_id = $1',
    [userId]
  );

  if (!profileResult.rows[0]) {
    return { error: 'Profile creation failed' };
  }

  return { userId, profile: profileResult.rows[0] };
}

export async function authenticateUser(email: string, password: string): Promise<{ userId: string; profile: DbProfile; token: string } | { error: string }> {
  const result = await query<DbProfile & { password_hash: string }>(
    'SELECT p.*, u.password_hash FROM profiles p JOIN users u ON p.user_id = u.id WHERE p.email = $1',
    [email]
  );

  if (result.rows.length === 0) {
    return { error: 'Invalid credentials' };
  }

  const user = result.rows[0];
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return { error: 'Invalid credentials' };
  }

  const token = await createSession(user.user_id, user.role);
  return { userId: user.user_id, profile: user, token };
}

export async function getProfile(userId: string): Promise<DbProfile | null> {
  const result = await query<DbProfile>('SELECT * FROM profiles WHERE user_id = $1', [userId]);
  return result.rows[0] || null;
}

export async function getUserById(userId: string): Promise<DbProfile | null> {
  const result = await query<DbProfile>('SELECT * FROM profiles WHERE user_id = $1', [userId]);
  return result.rows[0] || null;
}

export async function getProfileByEmail(email: string): Promise<DbProfile | null> {
  const result = await query<DbProfile>('SELECT * FROM profiles WHERE email = $1', [email]);
  return result.rows[0] || null;
}

export async function verifyPasswordByUserId(userId: string, password: string): Promise<boolean> {
  const result = await query<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId]
  );
  
  if (result.rows.length === 0) {
    return false;
  }
  
  return verifyPassword(password, result.rows[0].password_hash);
}

// We need a users table for password storage
// This should be added to the init script
export const CREATE_USERS_TABLE = `
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_email_idx ON public.users (email);
`;

export async function ensureUsersTable(): Promise<void> {
  await query(CREATE_USERS_TABLE);
}

// Password reset tokens
export interface PasswordResetToken {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  used: boolean;
}

export const CREATE_PASSWORD_RESET_TABLE = `
CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx ON public.password_reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS password_reset_tokens_token_idx ON public.password_reset_tokens (token);
`;

async function tableExists(tableName: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return result.rows.length > 0;
}

export async function ensurePasswordResetTable(): Promise<void> {
  // Skip when the table already exists: pg-mem cannot re-parse the
  // FK-annotated CREATE TABLE over an existing table (AST coverage limit).
  if (await tableExists("password_reset_tokens")) return;
  await query(CREATE_PASSWORD_RESET_TABLE);
}

export async function createPasswordResetToken(userId: string): Promise<string> {
  await ensurePasswordResetTable();
  
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  
  await query(
    `INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );
  
  return token;
}

export async function validatePasswordResetToken(token: string): Promise<PasswordResetToken | null> {
  await ensurePasswordResetTable();
  
  const result = await query<PasswordResetToken>(
    `SELECT * FROM password_reset_tokens WHERE token = $1 AND used = FALSE AND expires_at > NOW()`,
    [token]
  );
  
  return result.rows[0] || null;
}

export async function markPasswordResetTokenUsed(tokenId: string): Promise<void> {
  await query(
    `UPDATE password_reset_tokens SET used = TRUE WHERE id = $1`,
    [tokenId]
  );
}

export async function resetPassword(token: string, newPassword: string): Promise<{ error?: string }> {
  const resetToken = await validatePasswordResetToken(token);
  if (!resetToken) {
    return { error: "Invalid or expired reset token" };
  }
  
  const strength = validatePasswordStrength(newPassword);
  if (!strength.isStrong) {
    return { error: `Password too weak: ${strength.feedback.join(", ")}` };
  }
  
  const passwordHash = await hashPassword(newPassword);
  
  await transaction(async (client) => {
    await client.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [passwordHash, resetToken.user_id]
    );
    await client.query(
      `UPDATE password_reset_tokens SET used = TRUE WHERE id = $1`,
      [resetToken.id]
    );
  });
  
  return {};
}

// Email verification tokens
export interface EmailVerificationToken {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  used: boolean;
}

export const CREATE_EMAIL_VERIFICATION_TABLE = `
CREATE TABLE IF NOT EXISTS public.email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_verification_tokens_user_id_idx ON public.email_verification_tokens (user_id);
CREATE INDEX IF NOT EXISTS email_verification_tokens_token_idx ON public.email_verification_tokens (token);
`;

export async function ensureEmailVerificationTable(): Promise<void> {
  // Skip when the table already exists (see ensurePasswordResetTable note).
  if (await tableExists("email_verification_tokens")) return;
  await query(CREATE_EMAIL_VERIFICATION_TABLE);
}

export async function createEmailVerificationToken(userId: string): Promise<string> {
  await ensureEmailVerificationTable();
  
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  
  await query(
    `INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );
  
  return token;
}

export async function validateEmailVerificationToken(token: string): Promise<EmailVerificationToken | null> {
  await ensureEmailVerificationTable();
  
  const result = await query<EmailVerificationToken>(
    `SELECT * FROM email_verification_tokens WHERE token = $1 AND used = FALSE AND expires_at > NOW()`,
    [token]
  );
  
  return result.rows[0] || null;
}

export async function markEmailVerificationTokenUsed(tokenId: string): Promise<void> {
  await query(
    `UPDATE email_verification_tokens SET used = TRUE WHERE id = $1`,
    [tokenId]
  );
}

export async function verifyEmail(token: string): Promise<{ error?: string }> {
  const verifyToken = await validateEmailVerificationToken(token);
  if (!verifyToken) {
    return { error: "Invalid or expired verification token" };
  }
  
  await transaction(async (client) => {
    await client.query(
      `UPDATE profiles SET status = 'active' WHERE user_id = $1`,
      [verifyToken.user_id]
    );
    await client.query(
      `UPDATE email_verification_tokens SET used = TRUE WHERE id = $1`,
      [verifyToken.id]
    );
  });
  
  return {};
}

export async function sendVerificationEmail(email: string, token: string): Promise<void> {
  // TODO: Integrate with email service (SendGrid, Resend, etc.)
  // For now, log the verification link
  const verifyUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/verify-email?token=${token}`;
  console.log(`[EMAIL] Verification email sent to ${email}: ${verifyUrl}`);
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  // TODO: Integrate with email service
  const resetUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/reset-password?token=${token}`;
  console.log(`[EMAIL] Password reset email sent to ${email}: ${resetUrl}`);
}

export async function updateProfile(userId: string, updates: { displayName?: string; password?: string }): Promise<{ profile?: DbProfile; error?: string }> {
  if (updates.displayName !== undefined) {
    if (updates.displayName.length < 2 || updates.displayName.length > 100) {
      return { error: "Display name must be between 2 and 100 characters" };
    }
  }
  
  if (updates.password !== undefined) {
    const strength = validatePasswordStrength(updates.password);
    if (!strength.isStrong) {
      return { error: `Password too weak: ${strength.feedback.join(", ")}` };
    }
  }
  
  try {
    if (updates.password !== undefined) {
      const passwordHash = await hashPassword(updates.password);
      await query(
        `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
        [passwordHash, userId]
      );
    }
    
    if (updates.displayName !== undefined) {
      await query(
        `UPDATE profiles SET display_name = $1, updated_at = NOW() WHERE user_id = $2`,
        [updates.displayName, userId]
      );
    }
    
    const profileResult = await query<DbProfile>(
      'SELECT * FROM profiles WHERE user_id = $1',
      [userId]
    );
    
    return { profile: profileResult.rows[0] };
  } catch (err) {
    console.error("Update profile error:", err);
    return { error: "Failed to update profile" };
  }
}