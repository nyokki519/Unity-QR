import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function fail(code: string, status = 400): never {
  throw new ApiError(status, code);
}
export function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function keyedDigest(value: string, key: string) {
  return createHmac("sha256", secret(key)).update(value).digest("hex");
}
export function secret(value: string | undefined) {
  if (!value || Buffer.byteLength(value) < 32)
    fail("configuration_unavailable", 503);
  return value;
}
export function hashPassword(password: string) {
  if (password.length < 16 || password.length > 128) fail("password_length");
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}
export function checkPassword(password: string, encoded: string) {
  if (
    password.length > 128 ||
    !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(encoded)
  )
    return false;
  const [, salt, hash] = encoded.split("$");
  return timingSafeEqual(
    scryptSync(password, salt, 64),
    Buffer.from(hash, "hex"),
  );
}
export function signTicket(
  key: string,
  eventId: string,
  participantId: string,
  expiresAt: number,
) {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      iss: "unity-qr",
      aud: "reception",
      eventId,
      participantId,
      exp: expiresAt,
    }),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", secret(key)).update(payload).digest("base64url")}`;
}
export function verifyTicket(
  key: string,
  token: string,
  eventId: string | readonly string[],
  now = Date.now(),
) {
  if (
    typeof token !== "string" ||
    token.length > 2048 ||
    !/^[\w-]+\.[\w-]{43}$/.test(token)
  )
    fail("invalid_qr");
  const [payload, mac] = token.split(".");
  const expected = createHmac("sha256", secret(key))
    .update(payload)
    .digest("base64url");
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected)))
    fail("invalid_qr");
  let data: any;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    fail("invalid_qr");
  }
  if (
    !data ||
    data.v !== 1 ||
    data.iss !== "unity-qr" ||
    data.aud !== "reception" ||
    typeof data.participantId !== "string" ||
    !data.participantId ||
    !(Array.isArray(eventId) ? eventId.includes(data.eventId) : data.eventId === eventId)
  )
    fail("invalid_qr");
  if (
    !Number.isFinite(data.exp) ||
    data.exp <= now ||
    data.exp > now + 86400_000
  )
    fail("qr_expired");
  return data as { participantId: string; eventId: string; exp: number };
}
export function text(value: unknown, max = 80) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > max ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    fail("invalid_input");
  return value.trim();
}
