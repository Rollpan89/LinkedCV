import { DEFAULT_MODEL, DEFAULT_FALLBACK_MODELS, FREE_GEMINI_MODELS, clearAnalysisCache, clearUsageCounter, extractDocId, getDoc, readSettings, summarizeTemplate, withDailyLimit, writeSettings } from "./shared.js";

const $ = id => document.getElementById(id);
async function load() {
  const settings = await readSettings();
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
  // Läs via readSettings så att en nyare synkad gräns för en annan modell inte
  // skrivs över av den lokala kopian när formuläret sparas.
  const existing = await readSettings();
  const dailyLimits = withDailyLimit(existing.dailyLimits, model, $("dailyLimit").value);
  const settings = { templateUrl: $("templateUrl").value.trim(), apiKey: $("apiKey").value.trim(), model, fallbackModels, allowUnsupportedSkills: $("allowUnsupportedSkills").checked, dailyLimits };
  if (settings.templateUrl && !/docs\.google\.com\/document\/d\//.test(settings.templateUrl)) {
    $("saveStatus").textContent = "Ange en giltig Google Docs-länk."; return;
  }
  await writeSettings(settings);
  $("saveStatus").textContent = "Inställningarna är sparade.";
});
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

$("checkTemplate").addEventListener("click", async () => {
  const output = $("templateCheck");
  output.hidden = false;
  output.textContent = "Hämtar mallen…";
  try {
    const doc = await getDoc(extractDocId($("templateUrl").value.trim()));
    const summary = summarizeTemplate(doc);
    const parts = [];
    if (summary.errors.length) {
      parts.push(`<p class="hint"><strong>Mallen kan inte användas:</strong><br>${summary.errors.map(escapeHtml).join("<br>")}</p>`);
    }
    parts.push(summary.sections.length
      ? `<p><strong>${summary.sections.length} taggade sektioner hittades:</strong> ${summary.sections.map(section => `<code>[${escapeHtml(section.tag)}]</code>`).join(" ")}</p>`
      : "<p><strong>Inga taggade sektioner hittades.</strong> Lägg till taggar enligt listan nedan.</p>");
    if (summary.missingHeadings.length) {
      parts.push(`<p class="hint">Rubriker som ser ut som sektioner men saknar taggar:</p><ul class="rules">${summary.missingHeadings.map(heading => `<li>${escapeHtml(heading.label)}: lägg <code>[${heading.tag}]</code> före texten och <code>[/${heading.tag}]</code> efter.</li>`).join("")}</ul>`);
      parts.push(`<p class="hint">Taggar får bara finnas i mallen. All text utanför taggarna lämnas orörd i den färdiga kopian.</p>`);
    }
    output.innerHTML = parts.join("");
  } catch (error) {
    output.textContent = error.message || String(error);
  }
});

$("clearAnalyses").addEventListener("click", async () => {
  await clearAnalysisCache();
  $("dataStatus").textContent = "De cachade kravanalyserna är rensade.";
});
$("clearUsage").addEventListener("click", async () => {
  await clearUsageCounter();
  $("dataStatus").textContent = "Anropsräknaren är nollställd.";
});
$("clearHistory").addEventListener("click", async () => {
  await chrome.storage.local.set({ history: [] });
  $("dataStatus").textContent = "Historiken är rensad.";
});

$("model").addEventListener("change", async () => {
  const settings = await readSettings();
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
