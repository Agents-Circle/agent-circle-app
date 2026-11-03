This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Regenerating the lockfile

**Use npm 11.19 or newer** (`engines` says so, advisorily). Older npm writes a
`package-lock.json` that is missing the bundled peer dependencies of the wasm32 optional
packages — `@emnapi/core` and `@emnapi/runtime`, under `@tailwindcss/oxide-wasm32-wasi`
and `@unrs/resolver-binding-wasm32-wasi`. The install succeeds on macOS and `npm ci`
then fails on Linux with:

```
npm error Missing: @emnapi/runtime@1.11.3 from lock file
```

Which is a CI-only failure produced by a developer machine, and it cost a red build to
find. If you are on an older npm and have to touch the lockfile, generate it in a
container instead:

```bash
docker run --rm -v "$PWD:/w" -w /w --user "$(id -u):$(id -g)" \
  -e npm_config_cache=/tmp/npm node:24 npm install --package-lock-only
```
