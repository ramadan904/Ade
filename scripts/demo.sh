#!/usr/bin/env bash
# One-command local demo: a local chain, the contracts, a moving market, the agent, and the web app.
# Needs: foundry (anvil, forge), node >= 20, python3. Set ANTHROPIC_API_KEY to plan with Claude.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
RPC_URL=http://127.0.0.1:8545
# Anvil's public dev keys: 0 deploys and keeps prices, 2 is the agent. The web app uses 1 as the owner.
DEPLOYER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
AGENT=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
EVERY=${EVERY:-30}

for bin in anvil forge node python3; do
  command -v "$bin" >/dev/null || { echo "missing $bin (install foundry: https://getfoundry.sh)"; exit 1; }
done

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if curl -s -o /dev/null -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' "$RPC_URL"; then
  echo "Something is already listening on 8545; stop it first." && exit 1
fi
anvil --silent --port 8545 & pids+=($!)
sleep 2

echo "Deploying contracts..."
(cd contracts && forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER" >/dev/null)

[ -d agent/node_modules ] || (cd agent && npm ci --silent)

planner=rules
[ -n "${ANTHROPIC_API_KEY:-}" ] && planner=claude
export RPC_URL
(cd agent && KEEPER_PRIVATE_KEY=$DEPLOYER npx tsx src/keeper.ts --demo --every "$EVERY") & pids+=($!)
(cd agent && AGENT_PRIVATE_KEY=$AGENT npx tsx src/run.ts --all --planner "$planner" --loop "$EVERY") & pids+=($!)
python3 -m http.server 4173 --bind 127.0.0.1 --directory "$ROOT" >/dev/null 2>&1 & pids+=($!)

cat <<MSG

  Stockpilot is running locally.

    Web app   http://127.0.0.1:4173/web/   (Connect wallet uses a local dev account, no extension needed)
    Agent     checks every ${EVERY}s with the ${planner} planner
    Market    prices move every ${EVERY}s

  Open the web app, create a vault, and watch the agent's trades appear. Ctrl-C stops everything.

MSG
wait
