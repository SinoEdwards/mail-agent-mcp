#!/usr/bin/env sh
# Build Mail Agent MCP from the current checkout. It does not clone, pull,
# edit client configuration, or handle credentials.
set -eu
required_major=22
required_minor=12
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 22.12 or newer is required.' >&2
  exit 1
fi
version=$(node --version | sed 's/^v//')
major=$(printf '%s' "$version" | cut -d. -f1)
minor=$(printf '%s' "$version" | cut -d. -f2)
if [ "$major" -lt "$required_major" ] || { [ "$major" -eq "$required_major" ] && [ "$minor" -lt "$required_minor" ]; }; then
  echo "Node.js 22.12 or newer is required; found $version." >&2
  exit 1
fi
test -f package-lock.json || { echo 'Run install.sh from the repository root.' >&2; exit 1; }
npm ci
npm run build
echo 'Build complete. Windows users: node dist/enroll.js --help'
echo 'Enroll locally, then add dist/index.js to your MCP client.'
