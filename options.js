const $ = id => document.getElementById(id);
async function load() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  $("templateUrl").value = settings.templateUrl || "https://docs.google.com/document/d/1GoyOIz18axvOWhtDIrsHuCVlwu5BkyPIGQdGGukg03Y/edit";
  $("apiKey").value = settings.apiKey || "";
  $("model").value = settings.model || "gemini-3.5-flash-lite";
}
$("save").addEventListener("click", async () => {
  const settings = { templateUrl: $("templateUrl").value.trim(), apiKey: $("apiKey").value.trim(), model: $("model").value };
  if (settings.templateUrl && !/docs\.google\.com\/document\/d\//.test(settings.templateUrl)) {
    $("saveStatus").textContent = "Ange en giltig Google Docs-länk."; return;
  }
  await chrome.storage.local.set({ settings });
  $("saveStatus").textContent = "Inställningarna är sparade.";
});
$("connectGoogle").addEventListener("click", async () => {
  try {
    const result = await chrome.identity.getAuthToken({ interactive: true });
    if (!result?.token) throw new Error("Google returnerade ingen åtkomsttoken.");
    $("googleStatus").textContent = "Google-kontot är anslutet.";
  } catch (error) {
    $("googleStatus").textContent = error.message || "Google-inloggningen misslyckades.";
  }
});
load();
