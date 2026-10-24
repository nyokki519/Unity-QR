import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.js";
import {
  fetchAnalyticsOperatorEvents,
  importAnalyticsOperatorEvents,
} from "../server/analytics-events.js";
const admin = { id: "admin", role: "Admin", events: [] } as const;
const event = {
  id: "12345678-1234-1234-1234-123456789abc",
  title: "Analytics Night",
  starts_at: "2026-10-20T10:00:00Z",
  checkin_enabled: true,
  checkin_opens_at: "2026-10-20T09:00:00Z",
  checkin_closes_at: "2026-10-20T15:00:00Z",
};
test("actual operator cookie login and bounded read-only event endpoint", async () => {
  const calls: any[] = [];
  const fetcher = (async (url: any, init: any) => {
    calls.push({ url, init });
    return calls.length === 1
      ? new Response('{"ok":true}', {
          headers: {
            "set-cookie":
              "unity_operator_session=test-session; Path=/; HttpOnly",
          },
        })
      : Response.json({ events: [event] });
  }) as typeof fetch;
  assert.equal(
    (
      await fetchAnalyticsOperatorEvents(
        {
          origin: "https://analytics.example",
          operatorPassword: "test-only-password",
        },
        fetcher,
      )
    ).length,
    1,
  );
  assert.equal(calls[0].url, "https://analytics.example/api/operator/login");
  assert.equal(calls[0].init.headers.Origin, "https://analytics.example");
  assert.equal(
    calls[1].init.headers.Cookie,
    "unity_operator_session=test-session",
  );
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[1].init.redirect, "manual");
});
test("missing auth, redirects and oversized/invalid events fail closed", async () => {
  await assert.rejects(
    fetchAnalyticsOperatorEvents({
      origin: "http://example.com",
      operatorPassword: "test-only-password",
    }),
  );
  await assert.rejects(
    fetchAnalyticsOperatorEvents({
      origin: "https://example.com",
      operatorPassword: "",
    }),
  );
  const fetcher = (async () => new Response('{"ok":true}')) as typeof fetch;
  await assert.rejects(
    fetchAnalyticsOperatorEvents(
      { origin: "https://example.com", operatorPassword: "test-only-password" },
      fetcher,
    ),
  );
  const oversized = (async () =>
    new Response("x".repeat(256 * 1024 + 1), {
      headers: { "set-cookie": "unity_operator_session=test-session; Path=/" },
    })) as typeof fetch;
  await assert.rejects(
    fetchAnalyticsOperatorEvents(
      { origin: "https://example.com", operatorPassword: "test-only-password" },
      oversized,
    ),
  );
  const redirect = (async () =>
    new Response(null, {
      status: 302,
      headers: { Location: "https://attacker.example" },
    })) as typeof fetch;
  await assert.rejects(
    fetchAnalyticsOperatorEvents(
      { origin: "https://example.com", operatorPassword: "test-only-password" },
      redirect,
    ),
  );
  const db = new Store(":memory:");
  assert.throws(() =>
    importAnalyticsOperatorEvents(
      db,
      admin,
      [{ ...event, checkin_enabled: "true" }],
      { venue: "Tokyo", capacity: 50 },
    ),
  );
  assert.equal(db.events(admin).length, 0);
  db.close();
});
test("stable Analytics IDs deduplicate; disabled events skipped; local edits preserved", () => {
  const db = new Store(":memory:");
  const result = importAnalyticsOperatorEvents(
    db,
    admin,
    [
      event,
      {
        ...event,
        id: "22345678-1234-1234-1234-123456789abc",
        checkin_enabled: false,
      },
    ],
    { venue: "Tokyo", capacity: 50 },
  );
  assert.equal(result.skipped, 1);
  const id = db.events(admin)[0].id;
  db.run("UPDATE events SET title='Locally edited' WHERE id=?", id);
  importAnalyticsOperatorEvents(db, admin, [event], {
    venue: "Tokyo",
    capacity: 50,
  });
  assert.equal(db.events(admin).length, 1);
  assert.equal(db.events(admin)[0].title, "Locally edited");
  assert.throws(() =>
    importAnalyticsOperatorEvents(
      db,
      { id: "staff", role: "Staff", events: [] },
      [event],
      { venue: "Tokyo", capacity: 50 },
    ),
  );
  db.close();
});
