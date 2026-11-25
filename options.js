import { DEFAULT_MODEL, DEFAULT_FALLBACK_MODELS, FREE_GEMINI_MODELS } from "./shared.js";

const $ = id => document.getElementById(id);
async function load() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  $("templateUrl").value = settings.templateUrl || "";
  $("apiKey").value = settings.apiKey || "";
  $("allowUnsupportedSkills").checked = Boolean(settings.allowUnsupportedSkills);
  const allowed = new Set(FREE_GEMINI_MODELS.map(item => item.id));
  $("model").value = allowed.has(settings.model) ? settings.model : DEFAULT_MODEL;
  $("dailyLimit").value = settings.dailyLimits?.[$("model").value] || "";
  const fallbacks = Array.isArray(settings.fallbackModels) ? settings.fallbackModels : DEFAULT_FALLBACK_MODELS;
  $("fallbackModel1").value = allowed.has(fallbacks[0]) ? fallbacks[0] : "";
  $("fallbackModel2").value = allowed.has(fallbacks[1]) ? fallbacks[1] : "";
}
$("save").addEventListener("click", async () => {
  const allowed = new Set(FREE_GEMINI_MODELS.map(item => item.id));
  const model = allowed.has($("model").value) ? $("model").value : DEFAULT_MODEL;
  const fallbackModels = [$("fallbackModel1").value, $("fallbackModel2").value]
    .filter((id, index, all) => allowed.has(id) && id !== model && all.indexOf(id) === index);
  const { settings: existing = {} } = await chrome.storage.local.get("settings");
  const dailyLimits = { ...(existing.dailyLimits || {}) };
  const limit = Math.floor(Number($("dailyLimit").value));
  if (Number.isFinite(limit) && limit > 0) dailyLimits[model] = limit;
  else delete dailyLimits[model];
  const settings = { templateUrl: $("templateUrl").value.trim(), apiKey: $("apiKey").value.trim(), model, fallbackModels, allowUnsupportedSkills: $("allowUnsupportedSkills").checked, dailyLimits };
  if (settings.templateUrl && !/docs\.google\.com\/document\/d\//.test(settings.templateUrl)) {
    $("saveStatus").textContent = "Ange en giltig Google Docs-länk."; return;
  }
  await chrome.storage.local.set({ settings });
  $("saveStatus").textContent = "Inställningarna är sparade.";
});
$("model").addEventListener("change", async () => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  $("dailyLimit").value = settings.dailyLimits?.[$("model").value] || "";
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
