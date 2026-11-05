// Shared Playwright harness: production hostnames resolve to the local TLS
// proxy; every other hostname fails to resolve, so nothing leaves the box.
import { chromium } from "playwright";
import fs from "node:fs";

export const APP = "https://brenorb.com/granola/";
export const QA_ROOT = process.env.QA_ROOT ?? "/tmp/granola-qa";
export const REPO = new URL("../..", import.meta.url).pathname;
export const EVIDENCE = `${QA_ROOT}/evidence`;
fs.mkdirSync(EVIDENCE, { recursive: true });

const HOSTS = [
  "brenorb.com",
  "testnut.cashu.space",
  "testnut.cashudevkit.org",
  "nos.lol",
  "relay.primal.net",
  "offchain.pub",
  "auth.nostr1.com"
];

export async function launch() {
  const rules = [
    ...HOSTS.map((host) => `MAP ${host}:443 127.0.0.1:8443`),
    "MAP * ~NOTFOUND",
    "EXCLUDE localhost",
    "EXCLUDE 127.0.0.1"
  ].join(",");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/proxy/i.test(key)) delete env[key];
  return chromium.launch({
    env,
    proxy: undefined,
    args: [`--host-resolver-rules=${rules}`, "--ignore-certificate-errors", "--no-proxy-server"]
  });
}

export async function openWallet(browser, profile, options = {}) {
  const context = options.context ?? await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 900 },
    acceptDownloads: true,
    ...(options.contextOptions ?? {})
  });
  const page = await context.newPage();
  const console_ = [];
  page.on("console", (msg) => console_.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (error) => console_.push(`[pageerror] ${error.message}`));
  const url = profile ? `${APP}?wallet=${profile}` : APP;
  await page.goto(url + (options.query ?? ""), { waitUntil: "domcontentloaded" });
  page.consoleLog = console_;
  return { context, page };
}

export async function control(path) {
  const response = await fetch(`http://127.0.0.1:8444${path}`);
  return response.text();
}

export async function shot(page, name) {
  const file = `${EVIDENCE}/${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

export async function statusText(page) {
  return page.locator("#status").textContent();
}

export async function waitStatus(page, pattern, timeout = 60_000) {
  await page.waitForFunction(
    (source) => new RegExp(source).test(document.getElementById("status")?.textContent ?? ""),
    pattern.source,
    { timeout }
  );
  return statusText(page);
}

export async function clearStatus(page) {
  await page.evaluate(() => { document.getElementById("status").textContent = ""; });
}

export async function act(page, action, pattern, timeout = 90_000) {
  await clearStatus(page);
  await action();
  return waitStatus(page, pattern, timeout);
}

// Records every status-toast message, so overwritten messages are not lost.
export async function recordStatuses(page) {
  await page.evaluate(() => {
    window.__statuses = [];
    const node = document.getElementById("status");
    new MutationObserver(() => {
      const text = node.textContent;
      if (text) window.__statuses.push(`${node.classList.contains("error") ? "ERR " : ""}${text}`);
    }).observe(node, { childList: true, characterData: true, subtree: true });
  });
}
export async function statuses(page) {
  return page.evaluate(() => window.__statuses.splice(0));
}
