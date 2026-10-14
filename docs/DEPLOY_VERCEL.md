# Deploying the web app on Vercel

The Next.js app lives in `apps/web` of a pnpm workspace. The repo-root `package.json` has no `next`, so Vercel cannot auto-detect the framework from the root. Use one of these:

## Recommended: Root Directory = `apps/web`
1. Vercel -> Project -> Settings -> General -> **Root Directory**: `apps/web`.
2. Keep **Include source files outside of the Root Directory** ON (default; the pnpm lockfile and workspace packages live at the repo root).
3. Framework Preset shows **Next.js** (also forced by `apps/web/vercel.json`). Node.js Version: 22.x.
4. Production Branch: the branch that contains `apps/web` with `next` in its package.json (currently `integration/final`; `main` does not have it until the work is merged).
5. Environment variables: only public ones (`NEXT_PUBLIC_SITE_URL`). No secrets in the web project (INV-11).

## Alternative: deploy from the repo root
The root `vercel.json` forces `framework: nextjs` with `pnpm --filter @symbolon/web build` and `outputDirectory: apps/web/.next`. This is less reliable than the Root Directory setting; use it only if you cannot change the project settings.

## If it still says "no framework detected" / "No Next.js version detected"
- You are deploying a branch without `apps/web/package.json` containing `"next"` (check the branch in Settings -> Git).
- Root Directory is empty and the root `vercel.json` is not on that branch.
- Re-run with a clean build cache.

## Challenge origin (INV-16)
The public challenge is a separate Vercel project with its own domain, the `challenge` build profile and no production secrets. Do not reuse the production project.
