/**
 * One live Context.dev scrape. Reads CONTEXT_DEV_API_KEY from the environment.
 * Does not print secrets.
 */
import { scrapeMarkdown } from "../src/contextdev.js";

const result = await scrapeMarkdown("https://example.com");
const preview = result.markdown.replace(/\s+/g, " ").trim().slice(0, 100);
process.stdout.write(
  `scrape https://example.com | creditsUsed=${result.creditsUsed ?? "unknown"} | preview=${preview}\n`,
);
