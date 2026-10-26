#!/usr/bin/env bash
# docker-smoke.sh
#
# Builds the production image from ./Dockerfile and boots it the way Render
# does (render.yaml: same env, nginx on port 80), then checks it through nginx:
#
#   1. GET /api/health   -> 200 {"status":"ok",...} (503 until the lobby
#                           service reports healthy; see src/server/Master.ts)
#   2. GET /             -> 200 HTML with the app shell from index.html
#   3. GET /commit.txt   -> the GIT_COMMIT the image was built with
#
# The unit suite can't catch a broken image (a stage missing scripts/ or
# packages/, a bad nginx or supervisord config); this can. CI runs it in the
# `docker` job of .github/workflows/ci.yml, and it runs the same way locally:
#
#   scripts/docker-smoke.sh
#
# Exits 0 only when every check passes. On failure it prints the container
# logs; the container is always removed on exit, including on Ctrl-C.
#
# Environment (all optional):
#   GIT_COMMIT            build arg and runtime env (default: smoke)
#   SMOKE_IMAGE           image tag, fixed so reruns replace it
#                         (default: openmyfront-smoke:local)
#   SMOKE_CONTAINER       container name (default: openmyfront-smoke)
#   SMOKE_HEALTH_TIMEOUT  seconds to wait for /api/health (default: 180)
#   SMOKE_SKIP_BUILD=1    reuse an already-built SMOKE_IMAGE
set -euo pipefail

cd "$(dirname "$0")/.."

GIT_COMMIT="${GIT_COMMIT:-smoke}"
IMAGE="${SMOKE_IMAGE:-openmyfront-smoke:local}"
CONTAINER="${SMOKE_CONTAINER:-openmyfront-smoke}"
HEALTH_TIMEOUT="${SMOKE_HEALTH_TIMEOUT:-180}"
# A non-number would make the timeout test below error out, and the health loop
# would never time out.
case "$HEALTH_TIMEOUT" in
  "" | *[!0-9]*)
    echo "SMOKE_HEALTH_TIMEOUT must be whole seconds, got '$HEALTH_TIMEOUT'" >&2
    exit 2
    ;;
esac

# Stable markers from index.html that only the real app shell contains (the
# build doesn't minify it: vite.config.ts sets createHtmlPlugin minify: false).
SHELL_MARKERS=('<main-layout' '<div id="app"></div>')

BODY="$(mktemp)"

log() {
  echo "[docker-smoke] $*"
}

cleanup() {
  rm -f "$BODY"
  docker rm -f "$CONTAINER" > /dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  log "FAIL: $*"
  if docker inspect "$CONTAINER" > /dev/null 2>&1; then
    log "container state: $(docker inspect -f '{{.State.Status}} (exit {{.State.ExitCode}})' "$CONTAINER")"
    log "----- docker logs $CONTAINER -----"
    docker logs "$CONTAINER" 2>&1 || true
    log "----- end of logs -----"
  fi
  exit 1
}

# The start of the last response body, on one line.
snippet() {
  head -c 200 "$BODY" | tr -s '[:space:]' ' '
}

# GET a URL into $BODY; prints the HTTP status (000 when nothing answered).
fetch() {
  curl -sS -o "$BODY" -w '%{http_code}' --max-time 10 "$1" 2> /dev/null ||
    true
}

# A container left over from an interrupted run would hold the name.
docker rm -f "$CONTAINER" > /dev/null 2>&1 || true

if [ "${SMOKE_SKIP_BUILD:-}" != 1 ]; then
  log "building $IMAGE (GIT_COMMIT=$GIT_COMMIT)"
  # The Dockerfile uses RUN --mount=type=cache and a heredoc: BuildKit only.
  DOCKER_BUILDKIT=1 docker build \
    --build-arg "GIT_COMMIT=$GIT_COMMIT" \
    --tag "$IMAGE" \
    . || fail "docker build failed"
fi

# The env render.yaml sets (keep the two lists in sync), except GIT_COMMIT: render.yaml's value is a
# placeholder that start.sh replaces with RENDER_GIT_COMMIT; here it is the
# build's own commit, as in a real deploy.
log "starting $CONTAINER"
docker run --detach --name "$CONTAINER" \
  --publish 127.0.0.1::80 \
  --env GAME_ENV=dev \
  --env SELF_HOST=true \
  --env NUM_WORKERS=2 \
  --env TURNSTILE_SITE_KEY=1x00000000000000000000AA \
  --env DOMAIN=localhost \
  --env "GIT_COMMIT=$GIT_COMMIT" \
  --env PORT=80 \
  "$IMAGE" > /dev/null || fail "docker run failed"

# Port 80 is published on a free host port Docker picks, so nothing else
# listening on this machine can collide with it. (The container name and image
# tag are fixed, so run one smoke test at a time per Docker host.) docker port
# fails once the container has exited, which a broken image can do at boot.
HOST_PORT="$(docker port "$CONTAINER" 80/tcp 2> /dev/null | head -n 1 |
  sed 's/.*://')" || true
[ -n "$HOST_PORT" ] ||
  fail "could not read the published port (did the container exit?)"
BASE="http://127.0.0.1:$HOST_PORT"
log "container port 80 is $BASE"

log "waiting up to ${HEALTH_TIMEOUT}s for $BASE/api/health"
start=$SECONDS
while :; do
  status="$(fetch "$BASE/api/health")"
  if [ "$status" = 200 ] && grep -q '"status":"ok"' "$BODY"; then
    break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" != true ]; then
    fail "container exited before /api/health was ok"
  fi
  if [ $((SECONDS - start)) -ge "$HEALTH_TIMEOUT" ]; then
    fail "/api/health not ok after ${HEALTH_TIMEOUT}s" \
      "(last status $status: $(snippet))"
  fi
  sleep 2
done
log "ok   /api/health 200 after $((SECONDS - start))s: $(snippet)"

status="$(fetch "$BASE/")"
[ "$status" = 200 ] || fail "GET / returned $status, expected 200"
for marker in "${SHELL_MARKERS[@]}"; do
  grep -qF "$marker" "$BODY" ||
    fail "GET / is not the app shell (missing '$marker')"
done
log "ok   / 200 with the app shell"

status="$(fetch "$BASE/commit.txt")"
[ "$status" = 200 ] || fail "GET /commit.txt returned $status, expected 200"
commit="$(tr -d '[:space:]' < "$BODY")"
[ "$commit" = "$GIT_COMMIT" ] ||
  fail "/commit.txt is '$commit', expected '$GIT_COMMIT'"
log "ok   /commit.txt is $commit"

log "PASS"
