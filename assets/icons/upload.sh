#!/usr/bin/env bash
# Regenerate the served app-icon sizes from icon-master.png into ../../public/ — the static-assets
# directory Cloudflare serves them from directly (no Worker invocation). After running: npx wrangler deploy
set -euo pipefail
cd "$(dirname "$0")"
for s in 180 192 512; do
  sips -s format png -z "$s" "$s" icon-master.png --out "../../public/icon-$s.png" >/dev/null
done
echo "Regenerated public/icon-{180,192,512}.png. Now run: npx wrangler deploy"
