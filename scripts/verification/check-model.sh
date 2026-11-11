#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || ( $# -eq 2 && "$2" != "--mutant" ) ]]; then
  echo 'Usage: bash scripts/verification/check-model.sh MODEL.tla [--mutant]' >&2
  exit 2
fi

model=$1
: "${TLA2TOOLS:?Set TLA2TOOLS to the absolute path of the TLC 1.7.4 release jar}"
expected_hash=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
actual_hash=$(shasum -a 256 "$TLA2TOOLS")
if [[ "${actual_hash%% *}" != "$expected_hash" ]]; then
  echo 'Expected the official TLC 1.7.4 release jar.' >&2
  exit 2
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/granola-tlc.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
config=${model%.tla}.cfg
if [[ $# -eq 2 ]]; then
  sed 's/^CONSTANT Broken = FALSE$/CONSTANT Broken = TRUE/' "$config" > "$scratch/mutant.cfg"
  config=$scratch/mutant.cfg
fi

"${JAVA:-java}" -Xmx512m -XX:+UseParallelGC -cp "$TLA2TOOLS" tlc2.TLC \
  -workers 1 -fp 0 -metadir "$scratch/states" -config "$config" "$model"
