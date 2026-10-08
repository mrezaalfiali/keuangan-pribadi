type PostgrestError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

const AUTH_HINT = "sesi login tidak valid atau kedaluwarsa — coba login ulang.";
const GRANT_HINT = "role ini tidak punya izin pada tabel — cek grant.";
const SCHEMA_HINT = "skema database tidak cocok dengan kode — jalankan migrasi SQL terbaru.";

const CLASSIFICATION: Record<string, string> = {
  "401": AUTH_HINT,
  PGRST301: AUTH_HINT,
  PGRST302: AUTH_HINT,
  JWTExpired: AUTH_HINT,
  InvalidTokenError: AUTH_HINT,
  AuthSessionMissingError: AUTH_HINT,

  "42501": GRANT_HINT,
  "42P01": SCHEMA_HINT,
  "42P07": SCHEMA_HINT,
  "42703": SCHEMA_HINT,
  "42883": SCHEMA_HINT,
  "42P10": SCHEMA_HINT,
  PGRST200: SCHEMA_HINT,
  PGRST202: SCHEMA_HINT,
  PGRST205: SCHEMA_HINT,
};

/**
 * Turns a swallowed Supabase/PostgREST failure into something readable.
 *
 * The pages render one generic "cannot load data" message for every
 * failure mode, so without this the browser console was the only place
 * the real cause appeared — and nothing there said *why*.
 */
export function describeSupabaseError(
  label: string,
  error: unknown
): string {
  if (!error || typeof error !== "object") {
    return `[${label}] ${String(error)}`;
  }

  const { code, message, details, hint } = error as PostgrestError;
  const parts = [`[${label}]`];

  if (code) {
    parts.push(`${code}: ${CLASSIFICATION[code] ?? "kesalahan Supabase."}`);
  } else if (message && /failed to fetch|network/i.test(message)) {
    parts.push("koneksi ke Supabase gagal — cek jaringan atau CORS.");
  }

  if (message) parts.push(message);
  if (details) parts.push(`details: ${details}`);
  if (hint) parts.push(`hint: ${hint}`);

  return parts.join(" ");
}

export function logSupabaseError(label: string, error: unknown) {
  console.error(describeSupabaseError(label, error));
}
