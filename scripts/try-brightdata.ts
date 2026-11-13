// Manual check: `npx tsx scripts/try-brightdata.ts` (live, spends Bright Data credit).
process.loadEnvFile(".env.local");
import { fetchMarkdown } from "../lib/server/fetch";

const URL_ = "https://www.mdpi.com/1424-8220/24/6/1935";
(async () => {
  const live = await fetchMarkdown(URL_, { live: true });
  console.log("live:", live.via, live.markdown.length, "chars", live.ms, "ms", "has 'Figure 1.':", live.markdown.includes("Figure 1."));
  // Forced timeout: a 1 ms budget makes the cached copy win while the Unlocker call finishes in the background (the process waits for it).
  process.env.ARC_LIVE_BUDGET_MS = "1";
  const fb = await fetchMarkdown(URL_, { live: true });
  console.log("forced timeout:", fb.via, fb.markdown.length, "chars", fb.ms, "ms");
})();
