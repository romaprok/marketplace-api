# syntax=docker/dockerfile:1.10
# Production image of the course API (hw-28). Build: npm run image:build.
#
# Two stages. Dependencies are installed where there is a shell and npm; the
# runtime is distroless: node and nothing else, no sh, no package manager.
# That is the point of distroless here, not the size: after an RCE there is
# no shell to land in.

FROM node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# a scoped private registry that needs a token; the public registry doesn't
COPY docker/npmrc ./.npmrc
# The token lives only for this RUN: a mounted file under /run/secrets.
# An ARG would end up in the image history, COPY + rm in the bytes of a layer.
RUN --mount=type=secret,id=npm_token,required=true \
    NPM_TOKEN="$(cat /run/secrets/npm_token)" npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:8ad9cc935b7843c4024b7e1487b5ef472c354ea847b97c667023e2618552607e
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY openapi ./openapi
COPY src ./src
# numeric, not "nonroot": kubelet can't resolve a name when it checks runAsNonRoot
USER 65532:65532
EXPOSE 3000
# the distroless entrypoint is node itself
CMD ["src/server.js"]
