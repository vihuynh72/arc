// The one-time question per site. chrome.permissions.request needs this click (or Enter on the focused button): a real user
// gesture on the extension's own page, never something a web page can trigger alone.
import { originPattern, refuseUrl } from "./rules.js";

const origin = new URLSearchParams(location.search).get("origin") ?? "";
const ok = !refuseUrl(origin) && new URL(origin).origin === origin;
const status = document.getElementById("status");
const allow = document.getElementById("allow");

if (!ok) {
  document.getElementById("q").textContent = "Arc cannot read that address.";
  allow.disabled = true;
} else {
  document.getElementById("site").textContent = new URL(origin).host;
  document.title = `Allow Arc to read ${new URL(origin).host}?`;
}
allow.focus();

const answer = async (granted) => {
  await chrome.runtime.sendMessage({ type: "consent", origin, granted }).catch(() => {});
  window.close();
};
allow.addEventListener("click", async () => {
  status.textContent = "Your browser will now ask you to confirm.";
  const granted = await chrome.permissions.request({ origins: [originPattern(origin)] }).catch(() => false);
  status.textContent = granted ? "Allowed. Going back to Arc." : "Not allowed.";
  await answer(granted);
});
document.getElementById("no").addEventListener("click", () => void answer(false));
document.addEventListener("keydown", (e) => e.key === "Escape" && void answer(false));
