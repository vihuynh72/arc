const box = document.getElementById("origin");
chrome.storage.sync.get({ origin: "http://localhost:3000" }).then(({ origin }) => (box.value = origin));
document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.sync.set({ origin: box.value.trim() || "http://localhost:3000" });
  document.getElementById("saved").textContent = "Saved.";
});
