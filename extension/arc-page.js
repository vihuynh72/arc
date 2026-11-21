// Runs only on Arc's own pages (manifest content_scripts). It tells Arc that the helper is installed and its id, so Arc can
// message it (lib/client/helper.ts). It reads nothing and sends nothing.
document.documentElement.dataset.arcHelper = chrome.runtime.id;
