#!/bin/sh
set -e
node dist/migrate.js
if [ "${SEED_DEMO:-false}" = "true" ]; then
  node dist/seed.js
fi
exec node dist/server.js
