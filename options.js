import { DEFAULT_LANGUAGE, DEFAULT_MODEL, DEFAULT_FALLBACK_MODELS, FREE_GEMINI_MODELS, HISTORY_LIMIT, HISTORY_MAX_AGE_DAYS, LANGUAGES, clearAnalysisCache, clearAllData, clearUsageCounter, escapeHtml, extractDocId, getDoc, pruneHistory, readSettings, resolveTemplates, summarizeTemplate, withDailyLimit, writeSettings } from "./shared.js";
import { DEFAULT_UI_LANGUAGE, UI_LANGUAGES, getUiLanguage, startI18n, t } from "./i18n.js";

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
      return Number.isInteger(number) && number >= 0 ? null : t("Enter an integer, 0 or higher.");
    },
    patch: (value, settings) => ({ dailyLimits: withDailyLimit(settings.dailyLimits, settings.model || DEFAULT_MODEL, value) })
  }),
  fallbackModels: {
    elements: ["fallbackModel1", "fallbackModel2"],
    events: ["change"],
    read: fallbackSelection,
    patch: value => ({ fallbackModels: value })
  },
  uiLanguage: {
    elements: ["uiLanguage"],
    events: ["change"],
    read: () => (UI_LANGUAGES.includes($("uiLanguage").value) ? $("uiLanguage").value : DEFAULT_UI_LANGUAGE),
    patch: value => ({ uiLanguage: value })
  },
  allowUnsupportedSkills: {
    elements: ["allowUnsupportedSkills"],
    events: ["change"],
    read: () => $("allowUnsupportedSkills").checked,
    patch: value => ({ allowUnsupportedSkills: value })
  }
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
    ? templates.map(template => `<li><span class="template-name">${escapeHtml(template.name)}</span><code class="template-url">${escapeHtml(template.url)}</code><button type="button" class="link-button" data-remove-template="${escapeHtml(template.url)}">${t("Remove")}</button></li>`).join("")
    : `<li class="hint">${t("No templates added yet.")}</li>`;
}

/** Alla modellers sparade dygnsgränser, så att de syns utan att byta modell. */
function renderDailyLimits(settings) {
  const parts = FREE_GEMINI_MODELS.map(model => `${model.label}: ${settings.dailyLimits?.[model.id] || t("unknown")}`);
  $("dailyLimitsSummary").textContent = t("Saved daily limits – {list}", { list: parts.join(" · ") });
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
    ? t("All steps done – open a job ad on LinkedIn and choose Adapt to CV from the right-click menu.")
    : t("{done} of {total} steps done", { done: completed, total: ONBOARDING_STEPS.length });
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
    ? `${t("{count} CVs in the history. Entries older than {days} days and anything beyond {limit} are removed automatically.", { count: kept.length, days: HISTORY_MAX_AGE_DAYS, limit: HISTORY_LIMIT })}${removed > 0 ? ` ${t("{count} old entries were removed now.", { count: removed })}` : ""}`
    : t("The history is empty. When you create a CV it is saved here, and entries are removed automatically after 180 days.");
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
    if (spec.status) showStatus(spec.status, t("Saved."));
    return true;
  } catch (failure) {
    showStatus(spec.status, failure?.message || t("Could not save the field."), true);
    return false;
  }
}

/** Ett draft i mallfälten kontrolleras innan det läggs till i listan. */
function templateError({ url }, settings) {
  if (!url) return t("Paste the template link first.");
  if (!DOCS_URL.test(url)) return t("Enter a valid Google Docs link (https://docs.google.com/document/d/…).");
  if (resolveTemplates(settings).some(template => template.url === url)) return t("The template is already in the list.");
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
  showStatus("statusTemplateUrl", t("The template was added."));
}

async function load() {
  const settings = await readSettings();
  startI18n(settings);
  $("apiKey").value = settings.apiKey || "";
  $("uiLanguage").value = UI_LANGUAGES.includes(settings.uiLanguage) ? settings.uiLanguage : DEFAULT_UI_LANGUAGE;
  $("allowUnsupportedSkills").checked = Boolean(settings.allowUnsupportedSkills);
  $("language").value = LANGUAGES.includes(settings.language) ? settings.language : DEFAULT_LANGUAGE;
  $("model").value = MODEL_IDS.has(settings.model) ? settings.model : DEFAULT_MODEL;
  $("dailyLimit").value = settings.dailyLimits?.[$("model").value] || "";
  const fallbacks = Array.isArray(settings.fallbackModels) ? settings.fallbackModels : DEFAULT_FALLBACK_MODELS;
  $("fallbackModel1").value = MODEL_IDS.has(fallbacks[0]) ? fallbacks[0] : "";
  $("fallbackModel2").value = MODEL_IDS.has(fallbacks[1]) ? fallbacks[1] : "";
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
  $("saveStatus").textContent = failed
    ? t("Fix the highlighted fields – the other settings were saved.")
    : t("Settings saved.");
  if (getUiLanguage() !== $("uiLanguage").value) location.reload();
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
  showStatus("templateListStatus", t("The template was removed."));
});

$("checkTemplate").addEventListener("click", async () => {
  const output = $("templateCheck");
  output.hidden = false;
  output.textContent = t("Fetching the template…");
  try {
    const checkedUrl = $("templateUrl").value.trim() || resolveTemplates(await readSettings())[0]?.url || "";
    const doc = await getDoc(extractDocId(checkedUrl));
    const summary = summarizeTemplate(doc);
    const parts = [];
    if (summary.errors.length) {
      parts.push(`<p class="hint"><strong>${t("The template cannot be used:")}</strong><br>${summary.errors.map(escapeHtml).join("<br>")}</p>`);
    }
    parts.push(summary.sections.length
      ? `<p><strong>${t("{count} tagged sections found:", { count: summary.sections.length })}</strong> ${summary.sections.map(section => `<code>[${escapeHtml(section.tag)}]</code>`).join(" ")}</p>`
      : `<p><strong>${t("No tagged sections were found.")}</strong> ${t("Add tags according to the list below.")}</p>`);
    if (summary.missingHeadings.length) {
      parts.push(`<p class="hint">${t("Headings that look like sections but have no tags:")}</p><ul class="rules">${summary.missingHeadings.map(heading => `<li>${escapeHtml(t(heading.label))}: ${t("put")} <code>[${heading.tag}]</code> ${t("before the text and")} <code>[/${heading.tag}]</code> ${t("after it.")}</li>`).join("")}</ul>`);
      parts.push(`<p class="hint">${t("Tags may only exist in the template. All text outside the tags is left untouched in the finished copy.")}</p>`);
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
  $("dataStatus").textContent = t("The cached requirement analyses were cleared.");
});
$("clearUsage").addEventListener("click", async () => {
  await clearUsageCounter();
  $("dataStatus").textContent = t("The call counter was reset.");
});
$("clearHistory").addEventListener("click", async () => {
  await chrome.storage.local.set({ history: [] });
  await loadHistory();
  $("dataStatus").textContent = t("The history was cleared.");
});
$("clearAll").addEventListener("click", async () => {
  if (!confirm(t("Delete the API key, all analyses, the counter, the history and the Google connection?"))) return;
  await clearAllData();
  $("apiKey").value = "";
  await load();
  $("dataStatus").textContent = t("All local data was deleted.");
});

$("model").addEventListener("change", async () => {
  const settings = await readSettings();
  $("dailyLimit").value = settings.dailyLimits?.[$("model").value] || "";
});
$("connectGoogle").addEventListener("click", async () => {
  try {
    const result = await chrome.identity.getAuthToken({ interactive: true });
    if (!result?.token) throw new Error(t("Google returned no access token."));
    $("googleStatus").textContent = t("The Google account is connected.");
    await saveSettings(() => ({ googleConnectedAt: new Date().toISOString() }));
  } catch (error) {
    $("googleStatus").textContent = error.message || t("Google sign-in failed.");
  }
});

for (const [field, spec] of Object.entries(FIELDS)) {
  for (const id of spec.elements) {
    for (const type of spec.events) $(id).addEventListener(type, () => saveField(field));
  }
}

load();
