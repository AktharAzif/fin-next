#!/usr/bin/env bash
# One release image (spec 01 §4.9, §5.5; ARCHITECTURE §11.7; orchestrator decision BD-05). A control
# path, run by release.yml's images job for one IMAGE at a time:
#   console, admin, verify, edge, api   ops/docker/app.Dockerfile, --build-arg APP=<image>
#   connector                           ops/docker/connector.Dockerfile
# Each is the `release` target, built by BuildKit through the docker CLI (no docker/* action) with
# no cache, SOURCE_DATE_EPOCH from the commit and rewritten timestamps, the OCI source label, and
# pushed to ghcr.io/<owner>/fin-next-<image> by digest (no tag). spec 01 §4.9's fin-next-payments
# and fin-next-backup are not in the matrix: this release does not build them yet, and the script
# refuses any image it does not name.
#
# Every image of the matrix is required (the steward's ruling of 22 Nov). A missing Dockerfile, a
# missing build input, a failed build or a build that gives no digest fails this leg with an error
# naming the image and what is missing; it never skips. The images job then fails, the manifest
# job (which needs it) never runs, and the release has no manifest, so a release that lacks an
# image is refused here rather than at deploy time by the operator's start condition.
#
# A built image writes one record, $RUNNER_TEMP/image-record/fin-next-<image>.json, which the
# manifest job reads, and sets the step outputs name, digest and record_sha256_<image>: the
# record's SHA-256, which release.yml makes a job output (one name per image, so the matrix legs'
# outputs combine) and the manifest job checks the downloaded record against, since any job of the
# run can replace an artefact.
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

# Ends the leg without its image: an error naming the image and what is missing, and no record or
# output, so nothing downstream can take this release for one that has every image.
fail() {
  echo "::error title=${name}::${name} is not built: $1 (every image of the matrix is required)"
  echo "release.image name=${name} result=fail ms=$(( $(date +%s%3N) - started_ms ))"
  exit 1
}

# The build arguments are never empty: bash before 4.4 calls an empty array unbound under set -u.
case "$IMAGE" in
  console | admin | verify | edge | api)
    dockerfile="ops/docker/app.Dockerfile"
    needs="apps/${IMAGE}/vite.server.config.ts"
    build_args=(--build-arg "APP=${IMAGE}" --build-arg SOURCE_DATE_EPOCH)
    ;;
  connector)
    dockerfile="ops/docker/connector.Dockerfile"
    needs="apps/connector/package.json"
    build_args=(--build-arg SOURCE_DATE_EPOCH)
    ;;
  *)
    echo "::error title=release-image::${name} is not a release image of release.yml's matrix"
    exit 64
    ;;
esac

[ -f "$dockerfile" ] || fail "its Dockerfile ${dockerfile} is missing"
[ -f "$needs" ] || fail "its build input ${needs} is missing"

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

rm -f "$meta"
if ! docker buildx build \
  --builder "$builder" \
  --file "$dockerfile" \
  --target release \
  "${build_args[@]}" \
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
  .; then
  fail "the BuildKit build of ${dockerfile} failed"
fi

[ -s "$meta" ] || fail "BuildKit wrote no metadata file, so there is no image digest"
digest="$(node -e 'const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(m["containerimage.digest"] ?? ""))' "$meta")" \
  || fail "BuildKit's metadata file is not JSON, so there is no image digest"
if ! printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  fail "BuildKit gave no image digest"
fi

mkdir -p "$record_dir"
printf '{"image":"%s","built":true,"ref":"%s","digest":"%s"}\n' "$name" "$ref" "$digest" > "$record"
hash="$(sha256sum "$record")"
{
  echo "name=${ref}"
  echo "digest=${digest}"
  echo "record_sha256_${IMAGE}=${hash%% *}"
} >> "$GITHUB_OUTPUT"
echo "release.image name=${name} built=true digest=${digest} ms=$(( $(date +%s%3N) - started_ms ))"
