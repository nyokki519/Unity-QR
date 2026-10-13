import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import type { ReceptionStore as Store, Actor } from "./store-core.js";
import { exportSnapshot } from "./migration.js";
import {
  ApiError,
  fail,
  signTicket,
  verifyTicket,
  hashPassword,
  text,
  digest,
  keyedDigest,
} from "./security.js";
import {
  deliverOutbox,
  fetchSnapshot,
  importSnapshot,
  verifyPass,
  type IntegrationConfig,
} from "./integrations.js";

import { FormClaims, verifyFormAuth } from "./form-claims.js";
import { LineService, type LineConfig } from "./line.js";
import {
  fetchAnalyticsOperatorEvents,
  importAnalyticsOperatorEvents,
} from "./analytics-events.js";
export type AppConfig = IntegrationConfig &
  Partial<LineConfig> & {
    formSecret?: string;
    analyticsOperatorOrigin?: string;
    analyticsOperatorPassword?: string;
    origin: string;
    signingKey: string;
    root: string;
    pollIntervalMs?: number;
  };
const cookieName = "unity_qr_session";
function cookie(request: IncomingMessage) {
  return (
    request.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1) || ""
  );
}
async function body(request: IncomingMessage, maxBytes = 1024 * 1024) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) fail("request_too_large", 413);
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString());
    if (!result || typeof result !== "object" || Array.isArray(result))
      fail("invalid_request");
    return result;
  } catch {
    fail("invalid_request");
  }
}
function headers(res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=()");
  res.setHeader("X-Frame-Options", "DENY");
}
function json(res: ServerResponse, data: any, status = 200) {
  res
    .writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
    .end(JSON.stringify(data));
}
export function createApp(db: Store, cfg: AppConfig) {
  return createServer(createHandler(db, cfg));
}
export type LoginAttempts = {
  get(ip: string): { count: number; expires: number } | undefined;
  set(ip: string, value: { count: number; expires: number }): void;
  delete(ip: string): void;
  clearExpired(time: number): void;
};
export function createHandler(
  db: Store,
  cfg: AppConfig,
  persistedAttempts?: LoginAttempts,
) {
  const memory = new Map<string, { count: number; expires: number }>();
  const attempts: LoginAttempts = persistedAttempts || {
    get: (ip) => memory.get(ip),
    set: (ip, value) => {
      memory.set(ip, value);
    },
    delete: (ip) => {
      memory.delete(ip);
    },
    clearExpired: (time) => {
      for (const [ip, value] of memory)
        if (value.expires <= time) memory.delete(ip);
    },
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
    headers(res);
    try {
      const path = new URL(req.url || "/", cfg.origin),
        method = req.method || "GET";
      const line = new LineService(db, cfg);
      const forms = new FormClaims(db);
      if (path.pathname === "/api/v2/form/config") {
        if (method === "GET") {
          if (req.headers.origin === "https://nyokki519.github.io") {
            res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
            res.setHeader("Vary", "Origin");
          }
          return json(
            res,
            cfg.formSecret
              ? forms.publicConfig()
              : { version: 1, enabled: false, entry: null },
          );
        }
        if (method === "POST") {
          verifyFormAuth(req.headers.authorization, cfg.formSecret);
          return json(res, forms.configure(await body(req, 16384)));
        }
      }
      if (path.pathname === "/api/v2/form/accepted" && method === "POST") {
        verifyFormAuth(req.headers.authorization, cfg.formSecret);
        if (!forms.publicConfig().enabled) fail("form_disabled", 403);
        return json(res, forms.accept(await body(req, 16384)));
      }

      if (path.pathname === "/api/v2/line/webhook" && method === "POST") {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 256 * 1024) fail("request_too_large", 413);
          chunks.push(chunk);
        }
        return json(
          res,
          await line.webhook(
            Buffer.concat(chunks),
            req.headers["x-line-signature"],
          ),
        );
      }
      if (path.pathname === "/api/v2/line/ticket" && method === "GET") {
        const auth = req.headers.authorization || "";
        if (!/^Bearer [a-f0-9]{64}$/.test(auth)) fail("ticket_not_found", 404);
        return json(res, await line.publicTicket(auth.slice(7)));
      }
      if (path.pathname === "/api/v2/health")
        return json(res, { service: "unity-qr", version: 2 });
      if (path.pathname.startsWith("/api/")) {
        if (!path.pathname.startsWith("/api/v2/")) fail("not_found", 404);
        if (method !== "GET" && req.headers.origin !== cfg.origin)
          fail("forbidden", 403);
        const token = cookie(req);
        const session = db.session(token);
        const setCookie = (value: string, age: number) =>
          res.setHeader(
            "Set-Cookie",
            `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${cfg.origin.startsWith("https:") ? "; Secure" : ""}`,
          );
        if (path.pathname === "/api/v2/login" && method === "POST") {
          const ip = req.socket.remoteAddress || "unknown";
          const time = Date.now();
          attempts.clearExpired(time);
          const current = attempts.get(ip) || {
            count: 0,
            expires: time + 15 * 60000,
          };
          if (current.count >= 10) {
            res.setHeader("Retry-After", "900");
            fail("too_many_attempts", 429);
          }
          current.count++;
          attempts.set(ip, current);
          const input = await body(req);
          if (
            typeof input.username !== "string" ||
            typeof input.password !== "string"
          )
            fail("invalid_request");
          const login = db.login(input.username, input.password);
          attempts.delete(ip);
          setCookie(login, 8 * 3600);
          return json(res, { ok: true });
        }
        if (!session) fail("unauthorized", 401);
        const actor = session as Actor;
        const eventId = path.searchParams.get("event") || "";
        const key = String(req.headers["idempotency-key"] || "");
        if (path.pathname === "/api/v2/session" && method === "GET")
          return json(res, {
            role: actor.role,
            events: actor.events,
            features: {sheetReception:1,similarEventAliases:1},
            ...(cfg.pollIntervalMs
              ? { pollIntervalMs: cfg.pollIntervalMs }
              : {}),
          });
        if (path.pathname === "/api/v2/logout" && method === "POST") {
          db.logout(token);
          setCookie("", 0);
          return json(res, { ok: true });
        }
        if (path.pathname === "/api/v2/events") {
          if (method === "GET") return json(res, { events: db.events(actor) });
          if (method === "POST")
            return json(res, db.createEvent(actor, await body(req), key), 201);
          if (method === "PATCH") {
            const input = await body(req);
            return json(res, db.updateEvent(actor, input.eventId, input, key));
          }
        }
        if (path.pathname === "/api/v2/participants") {
          if (method === "GET")
            return json(res, {
              participants: db.participants(actor, eventId, {
                search: path.searchParams.get("search"),
                status: path.searchParams.get("status"),
                sort: path.searchParams.get("sort"),
              }),
              summary: db.summary(actor, eventId),
            });
          if (method === "POST") {
            const input = await body(req);
            return json(
              res,
              db.register(actor, input.eventId, input, key),
              201,
            );
          }
          if (method === "PATCH") {
            const input = await body(req);
            return json(
              res,
              db.rename(
                actor,
                input.eventId,
                input.participantId,
                input.name,
                input.reason,
                key,
              ),
            );
          }
        }
        if (path.pathname === '/api/v2/participant-link' && method === 'POST') {
          const input=await body(req);
          return json(res,line.issueParticipantLink(actor,input.eventId,input.participantId,key));
        }
        if (path.pathname === "/api/v2/ticket" && method === "GET") {
          const person = db.person(
            actor,
            eventId,
            path.searchParams.get("participant") || "",
            true,
          );
          const event = db.event(actor, eventId);
          if (person.status === "cancelled")
            fail("registration_cancelled", 409);
          const expiry = Math.min(
            Date.now() + 6 * 3600_000,
            Date.parse(event.closesAt),
          );
          if (expiry <= Date.now()) fail("event_closed", 410);
          const ticket = signTicket(cfg.signingKey, eventId, person.id, expiry);
          if (path.searchParams.get("format") === "svg") {
            res.setHeader("Content-Type", "image/svg+xml");
            return res.end(
              await QRCode.toString(ticket, {
                type: "svg",
                margin: 3,
                width: 320,
                errorCorrectionLevel: "M",
              }),
            );
          }
          return json(res, { token: ticket, expiresAt: expiry });
        }
        if (path.pathname === "/api/v2/checkins" && method === "POST") {
          const input = await body(req);
          db.event(actor, input.eventId, true);
          const fingerprint = digest(
            JSON.stringify([
              "checkin-request",
              input.eventId,
              input.participantId ?? null,
              input.ticket ?? null,
            ]),
          );
          const prior = db.cached(actor, key, fingerprint);
          if (prior !== undefined) return json(res, prior);
          let participantId = input.participantId;
          let source = "manual";
          if (input.ticket !== undefined) {
            if (typeof input.ticket !== "string") fail("invalid_qr");
            if (input.ticket.startsWith("pass:")) {
              const member = await verifyPass(
                cfg,
                input.ticket.slice(5),
                input.eventId,
              );
              participantId = db.row(
                "SELECT id FROM participants WHERE member_id=?",
                member.memberId,
              )?.id;
              source = "pass";
            } else {
              participantId = verifyTicket(
                cfg.signingKey,
                input.ticket,
                input.eventId,
              ).participantId;
              source = "qr";
            }
          }
          if (typeof participantId !== "string" || !participantId)
            fail("participant_not_found", 404);
          return json(
            res,
            db.checkin(
              actor,
              input.eventId,
              participantId,
              key,
              source,
              fingerprint,
            ),
          );
        }
        if (
          ["/api/v2/undo", "/api/v2/cancel", "/api/v2/restore"].includes(
            path.pathname,
          ) &&
          method === "POST"
        ) {
          const input = await body(req);
          const method = path.pathname.split("/").pop() as
            | "undo"
            | "cancel"
            | "restore";
          return json(
            res,
            db[method](
              actor,
              input.eventId,
              input.participantId,
              input.reason,
              key,
            ),
          );
        }
        if (path.pathname === "/api/v2/history" && method === "GET")
          return json(res, { history: db.history(actor, eventId) });
        if (path.pathname === "/api/v2/backup" && method === "GET") {
          db.admin(actor);
          db.audit(actor, "cloud_backup", null, null);
          res.setHeader(
            "Content-Disposition",
            'attachment; filename="unity-qr-backup.json"',
          );
          return json(res, exportSnapshot(db));
        }
        if (path.pathname === "/api/v2/settings" && method === "GET") {
          db.admin(actor);
          return json(res, {
            version: 3,
            line: line.settings(actor),
            forms: { ...forms.settings(actor), configured: !!cfg.formSecret },
            analyticsEventsConnected: !!(
              cfg.analyticsOperatorOrigin && cfg.analyticsOperatorPassword
            ),
            passConnected: !!(cfg.passVerifyUrl && cfg.passToken),
            analyticsImportConnected: !!(
              cfg.analyticsSnapshotUrl && cfg.analyticsToken
            ),
            analyticsDeliveryConnected: !!(
              cfg.analyticsDeliveryUrl && cfg.analyticsToken
            ),
            sync: db.syncHistory(actor),
            users: db
              .rows("SELECT id,username,role,enabled FROM users")
              .map((u) => ({
                ...u,
                eventIds: db
                  .rows(
                    "SELECT event_id FROM user_events WHERE user_id=?",
                    u.id,
                  )
                  .map((e) => e.event_id),
              })),
          });
        }
        if (path.pathname === "/api/v2/form/disable" && method === "POST") {
          db.admin(actor);
          await body(req);
          const current = forms.publicConfig();
          if (!current.entry) fail("form_unavailable", 503);
          const result = forms.configure({
            entry: current.entry,
            enabled: false,
          });
          db.audit(actor, "form_disable", null, null);
          return json(res, result);
        }
        if (path.pathname === "/api/v2/form/map" && method === "POST") {
          db.admin(actor);
          return json(res, forms.map(actor, await body(req), key));
        }
        if (path.pathname === "/api/v2/line/events" && method === "POST") {
          db.admin(actor);
          return json(res, line.configure(actor, await body(req), key));
        }
        if (path.pathname === "/api/v2/analytics-events" && method === "POST") {
          db.admin(actor);
          const input = await body(req);
          if (
            typeof input.venue !== "string" ||
            !Number.isInteger(input.capacity)
          )
            fail("analytics_defaults_required");
          const events =
            input.preview === false
              ? input.events
              : await fetchAnalyticsOperatorEvents({
                  origin: cfg.analyticsOperatorOrigin,
                  operatorPassword: cfg.analyticsOperatorPassword,
                });
          const result = importAnalyticsOperatorEvents(
            db,
            actor,
            events,
            { venue: input.venue, capacity: input.capacity },
            input.preview !== false,
          );
          return json(
            res,
            input.preview !== false
              ? { preview: result, snapshot: events }
              : result,
          );
        }
        if (path.pathname === "/api/v2/users" && method === "POST") {
          db.admin(actor);
          const input = await body(req);
          if (
            !Array.isArray(input.eventIds) ||
            input.eventIds.some((e: any) => typeof e !== "string") ||
            typeof input.password !== "string"
          )
            fail("invalid_request");
          return json(
            res,
            db.createUser(
              actor,
              input,
              key,
              keyedDigest(
                JSON.stringify(["user-create", input]),
                cfg.signingKey,
              ),
              () => hashPassword(input.password),
            ),
            201,
          );
        }
        if (path.pathname === "/api/v2/users" && method === "PATCH") {
          db.admin(actor);
          const input = await body(req);
          if (typeof input.userId !== "string" || input.userId === actor.id)
            fail("invalid_request");
          return json(
            res,
            db.mutate(actor, key, `disable:${input.userId}`, () => {
              db.run("UPDATE users SET enabled=0 WHERE id=?", input.userId);
              db.audit(actor, "user_disable", null, null);
              return { ok: true };
            }),
          );
        }
        if (path.pathname === "/api/v2/import" && method === "POST") {
          db.admin(actor);
          const input = await body(req);
          const snapshot = input.remote
            ? await fetchSnapshot(cfg)
            : input.snapshot;
          const result = importSnapshot(
            db,
            actor,
            snapshot,
            input.preview === true,
          );
          return json(res, {
            ...result,
            ...(input.remote && input.preview === true ? { snapshot } : {}),
          });
        }
        if (path.pathname === "/api/v2/sync" && method === "POST") {
          db.admin(actor);
          await body(req);
          db.run("UPDATE outbox SET next_attempt=0 WHERE status='failed'");
          return json(res, await deliverOutbox(db, cfg));
        }
        fail("not_found", 404);
      }
      if (method !== "GET" && method !== "HEAD") fail("not_found", 404);
      const allowed: Record<string, [string, string]> = {
        "/assets/unity-logo.webp": ["assets/unity-logo.webp", "image/webp"],
        "/": ["index.html", "text/html; charset=utf-8"],
        "/index.html": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
        "/ticket/": ["public/ticket.html", "text/html; charset=utf-8"],
        "/ticket/ticket.js": ["public/ticket.js", "text/javascript"],
        "/ticket/ticket.css": ["public/ticket.css", "text/css"],
        "/ops": ["ops/index.html", "text/html; charset=utf-8"],
        "/ops/": ["ops/index.html", "text/html; charset=utf-8"],
        "/ops/index.html": ["ops/index.html", "text/html; charset=utf-8"],
        "/ops/app.js": ["ops/app.js", "text/javascript"],
        "/ops/scanner.js": ["ops/scanner.js", "text/javascript"],
        "/ops/style.css": ["ops/style.css", "text/css"],
        "/ops/decoder.js": ["ops/decoder.js", "text/javascript"],
      };
      const file = allowed[path.pathname];
      if (!file) fail("not_found", 404);
      if (
        path.pathname.startsWith("/ops") ||
        path.pathname.startsWith("/ticket/")
      )
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        );
      const content = readFileSync(join(cfg.root, file[0]));
      res.setHeader("Content-Type", file[1]);
      res.writeHead(200).end(method === "HEAD" ? undefined : content);
    } catch (error) {
      json(
        res,
        {
          error: error instanceof ApiError ? error.message : "operation_failed",
        },
        error instanceof ApiError ? error.status : 500,
      );
    }
  };
}
