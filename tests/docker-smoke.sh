#!/bin/sh
set -eu

response=$(curl -sSf http://127.0.0.1:3200/api/health)
node -e 'if (JSON.parse(process.argv[1]).app !== "ok") process.exit(1)' "$response"
