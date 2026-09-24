# Builds and runs pi-ui in --remote mode for a container host (VPS, home server). See
# ../docs/remote.md for the full deployment guide, including the Tailscale/Cloudflare/Caddy
# choices for reaching this container from your devices.
#
# The build context is the repo root, not this deploy/ directory (the build stage needs
# the whole source tree):
#
#   docker build -f deploy/Dockerfile -t pi-ui .
#   docker run -d --name pi-ui --restart unless-stopped \
#     -p 31415:31415 \
#     -e PI_UI_AUTH_TOKEN=<a long random token> \
#     -v pi-ui-agent:/root/.pi \
#     -v pi-ui-workspace:/workspace \
#     pi-ui
#
# pi-ui runs bash and writes files as this container's user by design — that's the whole
# point of a coding agent (see ../docs/remote.md "Security"). The container isolates the
# *host* from the agent, not the agent from itself: a leaked PI_UI_AUTH_TOKEN is still a
# full shell inside this container. Put the token, and any provider credentials you mount
# or set as env vars, behind that isolation, not the other way round.
#
# Volumes:
#   /root/.pi   pi's sessions, credentials (auth.json), settings and extensions — this is
#               the durable state; back it up (see ../docs/remote.md "Persistence").
#   /workspace  the git checkout(s) pi-ui works in. Clone your repo into it once with
#               `docker run --rm -v pi-ui-workspace:/workspace --entrypoint git pi-ui \
#               clone <url> .` or `docker exec` into the running container.

FROM oven/bun:1.4.2 AS build
WORKDIR /repo
COPY package.json bun.lock ./
RUN bun ci
COPY . .
RUN bun run assets:build && bun scripts/build.ts --target=bun-linux-x64

FROM debian:bookworm-slim
RUN apt-get update && apt-get install --no-install-recommends -y \
		ca-certificates git fd-find ripgrep \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=build /repo/dist/pi-ui-bun-linux-x64 /usr/local/bin/pi-ui

# 0.0.0.0 so `docker run -p` can reach it (a loopback bind is invisible to docker's own
# port forwarding); --remote skips host-desktop side effects that have no meaning in a
# container (opening a browser, OS notifications). Publish this container's port to a
# tailnet/VPN interface on the host, not the public one — see ../docs/remote.md.
ENV PI_UI_HOST=0.0.0.0
ENV PI_UI_REMOTE=1

WORKDIR /workspace
EXPOSE 31415
ENTRYPOINT ["pi-ui"]
