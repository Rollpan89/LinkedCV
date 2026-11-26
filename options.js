import { DEFAULT_LANGUAGE, DEFAULT_MODEL, DEFAULT_FALLBACK_MODELS, FREE_GEMINI_MODELS, HISTORY_LIMIT, HISTORY_MAX_AGE_DAYS, LANGUAGES, clearAnalysisCache, clearUsageCounter, escapeHtml, extractDocId, getDoc, pruneHistory, readSettings, resolveTemplates, summarizeTemplate, withDailyLimit, writeSettings } from "./shared.js";

const $ = id => document.getElementById(id);

const MODEL_IDS = new Set(FREE_GEMINI_MODELS.map(item => item.id));
const DOCS_URL = /docs\.google\.com\/document\/d\//;

function currentModel() {
  return MODEL_IDS.has($("model").value) ? $("model").value : DEFAULT_MODEL;
}

/** Reservmodeller som får användas: kända, inte samma som primär och utan dubbletter. */
function fallbackSelection() {
  const model = currentModel();
  return [$("fallbackModel1").value, $("fallbackModel2").value]
    .filter((id, index, all) => MODEL_IDS.has(id) && id !== model && all.indexOf(id) === index);
}

/**
 * Reservleverantörens adress är okänd i förväg. Behörigheten begärs därför först när
 * adressen sparas, i stället för att tillägget ber om åtkomst till alla sidor direkt.
 */
async function requestHostPermission(value) {
  if (!value) return true;
  try {
    const origin = `${new URL(value).origin}/*`;
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

/** Textfält som sparas både när det ändras och när det lämnas. */
const textField = (id, extra = {}) => ({
  elements: [id],
  events: ["change", "blur"],
  read: () => String($(id).value).trim(),
  ...extra
});

/**
 * Fälten sparas var för sig: ett fält som inte validerar skriver aldrig över det
 * sparade värdet och hindrar därför inte de andra fälten. patch() får bara det
 * fältets värde, så ett felaktigt fält inte kan smitta övriga inställningar.
 */
const FIELDS = {
  apiKey: textField("apiKey", { status: "statusApiKey", patch: value => ({ apiKey: value }) }),
  model: { elements: ["model"], events: ["change"], read: currentModel, patch: value => ({ model: value }) },
  language: {
    elements: ["language"],
    events: ["change"],
    read: () => (LANGUAGES.includes($("language").value) ? $("language").value : DEFAULT_LANGUAGE),
    patch: value => ({ language: value })
  },
  dailyLimit: textField("dailyLimit", {
    status: "statusDailyLimit",
    validate: value => {
      if (!value) return null;
      const number = Number(value);
      return Number.isInteger(number) && number >= 0 ? null : "Ange ett heltal, 0 eller högre.";
    },
    patch: (value, settings) => ({ dailyLimits: withDailyLimit(settings.dailyLimits, settings.model || DEFAULT_MODEL, value) })
  }),
  fallbackModels: {
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
  },
  backupBaseUrl: textField("backupBaseUrl", {
    status: "statusBackup",
    validate: value => {
      if (!value) return null;
      try {
        return new URL(value).protocol === "https:" ? null : "Adressen måste börja med https://.";
      } catch {
        return "Ange en giltig https-adress, till exempel https://api.openai.com/v1.";
      }
    },
    patch: value => ({ backupBaseUrl: value })
  }),
  backupModel: textField("backupModel", { status: "statusBackup", patch: value => ({ backupModel: value }) }),
  backupApiKey: textField("backupApiKey", { status: "statusBackup", patch: value => ({ backupApiKey: value }) })
};

const ONBOARDING_STEPS = [
  { id: "onboardingApiKey", done: settings => Boolean(settings.apiKey) },
  { id: "onboardingTemplate", done: settings => resolveTemplates(settings).length > 0 },
  {
    id: "onboardingTemplateChecked",
    done: settings => {
      const urls = resolveTemplates(settings).map(template => template.url);
      const verified = Array.isArray(settings.verifiedTemplateUrls) ? settings.verifiedTemplateUrls : [];
      return urls.length > 0 && urls.every(url => verified.includes(url));
    }
  },
  { id: "onboardingGoogle", done: settings => Boolean(settings.googleConnectedAt) }
];

function showStatus(id, message, isError = false) {
  const element = $(id);
  element.hidden = !message;
  element.textContent = message || "";
  element.classList.toggle("error", Boolean(message) && isError);
}

function renderTemplateList(templates) {
  $("templateList").innerHTML = templates.length
    ? templates.map(template => `<li><span class="template-name">${escapeHtml(template.name)}</span><code class="template-url">${escapeHtml(template.url)}</code><button type="button" class="link-button" data-remove-template="${escapeHtml(template.url)}">Ta bort</button></li>`).join("")
    : `<li class="hint">Inga mallar tillagda än.</li>`;
}

/** Alla modellers sparade dygnsgränser, så att de syns utan att byta modell. */
function renderDailyLimits(settings) {
  const parts = FREE_GEMINI_MODELS.map(model => `${model.label}: ${settings.dailyLimits?.[model.id] || "okänd"}`);
  $("dailyLimitsSummary").textContent = `Sparade dygnsgränser – ${parts.join(" · ")}`;
}

/** Checklistan räknas fram från sparade inställningar, aldrig från osparade fältvärden. */
function renderOnboarding(settings) {
  let completed = 0;
  for (const step of ONBOARDING_STEPS) {
    const complete = Boolean(step.done(settings));
    if (complete) completed++;
    $(step.id).classList.toggle("done", complete);
  }
  $("onboardingProgress").textContent = completed === ONBOARDING_STEPS.length
    ? "Alla steg klara – öppna en LinkedIn-annons och välj Anpassa till CV i högerklicksmenyn."
    : `${completed} av ${ONBOARDING_STEPS.length} steg klara`;
}

function renderSettings(settings) {
  renderTemplateList(resolveTemplates(settings));
  renderDailyLimits(settings);
  renderOnboarding(settings);
}

/** Gallrar den sparade historiken vid inläsning och visar hur mycket som finns kvar. */
async function loadHistory() {
  let stored = [];
  try {
    ({ history: stored = [] } = await chrome.storage.local.get("history"));
  } catch {
    stored = [];
  }
  const kept = pruneHistory(Array.isArray(stored) ? stored : []);
  const removed = (Array.isArray(stored) ? stored.length : 0) - kept.length;
  if (removed > 0) await chrome.storage.local.set({ history: kept });
  $("historySummary").textContent = kept.length
    ? `${kept.length} CV i historiken. Poster äldre än ${HISTORY_MAX_AGE_DAYS} dagar och allt utöver ${HISTORY_LIMIT} tas bort automatiskt.${removed > 0 ? ` ${removed} gamla poster gallrades nu.` : ""}`
    : "Historiken är tom. När du skapar ett CV sparas det här, och poster gallras automatiskt efter 180 dagar.";
}

/** Sparar en ändring och ritar om allt som beror av inställningarna. */
async function saveSettings(build) {
  const existing = await readSettings();
  const merged = { ...existing, ...build(existing) };
  await writeSettings(merged);
  renderSettings(merged);
}

async function saveField(field) {
  const spec = FIELDS[field];
  const value = spec.read();
  const error = spec.validate ? spec.validate(value) : null;
  if (error) {
    showStatus(spec.status, error, true);
    return false;
  }
  try {
    await saveSettings(settings => spec.patch(value, settings));
    if (spec.status) showStatus(spec.status, "Sparat.");
    return true;
  } catch (failure) {
    showStatus(spec.status, failure?.message || "Kunde inte spara fältet.", true);
    return false;
  }
}

/** Ett draft i mallfälten kontrolleras innan det läggs till i listan. */
function templateError({ url }, settings) {
  if (!url) return "Klistra in länken till mallen först.";
  if (!DOCS_URL.test(url)) return "Ange en giltig Google Docs-länk (https://docs.google.com/document/d/…).";
  if (resolveTemplates(settings).some(template => template.url === url)) return "Mallen finns redan i listan.";
  return null;
}

async function addTemplate() {
  const draft = { name: $("templateName").value.trim(), url: $("templateUrl").value.trim() };
  const existing = await readSettings();
  const error = templateError(draft, existing);
  if (error) {
    showStatus("statusTemplateUrl", error, true);
    return;
  }
  const current = resolveTemplates(existing);
  const templates = [...current, { name: draft.name || `Mall ${current.length + 1}`, url: draft.url }];
  await saveSettings(() => ({ templates, templateUrl: "" }));
  $("templateName").value = "";
  $("templateUrl").value = "";
  showStatus("statusTemplateUrl", "Mallen är tillagd.");
}

async function load() {
  const settings = await readSettings();
  $("apiKey").value = settings.apiKey || "";
  $("allowUnsupportedSkills").checked = Boolean(settings.allowUnsupportedSkills);
  $("language").value = LANGUAGES.includes(settings.language) ? settings.language : DEFAULT_LANGUAGE;
  $("model").value = MODEL_IDS.has(settings.model) ? settings.model : DEFAULT_MODEL;
  $("dailyLimit").value = settings.dailyLimits?.[$("model").value] || "";
  const fallbacks = Array.isArray(settings.fallbackModels) ? settings.fallbackModels : DEFAULT_FALLBACK_MODELS;
  $("fallbackModel1").value = MODEL_IDS.has(fallbacks[0]) ? fallbacks[0] : "";
  $("fallbackModel2").value = MODEL_IDS.has(fallbacks[1]) ? fallbacks[1] : "";
  $("backupBaseUrl").value = settings.backupBaseUrl || "";
  $("backupModel").value = settings.backupModel || "";
  $("backupApiKey").value = settings.backupApiKey || "";
  for (const spec of Object.values(FIELDS)) if (spec.status) showStatus(spec.status, "");
  showStatus("templateListStatus", "");
  renderSettings(settings);
  await loadHistory();
}

$("save").addEventListener("click", async () => {
  // Fälten sparas i tur och ordning: varje fält läser och skriver samma
  // inställningsobjekt, så samtidiga skrivningar skulle kunna skriva över varandra.
  let failed = 0;
  for (const field of Object.keys(FIELDS)) {
    if (!(await saveField(field))) failed++;
  }
  // Behörigheten begärs här, från ett klick, i stället för vid varje blur av fältet.
  const allowed = await requestHostPermission($("backupBaseUrl").value.trim());
  showStatus("statusBackup", allowed === false
    ? "Sparat, men Chrome gav inte tillåtelse att anropa adressen. Reservleverantören kan därför inte användas."
    : "Sparat.", allowed === false);
  $("saveStatus").textContent = failed
    ? "Rätta fälten som är markerade – de övriga inställningarna sparades."
    : "Inställningarna är sparade.";
});

$("addTemplate").addEventListener("click", addTemplate);

$("templateList").addEventListener("click", async event => {
  const button = event.target.closest("button[data-remove-template]");
  if (!button) return;
  const url = button.dataset.removeTemplate;
  const existing = await readSettings();
  const templates = resolveTemplates(existing).filter(template => template.url !== url);
  const verified = (Array.isArray(existing.verifiedTemplateUrls) ? existing.verifiedTemplateUrls : []).filter(item => item !== url);
  await saveSettings(() => ({ templates, templateUrl: "", verifiedTemplateUrls: verified }));
  showStatus("templateListStatus", "Mallen är borttagen.");
});

$("checkTemplate").addEventListener("click", async () => {
  const output = $("templateCheck");
  output.hidden = false;
  output.textContent = "Hämtar mallen…";
  try {
    const checkedUrl = $("templateUrl").value.trim() || resolveTemplates(await readSettings())[0]?.url || "";
    const doc = await getDoc(extractDocId(checkedUrl));
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
    // En lyckad kontroll kvitterar mallen. Länken har precis använts mot Docs-API:t
    // och är därför verifierad.
    if (!summary.errors.length) {
      await saveSettings(settings => ({
        verifiedTemplateUrls: [...new Set([...(Array.isArray(settings.verifiedTemplateUrls) ? settings.verifiedTemplateUrls : []), checkedUrl])]
      }));
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
  await loadHistory();
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
    await saveSettings(() => ({ googleConnectedAt: new Date().toISOString() }));
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
