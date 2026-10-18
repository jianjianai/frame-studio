#!/usr/bin/env bash
# Publish the commit checked out here to a running FRAME container (Docker Compose) without
# cutting off the AI conversations working in it.
#
#  - Changes only to files the running studio reads anew from disk (the built UI, the preview
#    pages' code that Vite compiles on request, docs/, public/) are copied into the running
#    container: nothing restarts, open pages offer a reload.
#  - Anything else (server code, dependencies, the image) needs the container replaced. That waits
#    until no AI conversation is in a turn and no background task (export…) runs; FRAME_NOW=1
#    replaces it right away (cut-off turns go on by themselves after the restart).
#
# Settings: FRAME_STACK (compose folder, default /opt/stacks/frame), FRAME_CONTAINER
# (frame-studio-1), FRAME_IMAGE (frame-studio:9.0.0). Docker runs through sudo.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
stack=${FRAME_STACK:-/opt/stacks/frame}
container=${FRAME_CONTAINER:-frame-studio-1}
image=${FRAME_IMAGE:-frame-studio:9.0.0}
cache=${XDG_CACHE_HOME:-$HOME/.cache}
commit=$(git -C "$repo" rev-parse HEAD)
say() { echo "[$(date '+%F %T')] $*"; }

# Built from the commit itself: uncommitted changes in the checkout stay out.
mkdir -p "$cache"
build=$(mktemp -d "$cache/frame-build.XXXXXX")
trap 'rm -rf "$build"' EXIT
git -C "$repo" archive HEAD | tar -x -C "$build"
say "building $image at ${commit:0:7}"
sudo docker build -q -f "$build/deploy/Dockerfile" --build-arg FRAME_COMMIT="$commit" -t "$image" "$build" >/dev/null

# What the studio process itself imports from src/ (the rest of src/ Vite compiles for the pages).
loaded=$(git -C "$repo" grep -ohE "(from|import\() *[\"'](\.\./)+src/[A-Za-z0-9_./-]+\.ts[\"']" "$commit" -- server bin | grep -oE "src/[A-Za-z0-9_./-]+\.ts" | sort -u)
needs_restart() {
  local running=$1 file
  [ -n "$running" ] && git -C "$repo" cat-file -e "$running^{commit}" 2>/dev/null || return 0
  while read -r file; do
    case "$file" in
      "") ;;
      src/*.mjs | src/*.mts) return 0 ;;
      src/*) grep -qxF "$file" <<<"$loaded" && return 0 ;;
      web/* | docs/* | public/* | tests/* | README.md | AGENTS.md) ;;
      *) return 0 ;;
    esac
  done < <(git -C "$repo" diff --name-only "$running" "$commit")
  return 1
}

running=$(sudo docker exec "$container" cat /app/.commit 2>/dev/null || true)
if [ "$running" = "$commit" ]; then
  say "${commit:0:7} is already running"
  exit 0
fi

if ! needs_restart "$running"; then
  # The UI's entry page last (pages loading meanwhile find every file it names), the commit after it.
  copy() { sudo docker run --rm --entrypoint tar "$image" -C /app -cf - "$@" | sudo docker exec -i "$container" tar -C /app -xf -; }
  copy --exclude=web/dist/web/index.html web/dist src docs public
  copy web/dist/web/index.html
  copy .commit
  say "published ${commit:0:7} into the running studio without a restart"
  exit 0
fi

# One update waits at a time; a later one has rebuilt the image, which the waiting one then uses.
exec 9>"$cache/frame-publish.lock"
if ! flock -n 9; then
  say "an update is already waiting for the AI to finish; it will publish ${commit:0:7}"
  exit 0
fi

busy() {
  [ "$(sudo docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" = true ] || return 0 # nothing to cut off
  sudo docker exec "$container" node -e '
    fetch(`http://127.0.0.1:${process.env.FRAME_PORT || 4310}/api/internal/busy`)
      .then((response) => (response.ok ? response.json() : { unknown: response.status }))
      .then((busy) => {
        if (busy.unknown) process.exit(0); // a studio from before this check
        const what = [...busy.ai.map((s) => `AI ${s.status}: ${s.title || s.id}`), ...busy.tasks.map((t) => `${t.kind}: ${t.title}`)];
        if (what.length) console.log(what.join("; "));
        process.exit(what.length ? 1 : 0);
      })
      .catch(() => process.exit(0)); // not answering: nothing to wait for
  ' 2>/dev/null
}
if [ "${FRAME_NOW:-}" != 1 ]; then
  said=0
  until what=$(busy); do
    # Report what it waits for now and then, not every check.
    if [ $((said % 20)) = 0 ]; then say "waiting: $what"; fi
    said=$((said + 1))
    sleep 30
  done
fi

say "replacing the studio container"
(cd "$stack" && sudo docker compose up -d)
for _ in $(seq 1 60); do
  health=$(sudo docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo missing)
  [ "$health" = healthy ] && break
  sleep 3
done
say "studio $health at $(sudo docker exec "$container" cat /app/.commit 2>/dev/null | cut -c1-7)"
[ "$health" = healthy ]
