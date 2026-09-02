// Quorima — retry-laag voor Twinfield-calls
//
// Twinfield stuurt bij overbelasting een HTTP 429 met een JSON-body en een
// `retry-after`-header. De SOAP-client verwacht XML, stikt in die JSON en gooit
// een Fault met faultstring "Invalid XML" — een melding die je volledig op het
// verkeerde spoor zet. Waargenomen 2 september 2026:
//
//   Fault: { faultcode: 500, faultstring: 'Invalid XML',
//            detail: 'Non-whitespace before first tag. Char: {' }
//   response: { status: 429, 'retry-after': '4',
//               'x-ratelimit-clientid-remaining': '23' }
//
// Deze module herkent dat geval, wacht de opgegeven tijd en probeert opnieuw.
// Lukt het daarna nog niet, dan is de foutmelding tenminste eerlijk over wat er
// aan de hand is.

export interface RateLimitInfo {
  /** Seconden die de server vraagt te wachten; null als de header ontbrak. */
  retryAfterSeconds: number | null;
  /** Resterend quotum volgens de x-ratelimit-headers, als Twinfield het meldt. */
  remaining: number | null;
}

/** Haalt een header op, ongeacht hoofdlettergebruik. */
function header(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === lower && (typeof v === "string" || typeof v === "number")) {
      return String(v);
    }
  }
  return undefined;
}

/**
 * Herkent een rate-limit-fout, hoe hij ook verpakt is.
 *
 * De soap-library hangt de axios-response aan de error; afhankelijk van waar het
 * misgaat zit de status op `err.response.status` of op `err.Fault.statusCode`.
 * We kijken naar allebei en vallen terug op de tekst, want een "Invalid XML" met
 * een JSON-body is in de praktijk altijd dit geval.
 */
export function rateLimitInfo(err: unknown): RateLimitInfo | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, any>;

  const status = e.response?.status ?? e.status ?? e.Fault?.statusCode;
  const headers = e.response?.headers;

  const looksLikeJsonBody =
    typeof e.Fault?.detail === "string" && e.Fault.detail.includes("Char: {");
  const isRateLimited = status === 429 || (looksLikeJsonBody && header(headers, "retry-after") != null);

  if (!isRateLimited) return null;

  const retryAfterRaw = header(headers, "retry-after");
  const retryAfter = retryAfterRaw == null ? null : Number(retryAfterRaw);
  const remainingRaw =
    header(headers, "x-ratelimit-clientid-remaining") ??
    header(headers, "x-ratelimit-remaining");

  return {
    retryAfterSeconds:
      retryAfter != null && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null,
    remaining: remainingRaw == null || !Number.isFinite(Number(remainingRaw))
      ? null
      : Number(remainingRaw),
  };
}

/**
 * Wachttijd voor poging `attempt` (1-based).
 *
 * De server weet het beter dan wij: `retry-after` wint altijd. Ontbreekt hij,
 * dan exponentieel vanaf 2s met een plafond, zodat een cron-run niet minuten
 * blijft hangen.
 */
export function backoffMs(attempt: number, info: RateLimitInfo | null, capMs = 30_000): number {
  if (info?.retryAfterSeconds != null) {
    return Math.min(info.retryAfterSeconds * 1000, capMs);
  }
  return Math.min(2 ** attempt * 1000, capMs);
}

/** Leesbare samenvatting voor de logregel en de uiteindelijke foutmelding. */
export function describeRateLimit(info: RateLimitInfo): string {
  const parts = ["Twinfield rate limit (HTTP 429)"];
  if (info.retryAfterSeconds != null) parts.push(`retry-after ${info.retryAfterSeconds}s`);
  if (info.remaining != null) parts.push(`${info.remaining} calls over`);
  return parts.join(" · ");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Voert `fn` uit en probeert opnieuw zolang Twinfield rate-limit teruggeeft.
 *
 * Alleen 429 wordt herhaald. Elke andere fout gaat direct door: een verkeerde
 * query of een verlopen token wordt niet beter van wachten.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    onRetry?: (msg: string) => void;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const wait = opts.sleepFn ?? sleep;

  let lastInfo: RateLimitInfo | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const info = rateLimitInfo(err);
      if (!info) throw err;
      lastInfo = info;
      if (attempt === maxAttempts) break;
      const ms = backoffMs(attempt, info);
      opts.onRetry?.(
        `${describeRateLimit(info)} — poging ${attempt}/${maxAttempts}, wacht ${Math.round(ms / 1000)}s`,
      );
      await wait(ms);
    }
  }

  throw new Error(
    `${describeRateLimit(lastInfo!)} — nog steeds geblokkeerd na ${maxAttempts} pogingen. ` +
      `Draaien er meer Twinfield-jobs tegelijk? (De SOAP-laag meldt dit zelf als "Invalid XML".)`,
  );
}
