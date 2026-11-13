// Arc extension: on the toolbar button or Alt+Shift+A, send the open tab's HTML to the Arc server the user set
// (default http://localhost:3000) and open the twin. Nothing is sent anywhere else.
// Failures show in chrome://extensions under this extension's "service worker" link.
const MAX = 3.5 * 1024 * 1024;
const busy = new Set(); // tabs being sent now: a second press while the first is in flight opens nothing more

chrome.action.onClicked.addListener(async (tab) => {
  if (busy.has(tab.id)) return;
  const { origin } = await chrome.storage.sync.get({ origin: "http://localhost:3000" });
  const arc = origin.replace(/\/+$/, "");
  if (tab.url?.startsWith(`${arc}/`)) return; // a second press lands on the Arc tab the first one opened
  busy.add(tab.id);
  try {
    let result;
    try {
      [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (max) => ({ url: location.href, title: document.title, html: document.documentElement.outerHTML.slice(0, max) }),
        args: [MAX],
      });
    } catch (e) {
      // chrome:// pages, the Web Store, the New Tab page and the PDF viewer cannot be read by any extension.
      console.warn("Arc: Chrome did not let the extension read this tab.", tab.url, e);
      return void (await chrome.tabs.create({ url: `${arc}/?notice=restricted` }));
    }
    try {
      const res = await fetch(`${arc}/api/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result) });
      if (!res.ok) throw new Error(`Arc answered ${res.status}`);
      const { id } = await res.json();
      await chrome.tabs.create({ url: `${arc}/?doc=${id}` });
    } catch (e) {
      console.warn(`Arc: could not send the page to ${arc}, opening it by link instead.`, e);
      await chrome.tabs.create({ url: `${arc}/?url=${encodeURIComponent(result?.url ?? tab.url ?? "")}` });
    }
  } finally {
    busy.delete(tab.id);
  }
});
