import { readFile } from "node:fs/promises";
import { summarizeProfile } from "./lib/live-profile.mjs";

const path = process.argv[2];
if (!path) throw new Error("Provide a sanitized live profile JSON path");
console.log(JSON.stringify(summarizeProfile(JSON.parse(await readFile(path, "utf8"))), null, 2));
