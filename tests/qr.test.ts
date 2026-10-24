import test from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import { PNG } from "pngjs";
import { decode } from "../server/decoder.js";
import { signTicket, verifyTicket } from "../server/security.js";
test("an actual generated signed QR decodes and verifies, a blank image does not", async () => {
  const key = "test-only-qr-key-".repeat(4);
  const token = signTicket(key, "event", "person", Date.now() + 60000);
  const image = PNG.sync.read(
    await QRCode.toBuffer(token, { width: 600, margin: 4 }),
  );
  assert.equal(
    decode(new Uint8ClampedArray(image.data), image.width, image.height),
    token,
  );
  assert.equal(
    verifyTicket(
      key,
      decode(new Uint8ClampedArray(image.data), image.width, image.height)!,
      "event",
    ).participantId,
    "person",
  );
  assert.equal(decode(new Uint8ClampedArray(100 * 100 * 4), 100, 100), null);
});
