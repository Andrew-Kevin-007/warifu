# Kernel service image (Railway / Fly / any container host). Build from the REPO ROOT:
#   docker build -f services/kernel/Dockerfile -t warifu-kernel .
# Runs the TypeScript sources directly on Node 22 (type stripping + the repo's resolve hook); no build step, no tsx.
# Secrets come only from the host's environment variables (docs/OPERATOR_SETUP.md); none are baked into the image.
# VERIFY: not built locally (no Docker on the dev machine). Pin the base image by digest once the first build passes.
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@symbolon/kernel-service..." \
 && useradd --system --uid 10001 kernel \
 && mkdir -p /data/blobs && chown kernel /data/blobs
USER kernel
EXPOSE 8787
# Migrations are a separate one-off command (pnpm kernel:migrate -- --profile <p>), never run on every boot.
CMD ["node", "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", "./packages/blast-radius/scripts/register-ts.mjs", "services/kernel/src/main.ts"]
