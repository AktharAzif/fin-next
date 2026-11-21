# The Fin Node images: fin-next-edge, -api, -payments, -console, -admin and -verify (spec 01 §4.9;
# ARCHITECTURE §3.5; [SA-38]). One Dockerfile, ARG APP, two targets built from the same sources:
#   release  the only target pushed to GHCR, attested and deployed; it holds no seam, and its bundle
#            (built with FIN_BUILD_TARGET=release) exits 78 when any FIN_SEAM_* variable is set;
#   test     the bundle built with FIN_BUILD_TARGET=test, for CI's journeys; it refuses to start
#            when FIN_ENVIRONMENT is staging or production.
# CI builds it from the repository root (this machine has no Docker):
#   docker build -f ops/docker/app.Dockerfile --build-arg APP=console --target release .
# Node is PID 1: the distroless image's entrypoint is node, and the exec-form CMD carries the flags.
# No NODE_OPTIONS, no shell, no package manager and no node_modules in either run image: the server
# is one Vite SSR bundle with its map beside it, unserved (S0-13). Beside it, read-only, are the
# database's files from every package (bootstrap, migrations, grants) at FIN_DB_ASSETS_DIR, which
# the api image's `migrate` service reads: exactly the set packages/db/src/assets.ts finds in the
# source tree, laid out as there.

# ---- deps: the pinned build image, pnpm from its release asset by checksum, the workspace installed
FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS deps
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV TURBO_TELEMETRY_DISABLED=1 \
    CI=1
WORKDIR /src
# pnpm 12.21.0, the linux-x64 release asset checked against its SHA-256 (spec 01 §4.1): never
# Corepack, never npm i -g. The asset's name and layout (a tarball holding `pnpm` and `dist/`, as the
# other platforms' assets do) are confirmed by CI's first image build.
ADD --checksum=sha256:84c4773bcf4a217f4083cd7b2a91e4cee6103cf42426c1282ef37d308f55a410 \
    https://github.com/pnpm/pnpm/releases/download/v12.21.0/pnpm-linux-x64.tar.gz /tmp/pnpm.tar.gz
RUN mkdir -p /opt/pnpm \
    && tar -xzf /tmp/pnpm.tar.gz -C /opt/pnpm \
    && rm /tmp/pnpm.tar.gz \
    && ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm \
    && test "$(pnpm --version)" = "12.21.0"
# The lockfile alone fetches every package under the workspace's supply-chain policy; the sources
# come after, so a source change does not refetch.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile

# ---- the database's files: every package's bootstrap, migrations and grants, by assets.ts's rule
FROM deps AS db-assets
RUN node packages/db/src/assets-cli.ts stage /out/db-assets

# ---- the two bundles
FROM deps AS build-release
ARG APP
RUN test -n "${APP}" \
    && test -f "apps/${APP}/vite.server.config.ts" \
    && FIN_BUILD_TARGET=release pnpm --filter "@fin/${APP}" run build:server \
    && test -f "apps/${APP}/dist/server/main.js"

FROM deps AS build-test
ARG APP
RUN test -n "${APP}" \
    && FIN_BUILD_TARGET=test pnpm --filter "@fin/${APP}" run build:server \
    && test -f "apps/${APP}/dist/server/main.js"

# ---- test: the seams, for CI only (packages/testing's harness joins it when that package lands)
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:1d736cf8b5716c07a245301f92717143215d248fd55771ee1936ef4b3302e531 AS test
ARG APP
WORKDIR /app
COPY --from=build-test /src/apps/${APP}/dist/server/ /app/dist/
COPY --from=db-assets /out/db-assets/ /app/db-assets/
ENV FIN_CONTAINER=1 \
    FIN_DB_ASSETS_DIR=/app/db-assets
USER nonroot
EXPOSE 8080
CMD ["--max-old-space-size-percentage=70", "--disable-proto=throw", "--enable-source-maps", "dist/main.js"]

# ---- release: the image that deploys (last, so it is also the default target)
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:1d736cf8b5716c07a245301f92717143215d248fd55771ee1936ef4b3302e531 AS release
ARG APP
WORKDIR /app
COPY --from=build-release /src/apps/${APP}/dist/server/ /app/dist/
COPY --from=db-assets /out/db-assets/ /app/db-assets/
ENV FIN_CONTAINER=1 \
    FIN_DB_ASSETS_DIR=/app/db-assets
USER nonroot
EXPOSE 8080
CMD ["--max-old-space-size-percentage=70", "--disable-proto=throw", "--enable-source-maps", "dist/main.js"]
