#!/usr/bin/env bash
# Run the full 25-task benchmark against opus, haiku, and sonnet via the
# LiteLLM gateway. Each model runs jobs=1 to avoid 429 rate limiting.
#
# Usage: bash bench/run_matrix.sh [--model opus|haiku|sonnet] [--id TASK_ID]
#
# Without --model, runs all three sequentially (opus first so its cache warms
# while the cheaper models run). With --model, runs only that one.
# With --id, runs only that specific task (for debugging).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="/home/mhabeeb/git/Turma"
TASKS="$SCRIPT_DIR/archive/tasks-validated.json"
RUNS_BASE="$HOME/turma-bench-matrix"
GATEWAY="https://lite.xerktech.com"
KEY="${ANTHROPIC_AUTH_TOKEN:?ANTHROPIC_AUTH_TOKEN must be set}"

# Model identifiers on the gateway
declare -A MODELS=(
  [opus]="bedrock/us.anthropic.claude-opus-4-6-v1"
  [haiku]="bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0"
  [sonnet]="bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0"
)

# Parse args
RUN_MODELS=()
EXTRA_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) RUN_MODELS+=("$2"); shift 2 ;;
    --id) EXTRA_ARGS+=("--id" "$2"); shift 2 ;;
    *) EXTRA_ARGS+=("$1"); shift ;;
  esac
done

if [[ ${#RUN_MODELS[@]} -eq 0 ]]; then
  RUN_MODELS=(opus haiku sonnet)
fi

mkdir -p "$RUNS_BASE"

run_model() {
  local name="$1"
  local model_id="${MODELS[$name]}"
  local runs_dir="$RUNS_BASE/$name"
  local out="$RUNS_BASE/$name-results.json"

  echo ""
  echo "================================================================"
  echo "  MODEL: $name ($model_id)"
  echo "  Tasks: 25, jobs: 1, cap: 1500s"
  echo "  Output: $out"
  echo "  Started: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "================================================================"
  echo ""

  mkdir -p "$runs_dir"

  # The bench runner uses TURMA_LOCAL_* env vars, which harness_claude_local
  # translates into ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL.
  TURMA_LOCAL_BASE_URL="${GATEWAY}/v1" \
  TURMA_LOCAL_API_KEY="$KEY" \
  TURMA_LOCAL_MODEL="$model_id" \
  TURMA_LOCAL_CONTEXT="200000" \
  python3 "$SCRIPT_DIR/run_bench.py" \
    --repo "$REPO" \
    --tasks "$TASKS" \
    --harness claude-local \
    --jobs 1 \
    --cap 1500 \
    --workroot "$RUNS_BASE/work" \
    --runs "$runs_dir" \
    --out "$out" \
    "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"

  echo ""
  echo "  Finished $name: $(date '+%Y-%m-%d %H:%M:%S')"
  echo ""
}

echo "Turma XERK-445: Full 25-task model matrix"
echo "Models: ${RUN_MODELS[*]}"
echo "Start: $(date '+%Y-%m-%d %H:%M:%S')"

for m in "${RUN_MODELS[@]}"; do
  if [[ -z "${MODELS[$m]+x}" ]]; then
    echo "ERROR: unknown model '$m'. Choose from: opus, haiku, sonnet" >&2
    exit 1
  fi
  run_model "$m"
done

echo ""
echo "================================================================"
echo "  ALL DONE: $(date '+%Y-%m-%d %H:%M:%S')"
echo "  Results:"
for m in "${RUN_MODELS[@]}"; do
  echo "    $m: $RUNS_BASE/$m-results.json"
done
echo "================================================================"
