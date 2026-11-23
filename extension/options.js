import { DEFAULT_ARC, allowedSites, originPattern } from "./rules.js";

const box = document.getElementById("origin");
chrome.storage.sync.get({ origin: DEFAULT_ARC }).then(({ origin }) => (box.value = origin));
document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.sync.set({ origin: box.value.trim() || DEFAULT_ARC });
  document.getElementById("saved").textContent = "Saved.";
});

async function list() {
  const { origins = [] } = await chrome.permissions.getAll();
  const sites = allowedSites(origins);
  const ul = document.getElementById("sites");
  ul.replaceChildren(
    ...sites.map((site) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Remove";
      b.setAttribute("aria-label", `Remove ${new URL(site).host}`);
      b.addEventListener("click", async () => {
        await chrome.permissions.remove({ origins: [originPattern(site)] });
        document.getElementById("removed").textContent = `Removed ${new URL(site).host}.`;
        await list();
        (ul.querySelector("button") ?? box).focus();
      });
      li.append(`${new URL(site).host} `, b);
      return li;
    }),
  );
  document.getElementById("none").hidden = sites.length > 0;
}
void list();
