#!/usr/bin/env bash
# One release image (spec 01 §4.9, §5.5; ARCHITECTURE §11.7; orchestrator decision BD-05). A control
# path, run by release.yml's images job for one IMAGE at a time:
#   console, admin, verify, edge, api   ops/docker/app.Dockerfile, --build-arg APP=<image>
#   connector                           ops/docker/connector.Dockerfile
# Each is the `release` target, built by BuildKit through the docker CLI (no docker/* action) with
# no cache, SOURCE_DATE_EPOCH from the commit and rewritten timestamps, the OCI source label, and
# pushed to ghcr.io/<owner>/fin-next-<image> by digest (no tag). A missing Dockerfile, or an app
# whose server half is not on main yet, skips with a notice. Either way it writes one record,
# $RUNNER_TEMP/image-record/fin-next-<image>.json, which the manifest job reads, and sets the step
# outputs built, name, digest and record_sha256_<image>: the record's SHA-256, which release.yml
# makes a job output (one name per image, so the matrix legs' outputs combine) and the manifest
# job checks the downloaded record against, since any job of the run can replace an artefact.
#
# Inputs (environment): IMAGE, GH_TOKEN (the job's token, for the GHCR login only), and the
# runner's GITHUB_* variables.
set -euo pipefail

# BuildKit for the docker-container builder, by digest (moby/buildkit v0.35.0, the newest release
# older than three days on 21 Nov 2026). Moved by hand with the other pins in workflow files.
buildkit="moby/buildkit:v0.35.0@sha256:aa632b921ef07411d2cb77292cd34213d4f7b384001d6fceef1e1f25bf9752bb"

: "${IMAGE:?release-image: IMAGE is not set}"
: "${GH_TOKEN:?release-image: GH_TOKEN is not set}"
: "${GITHUB_SHA:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_REPOSITORY_OWNER:?}" "${GITHUB_ACTOR:?}"
: "${GITHUB_OUTPUT:?}" "${RUNNER_TEMP:?}"

started_ms="$(date +%s%3N)"
name="fin-next-${IMAGE}"
record_dir="${RUNNER_TEMP}/image-record"
record="${record_dir}/${name}.json"
mkdir -p "$record_dir"

record_output() {
  local hash
  hash="$(sha256sum "$record")"
  echo "record_sha256_${IMAGE}=${hash%% *}" >> "$GITHUB_OUTPUT"
}

skip() {
  echo "::notice title=${name}::$1; skipped"
  printf '{"image":"%s","built":false,"why":"%s"}\n' "$name" "$1" > "$record"
  record_output
  {
    echo "built=false"
    echo "name="
    echo "digest="
  } >> "$GITHUB_OUTPUT"
  echo "release.image name=${name} built=false ms=$(( $(date +%s%3N) - started_ms ))"
  exit 0
}

build_args=()
case "$IMAGE" in
  console | admin | verify | edge | api)
    dockerfile="ops/docker/app.Dockerfile"
    needs="apps/${IMAGE}/vite.server.config.ts"
    build_args=(--build-arg "APP=${IMAGE}")
    ;;
  connector)
    dockerfile="ops/docker/connector.Dockerfile"
    needs="apps/connector/package.json"
    ;;
  *)
    echo "release-image: unknown image ${IMAGE}" >&2
    exit 64
    ;;
esac

[ -f "$dockerfile" ] || skip "${dockerfile} is not on main yet"
[ -f "$needs" ] || skip "${needs} is not on main yet"

owner="$(printf '%s' "$GITHUB_REPOSITORY_OWNER" | tr '[:upper:]' '[:lower:]')"
ref="ghcr.io/${owner}/${name}"
source_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}"
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct HEAD)"
export SOURCE_DATE_EPOCH
meta="${RUNNER_TEMP}/buildx-${name}.json"
builder="fin-release-${IMAGE}"

# The GHCR login stays until the job's last step: actions/attest pushes the attestation to the
# registry with it, and release.yml logs out after that.
cleanup() {
  docker buildx rm --force "$builder" > /dev/null 2>&1 || true
}
trap cleanup EXIT

printf '%s' "$GH_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin > /dev/null
docker buildx create --name "$builder" --driver docker-container \
  --driver-opt "image=${buildkit}" --bootstrap > /dev/null

docker buildx build \
  --builder "$builder" \
  --file "$dockerfile" \
  --target release \
  "${build_args[@]}" \
  --build-arg SOURCE_DATE_EPOCH \
  --platform linux/amd64 \
  --no-cache \
  --pull \
  --provenance=false \
  --sbom=false \
  --label "org.opencontainers.image.source=${source_url}" \
  --label "org.opencontainers.image.revision=${GITHUB_SHA}" \
  --label "org.opencontainers.image.title=${name}" \
  --metadata-file "$meta" \
  --output "type=image,name=${ref},push-by-digest=true,name-canonical=true,push=true,oci-mediatypes=true,rewrite-timestamp=true" \
  .

digest="$(node -e 'const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(m["containerimage.digest"] ?? ""))' "$meta")"
if ! printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  echo "release-image: BuildKit gave no image digest for ${name}" >&2
  exit 1
fi

printf '{"image":"%s","built":true,"ref":"%s","digest":"%s"}\n' "$name" "$ref" "$digest" > "$record"
record_output
{
  echo "built=true"
  echo "name=${ref}"
  echo "digest=${digest}"
} >> "$GITHUB_OUTPUT"
echo "release.image name=${name} built=true digest=${digest} ms=$(( $(date +%s%3N) - started_ms ))"
