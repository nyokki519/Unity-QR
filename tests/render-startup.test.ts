import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

async function startup(
  overrides: Record<string, string>,
  expectedReady: boolean,
) {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const dir = mkdtempSync(join(tmpdir(), "qr-render-startup-"));
  const child = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      QR_DB_PATH: join(dir, "test.sqlite"),
      QR_SIGNING_KEY: randomBytes(32).toString("hex"),
      QR_ORIGIN: "",
      QR_ALLOW_LOCAL: "",
      RENDER: "",
      RENDER_EXTERNAL_URL: "",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  try {
    const ready = await new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Server startup timed out")),
        10000,
      );
      child.stdout.on("data", () => {
        if (output.includes("Unity QR server listening")) {
          clearTimeout(timeout);
          resolve(true);
        }
      });
      child.once("close", () => {
        clearTimeout(timeout);
        resolve(false);
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    assert.equal(
      ready,
      expectedReady,
      "server readiness must match the trusted origin configuration",
    );
    if (ready) {
      const response = await fetch(`http://127.0.0.1:${port}/api/v2/health`);
      assert.equal(response.status, 200);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Render starts with its platform-assigned HTTPS URL without manual QR_ORIGIN", async () => {
  await startup(
    { RENDER: "true", RENDER_EXTERNAL_URL: "https://qr-trial.onrender.com" },
    true,
  );
});

test("explicit QR_ORIGIN takes precedence over Render's assigned URL", async () => {
  await startup(
    {
      QR_ORIGIN: "https://qr.example.com",
      RENDER: "true",
      RENDER_EXTERNAL_URL: "invalid",
    },
    true,
  );
});

test("Render's HTTP URL is rejected in production", async () => {
  await startup(
    { RENDER: "true", RENDER_EXTERNAL_URL: "http://qr-trial.onrender.com" },
    false,
  );
});

test("outside Render an injected external URL does not replace required QR_ORIGIN", async () => {
  await startup(
    { RENDER_EXTERNAL_URL: "https://qr-trial.onrender.com" },
    false,
  );
});
