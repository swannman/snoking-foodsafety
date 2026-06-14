#!/usr/bin/env bash
# Regenerate app-icon sizes from icon-master.png and upload them to the KV namespace
# the Worker serves them from (routes /icon-<size>.png read env.REGIONS).
# After running, bump the ".png?v=N" cache-bust in src/index.js and deploy.
set -euo pipefail
cd "$(dirname "$0")"
NS=32eb27b3de934723a82c747e0b5d4dd7
for s in 180 192 512; do
  sips -s format png -z "$s" "$s" icon-master.png --out "icon-$s.png" >/dev/null
  npx wrangler kv key put --namespace-id="$NS" "icon-$s.png" --path="icon-$s.png" --remote
done
echo "Done. Now bump .png?v=N in src/index.js and run: npx wrangler deploy"
