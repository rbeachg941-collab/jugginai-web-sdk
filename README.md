# jugginai-web-sdk

Server-side wrappers for [Context.dev](https://docs.context.dev/sdks/typescript.md) and Bright Data (ISP proxy + Browser API). Secrets come from environment variables only.

- GitHub: https://github.com/rbeachg941-collab/jugginai-web-sdk
- GitLab: https://gitlab.com/alexablissislove-cell/jugginai-web-sdk

## Install

```bash
npm install
cp .env.example .env
# fill in values locally; never commit .env
npm test
npm run build
```

## Context.dev

```ts
import { scrapeMarkdown, searchWeb, retrieveBrand } from "jugginai-web-sdk";

const page = await scrapeMarkdown("https://example.com");
// page.markdown, page.creditsUsed, page.requestId

const results = await searchWeb("Stripe API authentication", { numResults: 10 });
const brand = await retrieveBrand({ type: "by_domain", domain: "stripe.com" });
```

Requires `CONTEXT_DEV_API_KEY`. Methods: `client.web.scrape`, `client.web.search`, `client.brand.retrieve`. The wrapper sets a 120s timeout and up to 2 retries on 408/429/5xx only (honors `Retry-After`). It does not retry validation errors, `USAGE_EXCEEDED`, or `NOT_FOUND` (including HTTP 400 `NOT_FOUND`).

## Bright Data

```ts
import { fetchViaIspProxy, withBrowser } from "jugginai-web-sdk";

const res = await fetchViaIspProxy("https://example.com", { country: "us", session: "job1" });
// res.status, res.body

const title = await withBrowser(async (browser) => {
  const page = await browser.newPage();
  await page.goto("https://example.com");
  return page.title();
});
```

Requires `BRD_ISP_PROXY_HOST`, `BRD_ISP_PROXY_PORT`, `BRD_ISP_PROXY_USER`, `BRD_ISP_PROXY_PASS` for the ISP proxy, and `BRD_BROWSER_WS` for `chromium.connectOverCDP`.

## Docs

See `.cursor/rules/context-dev.mdc` for endpoints and documentation links.
