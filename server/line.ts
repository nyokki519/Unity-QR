import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import QRCode from "qrcode";
import { FormClaims } from "./form-claims.js";
import type { Actor, ReceptionStore } from "./store-core.js";
import {
  ApiError,
  digest,
  fail,
  keyedDigest,
  signTicket,
  text,
} from "./security.js";
export type LineConfig = {
  origin: string;
  signingKey: string;
  lineChannelId?: string;
  lineChannelSecret?: string;
  lineAccessToken?: string;
  lineSchedule?: (work: Promise<void>) => void;
};
type Message = { type: "text"; text: string; quickReply?: { items: any[] } };
export function verifyLineSignature(
  raw: Buffer,
  signature: unknown,
  secret: string | undefined,
) {
  if (!secret) fail("line_unavailable", 503);
  if (typeof signature !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(signature))
    fail("invalid_line_signature", 401);
  const expected = createHmac("sha256", secret).update(raw).digest();
  const actual = Buffer.from(signature, "base64");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    fail("invalid_line_signature", 401);
}
const reply = (value: string): Message[] => [{ type: "text", text: value }];
const system: Actor = { id: "system:line", role: "Admin", events: [] };
export class LineService {
  constructor(
    private db: ReceptionStore,
    private cfg: LineConfig,
  ) {}
  private subject(user: string) {
    if (!this.cfg.lineChannelId || !/^\d{5,20}$/.test(this.cfg.lineChannelId))
      fail("line_unavailable", 503);
    if (!/^U[a-f0-9]{32}$/.test(user)) fail("invalid_line_user");
    return keyedDigest(
      this.cfg.lineChannelId + ":" + user,
      this.cfg.signingKey,
    );
  }
  private user(e: any) {
    return e?.source?.type === "user" &&
      typeof e.source.userId === "string" &&
      /^U[a-f0-9]{32}$/.test(e.source.userId)
      ? e.source.userId
      : undefined;
  }
  configure(actor: Actor, input: any, key: string) {
    this.db.admin(actor);
    const ev = this.db.event(actor, text(input.eventId, 128));
    const opens = Date.parse(input.opensAt),
      closes = Date.parse(input.closesAt);
    if (
      typeof input.enabled !== "boolean" ||
      !Number.isFinite(opens) ||
      !Number.isFinite(closes) ||
      opens >= closes ||
      closes > Date.parse(ev.closesAt)
    )
      fail("invalid_signup_window");
    return this.db.mutate(
      actor,
      key,
      digest(JSON.stringify(["line-event", input])),
      () => {
        this.db.run(
          "INSERT INTO line_event_settings VALUES(?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET enabled=excluded.enabled,opens_at=excluded.opens_at,closes_at=excluded.closes_at",
          ev.id,
          Number(input.enabled),
          new Date(opens).toISOString(),
          new Date(closes).toISOString(),
        );
        this.db.audit(actor, "line_event_config", ev.id, null);
        return { ok: true };
      },
    );
  }
  settings(actor: Actor) {
    this.db.admin(actor);
    return {
      configured: !!(
        this.cfg.lineChannelSecret &&
        this.cfg.lineAccessToken &&
        this.cfg.lineChannelId
      ),
      channelIdConfigured: !!this.cfg.lineChannelId,
      events: this.db.rows(
        "SELECT event_id eventId,enabled,opens_at opensAt,closes_at closesAt FROM line_event_settings",
      ),
      deliveries: this.db.rows(
        "SELECT id,status,error_code,created_at FROM line_webhooks ORDER BY created_at DESC LIMIT 50",
      ),
    };
  }
  claim(e: any) {
    if (
      !this.user(e) ||
      !["message", "postback"].includes(e.type) ||
      (e.type === "message" && e.message?.type !== "text")
    )
      return false;
    const id = text(e.webhookEventId, 128);
    const result = this.db.run(
      "INSERT OR IGNORE INTO line_webhooks(id,status,error_code,created_at) VALUES(?,?,?,?)",
      id,
      "processing",
      null,
      new Date().toISOString(),
    );
    return Number(result.changes) > 0;
  }
  finish(
    id: string,
    status: "sent" | "failed" | "unknown" | "ignored",
    error: string | null = null,
  ) {
    this.db.run(
      "UPDATE line_webhooks SET status=?,error_code=? WHERE id=?",
      status,
      error,
      id,
    );
  }
  needsName(e: any) {
    const user = this.user(e);
    return (
      user &&
      !this.db.row(
        "SELECT participant_id FROM line_identities WHERE subject_hash=?",
        this.subject(user),
      )
    );
  }
  private events(all = false) {
    const time = new Date().toISOString();
    return this.db.rows(
      "SELECT e.*,s.opens_at signup_opens,s.closes_at signup_closes FROM events e JOIN line_event_settings s ON s.event_id=e.id WHERE s.enabled=1 AND e.closes_at>?" +
        (all ? "" : " AND s.opens_at<=? AND s.closes_at>?") +
        " ORDER BY e.starts_at LIMIT 51",
      ...(all ? [time] : [time, time, time]),
    );
  }
  private choice(events: any[], action: string): Message[] {
    return [
      {
        type: "text",
        text:
          action === "cancel"
            ? "キャンセルするイベントを選んでください。"
            : "イベントを選んでください。",
        quickReply: {
          items: events.slice(0, 13).map((e) => ({
            type: "action",
            action: {
              type: "postback",
              label: String(e.title).slice(0, 20),
              data: action + ":" + e.id,
              displayText: String(e.title).slice(0, 100),
            },
          })),
        },
      },
    ];
  }
  respond(e: any, profileName?: string): Message[] {
    const user = this.user(e);
    if (!user) return [];
    const subject = this.subject(user);
    let identity = this.db.row(
      "SELECT participant_id FROM line_identities WHERE subject_hash=?",
      subject,
    );
    const input = e.type === "postback" ? e.postback?.data : e.message?.text;
    if (typeof input !== "string" || input.length > 500)
      return reply(
        "「参加希望」「QR再発行」「参加確認」「キャンセル」と送ってください。",
      );
    const command = input.trim();
    const submission = /^参加QR\s+([a-f0-9]{64})$/.exec(command);
    if (e.type === "message" && command.startsWith("参加QR")) {
      if (!submission)
        return reply(
          "申込専用コードを確認できません。申込画面のボタンからメッセージを送ってください。",
        );
      try {
        const accepted = new FormClaims(this.db).redeem(submission[1], subject);
        const token = randomBytes(32).toString("hex");
        this.db.run(
          "INSERT INTO line_tickets VALUES(?,?,?,?)",
          digest(token),
          accepted.event.id,
          accepted.person.id,
          Date.parse(accepted.event.closesAt) + 7 * 86400000,
        );
        return reply(
          accepted.event.title +
            "\n参加者：" +
            accepted.person.name +
            "\n申込情報を確認しました。受付でQRを提示してください。\n" +
            this.cfg.origin +
            "/ticket/#" +
            token +
            "\nこのリンクは本人用です。他の方に転送しないでください。",
        );
      } catch (error) {
        const messages: Record<string, string> = {
          claim_pending:
            "Googleでの申込受理をまだ確認できません。少し待って同じ申込メッセージを送ってください。",
          claim_event_pending:
            "申込は確認できました。イベントの受付準備中です。運営へお問い合わせください。",
          claim_used:
            "この申込コードは別のLINEで使用済みです。運営へお問い合わせください。",
          registration_cancelled:
            "この参加はキャンセル済みです。運営へお問い合わせください。",
          event_closed: "このイベントの受付は終了しました。",
          capacity_reached:
            "このイベントは定員に達しています。運営へお問い合わせください。",
          claim_event_date_mismatch:
            "イベントの日程を確認できません。運営へお問い合わせください。",
        };
        if (error instanceof ApiError && messages[error.message])
          return reply(messages[error.message]);
        throw error;
      }
    }
    let action =
      command === "キャンセル"
        ? "cancel"
        : ["QR", "QR再発行", "参加確認"].includes(command)
          ? "ticket"
          : "register";
    let selected: string | undefined;
    if (e.type === "postback") {
      const match =
        /^(register|ticket|cancel|confirm_cancel):([\w-]{1,128})$/.exec(
          command,
        );
      if (!match)
        return reply(
          "選択を確認できません。「参加希望」からやり直してください。",
        );
      action = match[1];
      selected = match[2];
    }
    const pending = this.db.row(
      "SELECT event_id,expires_at FROM line_conversations WHERE subject_hash=?",
      subject,
    );
    let supplied: string | undefined;
    if (
      e.type === "message" &&
      !["参加希望", "QR", "QR再発行", "参加確認", "キャンセル"].includes(
        command,
      )
    ) {
      if (pending && pending.expires_at > Date.now()) {
        selected = pending.event_id;
        action = "register";
        try {
          supplied = text(command, 60);
        } catch {
          return reply("お名前は60文字以内で入力してください。");
        }
      } else {
        this.db.run(
          "DELETE FROM line_conversations WHERE subject_hash=?",
          subject,
        );
        return reply(
          "「参加希望」「QR再発行」「参加確認」「キャンセル」と送ってください。",
        );
      }
    }
    let events = this.events(action !== "register");
    const owned = this.db.rows(`SELECT DISTINCT e.*,c.participant_id ownedParticipant FROM form_claims c JOIN registrations r ON r.participant_id=c.participant_id JOIN events e ON e.id=r.event_id LEFT JOIN form_event_mappings m ON m.external_event_id=c.external_event_id AND m.event_date=c.event_date WHERE c.subject_hash=? AND c.event_date=strftime('%Y-%m-%d',e.starts_at,'+9 hours') AND (m.event_id=e.id OR (m.event_id IS NULL AND e.source='analytics' AND e.external_id=c.external_event_id)) AND e.closes_at>? ORDER BY e.starts_at LIMIT 51`,subject,new Date().toISOString());
    if (action !== 'register') {
      events=events.filter(ev=>identity&&this.db.row('SELECT status FROM registrations WHERE event_id=? AND participant_id=?',ev.id,identity.participant_id));
      if(!identity&&!owned.length)return reply('まだ参加登録がありません。「参加希望」と送ってください。');
    }
    const byId=new Map(events.map(ev=>[ev.id,ev]));for(const ev of owned)if(!byId.has(ev.id))byId.set(ev.id,ev);events=[...byId.values()].sort((a,b)=>a.starts_at.localeCompare(b.starts_at));
    if (!events.length)
      return reply(
        "現在、受付中のイベントがありません。運営へお問い合わせください。",
      );
    if (events.length > 13)
      return reply("受付対象イベントが多いため、運営へお問い合わせください。");
    if (!selected && events.length > 1) return this.choice(events, action);
    const ev = events.find((v) => v.id === (selected || events[0].id));
    if (!ev)
      return reply(
        "このイベントは申込受付を終了したか、選択が無効になっています。「参加希望」から確認してください。",
      );
    if(action==='register'&&owned.some(row=>row.id===ev.id))action='ticket';
    if(action!=='register') {
      const ids=new Set(owned.filter(row=>row.id===ev.id).map(row=>row.ownedParticipant));
      if(identity&&this.db.row('SELECT 1 FROM registrations WHERE event_id=? AND participant_id=?',ev.id,identity.participant_id))ids.add(identity.participant_id);
      if(ids.size!==1)return reply('このイベントの参加登録が複数あります。運営へお問い合わせください。');
      identity={participant_id:[...ids][0]};
    }
    if (action === "cancel") {
      if (
        this.db.row(
          "SELECT state FROM attendance WHERE event_id=? AND participant_id=?",
          ev.id,
          identity.participant_id,
        )?.state === "in"
      )
        return reply(
          "受付済みの参加はキャンセルできません。運営へお問い合わせください。",
        );
      return [
        {
          type: "text",
          text: ev.title + " の参加をキャンセルしますか？",
          quickReply: {
            items: [
              {
                type: "action",
                action: {
                  type: "postback",
                  label: "キャンセルを確定",
                  data: "confirm_cancel:" + ev.id,
                  displayText: ev.title + " のキャンセルを確定",
                },
              },
            ],
          },
        },
      ];
    }
    if (action === "confirm_cancel") {
      return this.db.sql.transaction(() => {
        const at = this.db.row(
          "SELECT state FROM attendance WHERE event_id=? AND participant_id=?",
          ev.id,
          identity.participant_id,
        );
        if (at?.state === "in")
          return reply(
            "受付済みの参加はキャンセルできません。運営へお問い合わせください。",
          );
        this.db.run(
          "UPDATE registrations SET status='cancelled' WHERE event_id=? AND participant_id=?",
          ev.id,
          identity.participant_id,
        );
        this.db.audit(system, "line_cancel", ev.id, identity.participant_id);
        return reply(ev.title + " の参加をキャンセルしました。");
      });
    }
    if (action === "register") {
      let name: string | undefined;
      try {
        if (supplied || profileName) name = text(supplied || profileName, 60);
      } catch {}
      if (!identity && !name) {
        this.db.run(
          "INSERT INTO line_conversations VALUES(?,?,?) ON CONFLICT(subject_hash) DO UPDATE SET event_id=excluded.event_id,expires_at=excluded.expires_at",
          subject,
          ev.id,
          Date.now() + 15 * 60000,
        );
        return reply(
          ev.title +
            " に参加するお名前を入力してください（60文字以内・15分以内）。",
        );
      }
      const outcome = this.db.sql.transaction(() => {
        identity = this.db.row(
          "SELECT participant_id FROM line_identities WHERE subject_hash=?",
          subject,
        );
        const existing =
          identity &&
          this.db.row(
            "SELECT status FROM registrations WHERE event_id=? AND participant_id=?",
            ev.id,
            identity.participant_id,
          );
        if (
          existing?.status !== "planned" &&
          this.db.row(
            "SELECT count(*) n FROM registrations WHERE event_id=? AND status='planned'",
            ev.id,
          ).n >= ev.capacity
        )
          return false;
        if (!identity) {
          const id = randomUUID();
          this.db.run(
            "INSERT INTO participants(id,name,source,created_at) VALUES(?,?,?,?)",
            id,
            name!,
            "line",
            new Date().toISOString(),
          );
          this.db.run(
            "INSERT INTO line_identities VALUES(?,?,?)",
            subject,
            id,
            new Date().toISOString(),
          );
          identity = { participant_id: id };
        }
        this.db.run(
          "INSERT INTO registrations VALUES(?,?,'planned') ON CONFLICT(event_id,participant_id) DO UPDATE SET status='planned'",
          ev.id,
          identity.participant_id,
        );
        if (!existing || existing.status === "cancelled")
          this.db.audit(
            system,
            "line_register",
            ev.id,
            identity.participant_id,
          );
        this.db.run(
          "DELETE FROM line_conversations WHERE subject_hash=?",
          subject,
        );
        return true;
      });
      if (!outcome)
        return reply(
          ev.title + " は定員に達しています。運営へお問い合わせください。",
        );
    }
    const registration = this.db.row(
      "SELECT status FROM registrations WHERE event_id=? AND participant_id=?",
      ev.id,
      identity.participant_id,
    );
    if (registration?.status === "cancelled")
      return reply(
        ev.title +
          " はキャンセル済みです。再参加する場合は「参加希望」と送ってください。",
      );
    const token = randomBytes(32).toString("hex");
    this.db.run("DELETE FROM line_tickets WHERE expires_at<=?", Date.now());
    this.db.run(
      "INSERT INTO line_tickets VALUES(?,?,?,?)",
      digest(token),
      ev.id,
      identity.participant_id,
      Date.parse(ev.closes_at) + 7 * 86400000,
    );
    const person = this.db.row(
      "SELECT name FROM participants WHERE id=?",
      identity.participant_id,
    );
    return reply(
      ev.title +
        "\n" +
        new Date(ev.starts_at).toLocaleString("ja-JP", {
          timeZone: "Asia/Tokyo",
        }) +
        "\n会場：" +
        ev.venue +
        "\n参加者：" +
        person.name +
        "\n\n受付で以下のページのQRを提示してください。\n" +
        this.cfg.origin +
        "/ticket/#" +
        token +
        "\nこのリンクは本人用です。他の方に転送しないでください。",
    );
  }
  issueParticipantLink(actor: Actor,eventId:string,participantId:string,key:string) {
    eventId=text(eventId,120);participantId=text(participantId,120);
    this.db.event(actor,eventId);
    if(actor.role!=='Admin'&&actor.role!=='Staff')fail('forbidden',403);
    const person=this.db.person(actor,eventId,participantId,true),event=this.db.event(actor,eventId);
    if(person.status==='cancelled')fail('registration_cancelled',409);
    if(Date.parse(event.closesAt)<=Date.now())fail('event_closed',410);
    return this.db.mutate(actor,key,JSON.stringify(['participant-link',eventId,participantId]),()=>{
      const token=randomBytes(32).toString('hex'),expiresAt=Date.parse(event.closesAt)+7*86400000;
      this.db.run('INSERT INTO line_tickets VALUES(?,?,?,?)',digest(token),eventId,participantId,expiresAt);
      this.db.audit(actor,'participant_link',eventId,participantId);
      return {url:this.cfg.origin+'/ticket/#'+token,expiresAt};
    });
  }
  ticket(token: string): {
    name: string;
    event: any;
    status: string;
    token?: string;
    expiresAt?: number;
    qr?: string;
  } {
    if (!/^[a-f0-9]{64}$/.test(token)) fail("ticket_not_found", 404);
    const row = this.db.row(
      "SELECT * FROM line_tickets WHERE token_hash=? AND expires_at>?",
      digest(token),
      Date.now(),
    );
    if (!row) fail("ticket_not_found", 404);
    const event = this.db.event(system, row.event_id),
      p = this.db.person(system, row.event_id, row.participant_id);
    const base = {
      name: p.name,
      event: {
        title: event.title,
        startsAt: event.startsAt,
        opensAt: event.opensAt,
        closesAt: event.closesAt,
        venue: event.venue,
      },
    };
    if (p.status === "cancelled") return { ...base, status: "cancelled" };
    if (p.status === "checkedIn") return { ...base, status: "checkedIn" };
    if (Date.parse(event.closesAt) <= Date.now())
      return { ...base, status: "closed" };
    if (Date.parse(event.opensAt) > Date.now())
      return { ...base, status: "upcoming" };
    const expiresAt = Math.min(
      Date.now() + 10 * 60000,
      Date.parse(event.closesAt),
    );
    return {
      ...base,
      status: "planned",
      token: signTicket(
        this.cfg.signingKey,
        row.event_id,
        row.participant_id,
        expiresAt,
      ),
      expiresAt,
    };
  }
  async publicTicket(token: string) {
    const result = this.ticket(token);
    const { token: signed, ...rest } = result;
    return {
      ...rest,
      ...(signed
        ? {
            qr: await QRCode.toString(signed, {
              type: "svg",
              margin: 4,
              width: 360,
              errorCorrectionLevel: "M",
            }),
          }
        : {}),
    };
  }
  async webhook(
    raw: Buffer,
    signature: unknown,
    fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {
    verifyLineSignature(raw, signature, this.cfg.lineChannelSecret);
    if (!this.cfg.lineAccessToken || !this.cfg.lineChannelId)
      fail("line_unavailable", 503);
    let body: any;
    try {
      body = JSON.parse(raw.toString());
    } catch {
      fail("invalid_webhook");
    }
    if (
      !Array.isArray(body?.events) ||
      body.events.length > 20 ||
      typeof body.destination !== "string" ||
      !/^U[a-f0-9]{32}$/.test(body.destination)
    )
      fail("invalid_webhook");
    for (const e of body.events)
      if (
        this.user(e) &&
        ["message", "postback"].includes(e.type) &&
        (e.type !== "message" || e.message?.type === "text")
      )
        text(e.webhookEventId, 128);
    const claimed = body.events.filter((e: any) => this.claim(e));
    const processEvents = async () => {
      await Promise.all(
        claimed.map(async (e: any) => {
          let messages: Message[] = [];
          try {
            let profileName: string | undefined;
            if (
              this.needsName(e) &&
              e.type === "message" &&
              e.message.text?.trim() === "参加希望"
            ) {
              try {
                const r = await fetcher(
                  "https://api.line.me/v2/bot/profile/" + this.user(e),
                  {
                    headers: {
                      Authorization: "Bearer " + this.cfg.lineAccessToken,
                    },
                    signal: AbortSignal.timeout(3000),
                    redirect: "manual",
                  },
                );
                if (r.ok) {
                  const p: any = await r.json();
                  if (typeof p.displayName === "string")
                    profileName = p.displayName;
                }
              } catch {}
            }
            messages = this.respond(e, profileName);
          } catch (error) {
            this.finish(
              e.webhookEventId,
              "failed",
              error instanceof ApiError ? error.message : "registration_failed",
            );
            return;
          }
          if (!messages.length) {
            this.finish(e.webhookEventId, "ignored");
            return;
          }
          if (
            typeof e.replyToken !== "string" ||
            !e.replyToken ||
            e.replyToken.length > 512
          ) {
            this.finish(e.webhookEventId, "failed", "reply_token_missing");
            return;
          }
          this.finish(e.webhookEventId, "unknown", "reply_pending");
          try {
            const r = await fetcher(
              "https://api.line.me/v2/bot/message/reply",
              {
                method: "POST",
                headers: {
                  Authorization: "Bearer " + this.cfg.lineAccessToken,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ replyToken: e.replyToken, messages }),
                redirect: "manual",
                signal: AbortSignal.timeout(5000),
              },
            );
            this.finish(
              e.webhookEventId,
              r.ok ? "sent" : "failed",
              r.ok ? null : "reply_http_" + r.status,
            );
          } catch {
            this.finish(e.webhookEventId, "unknown", "reply_outcome_unknown");
          }
        }),
      );
    };
    const work = processEvents();
    if (this.cfg.lineSchedule) this.cfg.lineSchedule(work);
    else await work;
    return { ok: true };
  }
}
