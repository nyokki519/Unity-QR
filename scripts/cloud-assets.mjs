import { mkdir, cp, rm, writeFile, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

// Never publish a checkout or its data directory as a static asset root.
const files = [
  "assets/unity-logo.webp",
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
await mkdir(resolve(target, "ticket"), { recursive: true });
for (const [src, dest] of [
  ["public/ticket.html", "ticket/index.html"],
  ["public/ticket.js", "ticket/ticket.js"],
  ["public/ticket.css", "ticket/ticket.css"],
])
  await cp(resolve(src), resolve(target, dest));
await writeFile(
  resolve(target, "_headers"),
  (await readFile(resolve(target, "_headers"), "utf8")) +
    `/ticket/*
  Cache-Control: no-store
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
`,
);
console.log("Cloud assets staged from an explicit public-file allowlist.");
