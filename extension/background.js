// Arc extension: on the toolbar button or Alt+Shift+A, send the open tab's HTML to the Arc server the user set
// (default http://localhost:3000) and open the twin. Nothing is sent anywhere else.
const MAX = 3.5 * 1024 * 1024;

chrome.action.onClicked.addListener(async (tab) => {
  const { origin } = await chrome.storage.sync.get({ origin: "http://localhost:3000" });
  const arc = origin.replace(/\/+$/, "");
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (max) => ({ url: location.href, title: document.title, html: document.documentElement.outerHTML.slice(0, max) }),
      args: [MAX],
    });
    const res = await fetch(`${arc}/api/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result) });
    if (!res.ok) throw new Error(`Arc answered ${res.status}`);
    const { id } = await res.json();
    await chrome.tabs.create({ url: `${arc}/?doc=${id}` });
  } catch (e) {
    console.warn("Arc: could not send the page, opening it by link instead.", e);
    await chrome.tabs.create({ url: `${arc}/?url=${encodeURIComponent(tab.url ?? "")}` });
  }
});
