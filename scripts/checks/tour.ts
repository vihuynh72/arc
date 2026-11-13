// Offline: prepared figures never touch the network or Gemini.
import assert from "node:assert";
import { getTour } from "../../lib/server/tour";

export default async function check() {
  const lower = await getTour("https://mdpi-res.com/sensors/sensors-24-01935/article_deploy/html/images/sensors-24-01935-g001-550.jpg");
  assert.equal(lower?.stops.length, 6);
  assert.equal(lower?.image, "/fixtures/lower/figure-1280.jpg");
  const full = await getTour("https://mdpi-res.com/sensors/sensors-24-01935/article_deploy/html/images/sensors-24-01935-g001.png");
  assert.equal(full?.image, "/fixtures/lower/figure-1280.jpg");
  const mars = await getTour("https://mdpi-res.com/aerospace/aerospace-09-00604/article_deploy/html/images/aerospace-09-00604-g001-550.jpg");
  assert.equal(mars?.image, "/fixtures/mars/figure-1280.jpg");
  assert.ok(mars && mars.stops.length >= 5);
}
