import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "./store.js";
import { hashPassword, text } from "./security.js";

process.umask(0o077);
const [command, arg, role = "Admin", ...events] = process.argv.slice(2);
if (command === "verify") {
  if (!arg || !existsSync(arg))
    throw new Error("Use backup:verify -- /path/to/backup.sqlite");
  const copy = new DatabaseSync(resolve(arg), { readOnly: true });
  try {
    const integrity = copy.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok")
      throw new Error("Backup integrity failed");
    if (copy.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Backup foreign key check failed");
    if (![2,3].includes((copy.prepare("PRAGMA user_version").get() as any).user_version))
      throw new Error("Unexpected backup schema");
    if (
      (copy.prepare("PRAGMA application_id").get() as any).application_id !==
      0x55515232
    )
      throw new Error("Backup belongs to another application");
    console.log("Backup integrity, foreign keys and schema verified.");
  } finally {
    copy.close();
  }
} else {
  const path = resolve(process.env.QR_DB_PATH || "data/qr.sqlite");
  if (command === "backup" && !existsSync(path))
    throw new Error("Source database does not exist");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Store(path);
  try {
    if (command === "user") {
      if (!arg || !["Admin", "Staff", "Viewer"].includes(role))
        throw new Error(
          "Use admin:create -- username [Admin|Staff|Viewer] [event IDs]. Provide password on standard input.",
        );
      const password = readFileSync(0, "utf8").replace(/[\r\n]+$/, "");
      if (role !== "Admin" && !events.length)
        throw new Error("Staff/Viewer require at least one event ID");
      const id = db.addUser(
        text(arg, 60),
        hashPassword(password),
        role as "Admin" | "Staff" | "Viewer",
        events,
      );
      console.log(`Created ${role} account (${id}). Password is not printed.`);
    } else if (command === "backup") {
      if (!arg || existsSync(arg) || resolve(arg) === path)
        throw new Error(
          "Choose a new backup path; existing files are never overwritten.",
        );
      mkdirSync(dirname(resolve(arg)), { recursive: true, mode: 0o700 });
      await db.backup(resolve(arg));
      console.log("Backup created. Run backup:verify before relying on it.");
    } else throw new Error("Unknown command");
  } finally {
    db.close();
  }
}
