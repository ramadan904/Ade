import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { repoRoot } from "../src/config.js";

// Drives the real web app in Chromium against a local chain, in dev mode (no wallet extension).
const KEEPER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const AGENT = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const CHAIN_PORT = 8900 + Math.floor(Math.random() * 300);
const RPC_URL = `http://127.0.0.1:${CHAIN_PORT}`;
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const haveTools = ["anvil", "forge"].every((bin) => spawnSync(bin, ["--version"]).status === 0);

let node: ChildProcess | undefined;
let server: Server | undefined;
let browser: Browser | undefined;
let base = "";

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

before(async () => {
  if (!haveTools) return;
  node = spawn("anvil", ["--port", String(CHAIN_PORT), "--silent"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1500));
  execFileSync("forge", ["script", "script/Deploy.s.sol", "--offline", "--rpc-url", RPC_URL, "--broadcast", "--private-key", KEEPER], {
    cwd: path.join(repoRoot, "contracts"),
    stdio: "ignore",
  });
  server = createServer((req, res) => {
    const file = path.join(repoRoot, decodeURIComponent(new URL(req.url!, "http://x").pathname));
    const target = existsSync(file) && statSync(file).isDirectory() ? path.join(file, "index.html") : file;
    if (!target.startsWith(repoRoot) || !existsSync(target)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(target)] ?? "application/octet-stream" });
    createReadStream(target).pipe(res);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath });
});

after(async () => {
  await browser?.close();
  server?.close();
  node?.kill();
});

test("web app: open a vault, watch the agent trade, pause it", { skip: !haveTools && "needs anvil and forge" }, async () => {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}/web/?rpc=${encodeURIComponent(RPC_URL)}`);

  await page.click("#connect");
  await page.waitForSelector("#create:not([hidden])");
  assert.deepEqual(await page.$$eval("#f-assets input:checked", (els) => els.map((e) => e.closest("label")!.querySelector("b")!.textContent)), ["TSLA", "AMZN"]);
  await page.click("#mint");
  await page.waitForFunction(() => document.querySelector("#create-status")!.textContent!.includes("Added"));
  await page.click("#create-btn");
  await page.waitForSelector("#dashboard:not([hidden])", { timeout: 30_000 });
  assert.equal(await page.textContent("#d-cash"), "$500.00");
  assert.equal(await page.textContent("#d-state"), "Agent active");

  execFileSync("npx", ["tsx", "src/run.ts", "--all", "--planner", "rules"], {
    cwd: path.join(repoRoot, "agent"),
    env: { ...process.env, RPC_URL, AGENT_PRIVATE_KEY: AGENT, ANTHROPIC_API_KEY: "" },
  });
  await page.waitForFunction(() => document.querySelectorAll("#d-feed li").length === 2, null, { timeout: 20_000 });
  assert.equal(await page.textContent("#d-cash"), "$400.00");
  assert.equal(await page.textContent("#d-budget"), "$0.00 / $100.00");
  assert.match((await page.textContent("#d-feed"))!, /Bought [\d.]+ TSLA for \$50\.00.*Even DCA split/s);

  await page.click("#pause-btn");
  await page.waitForFunction(() => document.querySelector("#d-state")!.textContent === "Agent paused");

  await page.fill("#d-per-trade", "500");
  await page.click('[data-action="save-policy"]');
  await page.waitForFunction(() => document.querySelector("#d-status")!.classList.contains("error"));

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "no sideways scroll on a phone");
  assert.deepEqual(errors, []);
});
