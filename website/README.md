# Website

This folder is a standalone static site for `openorcha.com`.

It is intentionally isolated from the local orchestration app in `public/` so you can deploy it separately with a static host.

## Deploy

### Cloudflare Pages

- Framework preset: `None`
- Build command: leave empty
- Build output directory: `website`

### GitHub Pages

Publish the contents of this folder with either:

- a GitHub Actions workflow that deploys `website/`, or
- a dedicated branch whose root is the contents of this folder.

No build step is required.
