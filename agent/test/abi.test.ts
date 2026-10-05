import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { toFunctionSignature, type Abi } from "viem";
import { factoryAbi, vaultAbi } from "../src/abi.js";
import { repoRoot } from "../src/config.js";

function artifact(name: string): Abi | null {
  const file = path.join(repoRoot, "contracts", "out", `${name}.sol`, `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).abi as Abi) : null;
}

const sigs = (abi: Abi, type: "function" | "event" | "error") =>
  new Set(abi.filter((x) => x.type === type).map((x) => toFunctionSignature(x as never)));

for (const [name, ours] of [["PilotVault", vaultAbi], ["PilotFactory", factoryAbi]] as const) {
  test(`${name}: every function and event the agent uses exists in the compiled contract`, (t) => {
    const real = artifact(name);
    if (!real) return t.skip("run `forge build` in contracts/ first");
    for (const type of ["function", "event"] as const) {
      const have = sigs(real, type);
      for (const sig of sigs(ours as Abi, type)) assert.ok(have.has(sig), `${name} has no ${type} ${sig}`);
    }
    const realErrors = sigs(real, "error");
    for (const sig of realErrors) assert.ok(sigs(ours as Abi, "error").has(sig), `agent ABI is missing error ${sig}`);
  });
}
