import type { ReceptionStore, Actor } from "./store-core.js";
import { importSnapshot } from "./integrations.js";
import { fail } from "./security.js";

export type AnalyticsOperatorConfig = {
  origin?: string;
  operatorPassword?: string;
};
export type AnalyticsOperatorEvent = {
  id: string;
  title: string;
  starts_at: string;
  checkin_enabled: boolean;
  checkin_opens_at: string | null;
  checkin_closes_at: string | null;
};
async function boundedJSON(response: Response) {
  if (!response.ok || !response.body) fail("analytics_operator_failed", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 256 * 1024) {
      await reader.cancel();
      fail("analytics_operator_failed", 502);
    }
    chunks.push(part.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    fail("analytics_operator_failed", 502);
  }
}
export async function fetchAnalyticsOperatorEvents(
  cfg: AnalyticsOperatorConfig,
  fetcher: typeof fetch = fetch,
): Promise<AnalyticsOperatorEvent[]> {
  if (
    !cfg.origin ||
    !cfg.operatorPassword ||
    cfg.operatorPassword.length < 16 ||
    cfg.operatorPassword.length > 256
  )
    fail("analytics_operator_disconnected", 503);
  let origin: URL;
  try {
    origin = new URL(cfg.origin);
  } catch {
    fail("integration_configuration", 503);
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    fail("integration_configuration", 503);
  try {
    const login = await fetcher(origin.origin + "/api/operator/login", {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { Origin: origin.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: cfg.operatorPassword }),
    });
    const cookie = login.headers
      .get("set-cookie")
      ?.match(
        /(?:^|,\s*)unity_operator_session=([A-Za-z0-9_-]{1,4096})(?:;|$)/,
      )?.[1];
    await boundedJSON(login);
    if (!cookie) fail("analytics_operator_failed", 502);
    const response = await fetcher(origin.origin + "/api/operator/events", {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Cookie: `unity_operator_session=${cookie}`,
        Accept: "application/json",
      },
    });
    return validateEvents((await boundedJSON(response)).events);
  } catch {
    fail("analytics_operator_failed", 502);
  }
}
function validateEvents(input: unknown): AnalyticsOperatorEvent[] {
  if (!Array.isArray(input) || input.length > 100)
    fail("invalid_analytics_events");
  const seen = new Set<string>();
  for (const e of input) {
    if (
      !e ||
      typeof e !== "object" ||
      typeof e.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        e.id,
      ) ||
      seen.has(e.id) ||
      typeof e.title !== "string" ||
      !e.title.trim() ||
      e.title.length > 120 ||
      typeof e.starts_at !== "string" ||
      !Number.isFinite(Date.parse(e.starts_at)) ||
      typeof e.checkin_enabled !== "boolean" ||
      ![e.checkin_opens_at, e.checkin_closes_at].every(
        (v) =>
          v === null ||
          (typeof v === "string" && Number.isFinite(Date.parse(v))),
      )
    )
      fail("invalid_analytics_events");
    seen.add(e.id);
  }
  return input;
}
export function importAnalyticsOperatorEvents(
  db: ReceptionStore,
  actor: Actor,
  input: unknown,
  defaults: { venue: string; capacity: number },
  preview = false,
) {
  db.admin(actor);
  const rows = validateEvents(input);
  const available = rows.filter(
    (e) => e.checkin_enabled && e.checkin_opens_at && e.checkin_closes_at,
  );
  const result = importSnapshot(
    db,
    actor,
    {
      version: 1,
      events: available.map((e) => ({
        externalId: e.id,
        title: e.title,
        startsAt: e.starts_at,
        opensAt: e.checkin_opens_at,
        closesAt: e.checkin_closes_at,
        venue: defaults.venue,
        capacity: defaults.capacity,
      })),
      participants: [],
      registrations: [],
    },
    preview,
  );
  return { ...result, skipped: rows.length - available.length };
}
