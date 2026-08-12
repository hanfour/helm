#!/usr/bin/env bash
set -euo pipefail
echo "== typecheck =="; npx tsc --noEmit
# 測試絕不寫入真實的 defaults domain；沒注入假物件的話會直接爆掉而不是靜默改壞。
export HELM_NO_REAL_PREFS=1
echo "== test + coverage =="; node --test --experimental-test-coverage "src/**/*.test.ts"
