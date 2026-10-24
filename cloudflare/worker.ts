import {handleOperatorPasswordReset} from '../server/operator-password-reset.js';
import {handleReadOnlyOperatorMaintenance} from '../server/operator-maintenance.js';
import {resetLoginLimitOnce} from '../server/login-reset.js';
import type {
  DurableObjectState,
  DurableObjectNamespace,
} from "@cloudflare/workers-types";
import { timingSafeEqual } from "node:crypto";
import { ReceptionStore } from "../server/store-core.js";
import { ApiError, digest, fail, secret } from "../server/security.js";
import {
  createHandler,
  type AppConfig,
  type LoginAttempts,
} from "../server/app.js";
import { importOwnedSnapshot } from "../server/migration.js";
import { deliverOutbox } from "../server/integrations.js";
import { DurableSqlDriver } from "./sql-driver.js";
import { handleFetch } from "./fetch-bridge.js";

export interface CloudEnv {
  QR_DB: DurableObjectNamespace;
  ASSETS: { fetch(request: Request): Promise<Response> };
  QR_SIGNING_KEY?: string;
  QR_SETUP_TOKEN?: string;
  QR_LOGIN_RESET_REVISION?: string;
  QR_OPERATOR_RESET_PLAN?: string;
  QR_MAINTENANCE_TOKEN?: string;
  QR_MAINTENANCE_EXPIRES_AT?: string;
  QR_ORIGIN?: string;
  QR_FORM_SECRET?: string;
  LINE_CHANNEL_ID?: string;
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  ANALYTICS_OPERATOR_ORIGIN?: string;
  ANALYTICS_OPERATOR_PASSWORD?: string;
  ANALYTICS_SNAPSHOT_URL?: string;
  ANALYTICS_CHECKIN_URL?: string;
  ANALYTICS_API_TOKEN?: string;
  PASS_VERIFY_URL?: string;
  PASS_API_TOKEN?: string;
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
async function migrationBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) fail("invalid_migration");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 5 * 1024 * 1024) fail("migration_too_large", 413);
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      fail("invalid_migration");
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export class QRReception {
  private db!: ReceptionStore;
  private attempts!: LoginAttempts;
  private initialized = false;
  constructor(
    private ctx: DurableObjectState,
    private env: CloudEnv,
  ) {}
  private initialize() {
    if(this.initialized)return;
    this.db = new ReceptionStore(new DurableSqlDriver(this.ctx.storage));
    this.db.run("UPDATE line_webhooks SET status='failed',error_code='processing_interrupted' WHERE status='processing'");
    this.db.sql.exec(
      "CREATE TABLE IF NOT EXISTS _qr_login_attempts(ip TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL)",
    );
    this.db.sql.exec(
      "CREATE INDEX IF NOT EXISTS _qr_login_expiry ON _qr_login_attempts(expires)",
    );
    resetLoginLimitOnce(this.db,this.env.QR_LOGIN_RESET_REVISION);
    this.attempts = {
      get: (ip) =>
        this.db.row(
          "SELECT count,expires FROM _qr_login_attempts WHERE ip=?",
          ip,
        ),
      set: (ip, value) => {
        this.db.run(
          "INSERT INTO _qr_login_attempts VALUES(?,?,?) ON CONFLICT(ip) DO UPDATE SET count=excluded.count,expires=excluded.expires",
          ip,
          value.count,
          value.expires,
        );
      },
      delete: (ip) => {
        this.db.run("DELETE FROM _qr_login_attempts WHERE ip=?", ip);
      },
      clearExpired: (time) => {
        this.db.run("DELETE FROM _qr_login_attempts WHERE expires<=?", time);
      },
    };
    this.initialized = true;
  }
  private config(origin: string): AppConfig {
    const url = new URL(this.env.QR_ORIGIN || origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      fail("configuration_unavailable", 503);
    return {
      origin: url.origin,
      signingKey: secret(this.env.QR_SIGNING_KEY),
      root: "",
      formSecret: this.env.QR_FORM_SECRET,
      lineSchedule: (work) => this.ctx.waitUntil(work),
      lineChannelId: this.env.LINE_CHANNEL_ID,
      lineChannelSecret: this.env.LINE_CHANNEL_SECRET,
      lineAccessToken: this.env.LINE_CHANNEL_ACCESS_TOKEN,
      analyticsOperatorOrigin: this.env.ANALYTICS_OPERATOR_ORIGIN,
      analyticsOperatorPassword: this.env.ANALYTICS_OPERATOR_PASSWORD,
      pollIntervalMs: 30000,
      analyticsSnapshotUrl: this.env.ANALYTICS_SNAPSHOT_URL,
      analyticsDeliveryUrl: this.env.ANALYTICS_CHECKIN_URL,
      analyticsToken: this.env.ANALYTICS_API_TOKEN,
      passVerifyUrl: this.env.PASS_VERIFY_URL,
      passToken: this.env.PASS_API_TOKEN,
    };
  }
  async fetch(request: Request) {
    try {
      const url = new URL(request.url);
      if(url.pathname==="/api/v2/maintenance/reset-operator")return handleOperatorPasswordReset(request,this.ctx.storage,this.env.QR_MAINTENANCE_TOKEN,this.env.QR_MAINTENANCE_EXPIRES_AT,this.env.QR_OPERATOR_RESET_PLAN);
      if(url.pathname.startsWith("/api/v2/maintenance/"))return handleReadOnlyOperatorMaintenance(request,this.ctx.storage.sql,this.env.QR_MAINTENANCE_TOKEN,this.env.QR_MAINTENANCE_EXPIRES_AT);
      this.initialize();
      const cfg = this.config(url.origin);
      if (url.pathname === "/api/v2/setup" && request.method === "POST") {
        const provided = request.headers.get("authorization") || "";
        if (
          !this.env.QR_SETUP_TOKEN ||
          provided.length > 512 ||
          !timingSafeEqual(
            Buffer.from(digest(provided)),
            Buffer.from(digest("Bearer " + this.env.QR_SETUP_TOKEN)),
          )
        )
          fail("unauthorized", 401);
        return json(importOwnedSnapshot(this.db, await migrationBody(request)));
      }
      const response = await handleFetch(
        request,
        createHandler(this.db, cfg, this.attempts),
      );
      if (
        cfg.analyticsDeliveryUrl &&
        cfg.analyticsToken &&
        this.db.outbox().some((item) => item.status !== "sent") &&
        (await this.ctx.storage.getAlarm()) === null
      )
        await this.ctx.storage.setAlarm(Date.now() + 60000);
      return response;
    } catch (error) {
      return json(
        {
          error: error instanceof ApiError ? error.message : "operation_failed",
        },
        error instanceof ApiError ? error.status : 500,
      );
    }
  }
  async alarm() {
    this.initialize();
    if (!this.env.ANALYTICS_CHECKIN_URL || !this.env.ANALYTICS_API_TOKEN)
      return;
    await deliverOutbox(this.db, {
      analyticsDeliveryUrl: this.env.ANALYTICS_CHECKIN_URL,
      analyticsToken: this.env.ANALYTICS_API_TOKEN,
    });
    const next = this.db.row(
      "SELECT MIN(next_attempt) next FROM outbox WHERE status!='sent'",
    ).next;
    if (next !== null)
      await this.ctx.storage.setAlarm(
        Math.max(Date.now() + 60000, Number(next)),
      );
  }
}

export default {
  async fetch(request: Request, env: CloudEnv) {
    try {
      if (!new URL(request.url).pathname.startsWith("/api/"))
        return env.ASSETS.fetch(request);
      const headers = new Headers(request.headers);
      // The edge supplies CF-Connecting-IP; never trust an incoming custom header.
      headers.set(
        "x-unity-client-ip",
        request.headers.get("cf-connecting-ip") || "unknown",
      );
      const stub = env.QR_DB.get(env.QR_DB.idFromName("unity-qr-v2"));
      return (await stub.fetch(
        new Request(request, { headers }) as any,
      )) as unknown as Response;
    } catch {
      return json({ error: "service_unavailable" }, 503);
    }
  },
};
