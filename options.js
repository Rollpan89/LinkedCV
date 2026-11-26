import { DEFAULT_MODEL, DEFAULT_FALLBACK_MODELS, FREE_GEMINI_MODELS, clearAnalysisCache, clearUsageCounter, extractDocId, getDoc, readSettings, summarizeTemplate, withDailyLimit, writeSettings } from "./shared.js";

const $ = id => document.getElementById(id);

const allowedModels = () => new Set(FREE_GEMINI_MODELS.map(item => item.id));

function currentModel() {
  const allowed = allowedModels();
  return allowed.has($("model").value) ? $("model").value : DEFAULT_MODEL;
}

/** Reservmodeller som får användas: kända, inte samma som primär och utan dubbletter. */
function fallbackSelection() {
  const allowed = allowedModels();
  const model = currentModel();
  return [$("fallbackModel1").value, $("fallbackModel2").value]
    .filter((id, index, all) => allowed.has(id) && id !== model && all.indexOf(id) === index);
}

/**
 * Fälten sparas var för sig: ett fält som inte validerar skriver aldrig över det
 * sparade värdet och hindrar därför inte de andra fälten. patch() får bara det
 * fältets värde, så ett felaktigt fält kan inte smitta övriga inställningar.
 */
const FIELDS = {
  templateUrl: {
    status: "statusTemplateUrl",
    elements: ["templateUrl"],
    events: ["change", "blur"],
    read: () => $("templateUrl").value.trim(),
    validate: value => (!value || /docs\.google\.com\/document\/d\//.test(value) ? null : "Ange en giltig Google Docs-länk (https://docs.google.com/document/d/…)."),
    patch: value => ({ templateUrl: value })
  },
  apiKey: {
    status: "statusApiKey",
    elements: ["apiKey"],
    events: ["change", "blur"],
    read: () => $("apiKey").value.trim(),
    patch: value => ({ apiKey: value })
  },
  model: {
    elements: ["model"],
    events: ["change"],
    read: currentModel,
    patch: value => ({ model: value })
  },
  dailyLimit: {
    status: "statusDailyLimit",
    elements: ["dailyLimit"],
    events: ["change", "blur"],
    read: () => String($("dailyLimit").value).trim(),
    validate: value => {
      if (!value) return null;
      const number = Number(value);
      return Number.isInteger(number) && number >= 0 ? null : "Ange ett heltal, 0 eller högre.";
    },
    patch: (value, existing) => ({ dailyLimits: withDailyLimit(existing.dailyLimits, existing.model || DEFAULT_MODEL, value) })
  },
  fallbackModels: {
    status: "statusFallbackModels",
    elements: ["fallbackModel1", "fallbackModel2"],
    events: ["change"],
    read: fallbackSelection,
    patch: value => ({ fallbackModels: value })
  },
  allowUnsupportedSkills: {
    elements: ["allowUnsupportedSkills"],
    events: ["change"],
    read: () => $("allowUnsupportedSkills").checked,
    patch: value => ({ allowUnsupportedSkills: value })
  }
};

function showFieldStatus(field, message, isError = false) {
  const id = FIELDS[field]?.status;
  if (!id) return;
  const element = $(id);
  if (!element) return;
  element.hidden = !message;
  element.textContent = message || "";
  element.classList.toggle("error", Boolean(message) && isError);
}

async function saveField(field) {
  const spec = FIELDS[field];
  if (!spec) return true;
  const value = spec.read();
  const error = spec.validate ? spec.validate(value) : null;
  if (error) {
    showFieldStatus(field, error, true);
    return false;
  }
  try {
    const existing = await readSettings();
    await writeSettings({ ...existing, ...spec.patch(value, existing) });
    showFieldStatus(field, "Sparat.");
    await refreshOnboarding();
    return true;
  } catch (failure) {
    showFieldStatus(field, failure?.message || "Kunde inte spara fältet.", true);
    return false;
  }
}

const ONBOARDING_STEPS = [
  { id: "onboardingApiKey", done: settings => Boolean(settings.apiKey) },
  { id: "onboardingTemplate", done: settings => /docs\.google\.com\/document\/d\//.test(settings.templateUrl || "") },
  { id: "onboardingTemplateChecked", done: settings => Boolean(settings.templateVerifiedUrl) && settings.templateVerifiedUrl === settings.templateUrl },
  { id: "onboardingGoogle", done: settings => Boolean(settings.googleConnectedAt) }
];

/** Checklistan räknas fram från sparade inställningar, aldrig från osparade fältvärden. */
function renderOnboarding(settings) {
  let completed = 0;
  for (const step of ONBOARDING_STEPS) {
    const complete = Boolean(step.done(settings));
    if (complete) completed++;
    $(step.id).classList.toggle("done", complete);
  }
  $("onboardingProgress").textContent = `${completed} av ${ONBOARDING_STEPS.length} steg klara`;
  $("onboardingDone").hidden = completed < ONBOARDING_STEPS.length;
}

async function refreshOnboarding() {
  renderOnboarding(await readSettings());
}

async function remember(patch) {
  await writeSettings({ ...(await readSettings()), ...patch });
  await refreshOnboarding();
}

async function load() {
  const settings = await readSettings();
  $("templateUrl").value = settings.templateUrl || "";
  $("apiKey").value = settings.apiKey || "";
  $("allowUnsupportedSkills").checked = Boolean(settings.allowUnsupportedSkills);
  const allowed = allowedModels();
  $("model").value = allowed.has(settings.model) ? settings.model : DEFAULT_MODEL;
  $("dailyLimit").value = settings.dailyLimits?.[$("model").value] || "";
  const fallbacks = Array.isArray(settings.fallbackModels) ? settings.fallbackModels : DEFAULT_FALLBACK_MODELS;
  $("fallbackModel1").value = allowed.has(fallbacks[0]) ? fallbacks[0] : "";
  $("fallbackModel2").value = allowed.has(fallbacks[1]) ? fallbacks[1] : "";
  for (const field of Object.keys(FIELDS)) showFieldStatus(field, "");
  renderOnboarding(settings);
}

$("save").addEventListener("click", async () => {
  // Fälten sparas i tur och ordning: varje fält läser och skriver samma
  // inställningsobjekt, så samtidiga skrivningar skulle kunna skriva över varandra.
  let failed = 0;
  for (const field of Object.keys(FIELDS)) {
    if (!(await saveField(field))) failed++;
  }
  $("saveStatus").textContent = failed
    ? "Rätta fälten som är markerade – de övriga inställningarna sparades."
    : "Inställningarna är sparade.";
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
    // En lyckad kontroll sparar länken och kvitterar steget i checklistan. Länken
    // har precis använts mot Docs-API:t och är därför verifierad.
    if (!summary.errors.length) {
      const checkedUrl = $("templateUrl").value.trim();
      await remember({ templateUrl: checkedUrl, templateVerifiedUrl: checkedUrl });
    }
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
    await remember({ googleConnectedAt: new Date().toISOString() });
  } catch (error) {
    $("googleStatus").textContent = error.message || "Google-inloggningen misslyckades.";
  }
});

for (const [field, spec] of Object.entries(FIELDS)) {
  for (const id of spec.elements) {
    for (const type of spec.events) $(id).addEventListener(type, () => saveField(field));
  }
}

load();
