#!/usr/bin/env bash
set -euo pipefail
echo "== typecheck =="; npx tsc --noEmit
echo "== test + coverage =="; node --test --experimental-test-coverage "src/**/*.test.ts"
