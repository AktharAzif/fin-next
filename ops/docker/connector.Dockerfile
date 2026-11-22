# fin-next-connector (spec 01 §4.9, §7.3; ARCHITECTURE §5.4; [FD-13]): cloudflared 2026.11.1 copied
# from its official image by digest, and the connector supervisor bundle, on the distroless Node run
# image. The supervisor is Node with no third-party dependency; it renders cloudflared's
# configuration from apps/connector/src/map.ts at start and runs cloudflared with TUNNEL_TOKEN in
# the child's environment only. Dependabot watches the digests; a new cloudflared is a reviewed
# change. CI builds it from the repository root (this machine has no Docker):
#   docker build -f ops/docker/connector.Dockerfile --target release .

FROM cloudflare/cloudflared:2026.11.1@sha256:e613aadbc2d9511785d2e67a86b0c8ac18dd63a3f9af0d06faf04cbfdcb35f2d AS cloudflared

# ---- deps: as app.Dockerfile's
FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS deps
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV TURBO_TELEMETRY_DISABLED=1 \
    CI=1
WORKDIR /src
ADD --checksum=sha256:84c4773bcf4a217f4083cd7b2a91e4cee6103cf42426c1282ef37d308f55a410 \
    https://github.com/pnpm/pnpm/releases/download/v12.21.0/pnpm-linux-x64.tar.gz /tmp/pnpm.tar.gz
RUN mkdir -p /opt/pnpm \
    && tar -xzf /tmp/pnpm.tar.gz -C /opt/pnpm \
    && rm /tmp/pnpm.tar.gz \
    && ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm \
    && test "$(pnpm --version)" = "12.21.0"
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile

# ---- the supervisor bundle, its output scanned for the test harness's markers right after the
# build over exactly what the release stage copies, as app.Dockerfile's (harness-scan.mjs)
FROM deps AS build
RUN FIN_BUILD_TARGET=release pnpm --filter @fin/connector run build \
    && node ops/docker/harness-scan.mjs apps/connector/dist/server \
    && test -f apps/connector/dist/server/main.js

# ---- release
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:1d736cf8b5716c07a245301f92717143215d248fd55771ee1936ef4b3302e531 AS release
# The official image installs the binary at /usr/local/bin/cloudflared; CI's build confirms the path.
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
WORKDIR /app
COPY --from=build /src/apps/connector/dist/server/ /app/dist/
ENV FIN_CONTAINER=1 \
    FIN_CLOUDFLARED_PATH=/usr/local/bin/cloudflared
USER nonroot
EXPOSE 8080
CMD ["--max-old-space-size-percentage=70", "--disable-proto=throw", "--enable-source-maps", "dist/main.js"]
