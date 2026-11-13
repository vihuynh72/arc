// Runs every scripts/checks/*.ts. Each default-exports a function that throws on failure.
import { readdirSync } from "node:fs";
import { join } from "node:path";

(async () => {
  const dir = join(__dirname, "checks");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
    await (await import(join(dir, f))).default();
    console.log(`ok ${f}`);
  }
  console.log("selfcheck ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
