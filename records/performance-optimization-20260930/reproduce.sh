#!/usr/bin/env bash
set -euo pipefail

# Run from the ovh-docker AgentDock checkout. All writable state is isolated.
task_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
task_parent=/home/agentdock/AgentDock
case "$task_root" in
  "$task_parent"/*) ;;
  *) echo "This recipe requires the ovh-docker AgentDock workspace." >&2; exit 1 ;;
esac
case "$task_root" in
  *[!a-zA-Z0-9_./-]*) echo "Workspace path contains unsupported shell characters." >&2; exit 1 ;;
esac
task_host_root="/var/lib/docker/volumes/agent-dock_agentdock_workspace/_data/${task_root#"$task_parent"/}"
task_deps=/var/lib/docker/volumes/agent-dock_agentdock_workspace/_data/frame-studio/node_modules
task_image=${FRAME_PERF_IMAGE:-sha256:43b5807e9a4db3f1265512f3f95df171091b774641acc1df495dc4cd42148470}
case "$task_image" in
  *[!a-zA-Z0-9_./:@-]*) echo "Invalid image reference." >&2; exit 1 ;;
esac
task_tag="frame-perf-$(date +%s)-$$"
task_db="$task_tag-db"
task_runner="$task_tag-runner"
task_network=frame-development
task_base="$task_root/records/performance-optimization-20260930"
task_commit=$(git -C "$task_root" rev-parse HEAD)
[[ "$task_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid Git revision." >&2; exit 1; }
task_baseline=$task_commit
if [[ -n "$(git -C "$task_root" status --porcelain)" ]]; then task_baseline="$task_commit-dirty"; fi
mkdir -p "$task_root/.cache/optimization-reproduction"

cleanup() {
  for task_container in "$task_runner" "$task_db"; do
    task_owner=$(ssh host "sudo -n docker inspect --format '{{index .Config.Labels \"frame-performance-audit\"}}' '$task_container'" 2>/dev/null || true)
    if [[ "$task_owner" == "$task_tag" ]]; then
      ssh host "sudo -n docker stop '$task_container'" >/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

ssh host "sudo -n docker run --rm -d --name '$task_db' --label frame-performance-audit='$task_tag' --network '$task_network' --memory=512m --tmpfs /var/lib/postgresql:rw -e POSTGRES_USER=frame -e POSTGRES_PASSWORD=performance-fixture-only -e POSTGRES_DB=frame_test_perf postgres:18-alpine" >/dev/null
for task_attempt in {1..40}; do
  if ssh host "sudo -n docker exec '$task_db' pg_isready -U frame -d frame_test_perf" >/dev/null 2>&1; then
    break
  fi
  if [[ "$task_attempt" == 40 ]]; then echo "Fixture database did not start." >&2; exit 1; fi
  sleep 0.25
done

run_benchmark() {
  local task_script=$1 task_database=$2 task_node_flags=
  if [[ "$task_script" == memory-benchmark.mjs ]]; then task_node_flags=--expose-gc; fi
  ssh host "sudo -n docker run --rm --name '$task_runner' --label frame-performance-audit='$task_tag' --network '$task_network' --memory=3g --cpus=2 --user 10001:10001 -v '$task_host_root:/audit' -v '$task_deps:/audit/node_modules:ro' --tmpfs /audit/node_modules/.vite-temp:rw,uid=10001,gid=10001 --tmpfs /audit/node_modules/.vite:rw,uid=10001,gid=10001 -w /audit -e FRAME_ROLE=api -e FRAME_PERF_BASELINE='$task_baseline' -e XDG_CONFIG_HOME=/audit/.cache/performance-chromium-config -e XDG_CACHE_HOME=/audit/.cache/performance-chromium-cache -e FRAME_TEST_DATABASE_URL='postgresql://frame:performance-fixture-only@$task_db:5432/$task_database' '$task_image' node $task_node_flags 'records/performance-optimization-20260930/$task_script'" \
    > "$task_root/.cache/optimization-reproduction/$task_script.log" 2>&1
}

run_benchmark benchmark.mjs frame_test_perf
ssh host "sudo -n docker exec '$task_db' psql -U frame -d postgres -c 'CREATE DATABASE frame_test_perf_aux'" >/dev/null
run_benchmark protocol-benchmark.mjs frame_test_perf_aux
run_benchmark lock-benchmark.mjs frame_test_perf_aux
run_benchmark render-benchmark.mjs frame_test_perf_aux
run_benchmark memory-benchmark.mjs frame_test_perf_aux
echo "Results: $task_base"
