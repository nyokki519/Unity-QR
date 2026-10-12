import { mkdir, cp, rm, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

// Never publish a checkout or its data directory as a static asset root.
const files = [
  "index.html",
  "app.js",
  "style.css",
  "ops/index.html",
  "ops/app.js",
  "ops/scanner.js",
  "ops/style.css",
  "ops/decoder.js",
];
const target = resolve("dist/cloudflare-public");
await rm(target, { recursive: true, force: true });
for (const file of files) {
  await mkdir(dirname(resolve(target, file)), { recursive: true });
  await cp(resolve(file), resolve(target, file));
}
await writeFile(
  resolve(target, "_headers"),
  `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(self), microphone=()
  X-Frame-Options: DENY
/ops/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
`,
);
console.log("Cloud assets staged from an explicit public-file allowlist.");
