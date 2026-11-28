import {
  analyzeJob,
  dailyLimitFor,
  escapeHtml,
  analysisFingerprint,
  findUnverifiedAdditions,
  FREE_GEMINI_MODELS,
  readGeminiUsage,
  readSettings,
  resolveTemplates,
  wordDiff,
  generateSections,
  discardCopiedDoc,
  extractDocId,
  getDoc,
  parseTemplate,
  copyTemplate,
  updateCopiedDoc,
  normalizeForCompare,
  findUnapprovedIntroductions,
  locateEvidence,
  checkProposalConsistency,
  assertSafeProposalText,
  stripTags,
  pruneHistory
} from "./shared.js";
import { startI18n, t } from "./i18n.js";

const $ = id => document.getElementById(id);

const CATEGORY_LABELS = {
  technical: "Technical skills",
  tools: "Tools and platforms",
  methods: "Methods and ways of working",
  personal: "Personal skills",
  experience: "Experience",
  education: "Education",
  responsibility: "Tasks and responsibilities",
  other: "Other requirements"
};
const STATUS_LABELS = { supported: "Supported by the CV", transferable: "Partially supported", not_found: "No evidence" };
const STATUS_CLASS = { supported: "ok", transferable: "partial", not_found: "warn" };
const IMPORTANCE_LABELS = { required: "Required", preferred: "Preferred", stack: "Tech stack", responsibility: "Responsibility", context: "Context" };
const EXTRACTION_WARNINGS = {
  title_missing: "The job title could not be identified automatically.",
  company_missing: "The employer could not be identified automatically.",
  location_missing: "The location could not be identified automatically.",
  description_section_missing: "The \"About the job\" section was not found; the ad text was taken from an alternative source.",
  description_short: "The ad text is unusually short. Check that the full description has been expanded.",
  description_may_be_incomplete: "LinkedIn still shows a Show more control. The description may be incomplete.",
  description_from_meta: "The ad text came from the page's meta description and is usually shortened."
};

const state = {
  job: null,
  settings: {},
  templates: [],
  templateId: null,
  templateName: "",
  templateChoice: null,
  sections: [],
  fullCvText: "",
  jobAnalysis: [],
  selected: new Set(),
  proposals: null,
  edits: new Map(),
  modelUsed: null,
  allowUnsupported: false,
  statusMessage: "",
  stale: false,
  busy: false,
  creating: false,
  reanalyzing: false
};

function setProgress(percent, title, detail) {
  const value = Math.max(0, Math.min(100, percent));
  $("progressPercent").textContent = `${value} %`;
  $("progressTitle").textContent = title;
  $("progressDetail").textContent = detail;
  $("progressFill").style.width = `${value}%`;
  $("progressBar").setAttribute("aria-valuenow", String(value));
}

/**
 * Ett fel kan bära en detaljlista och en retry-flagga. Bara tillfälliga fel
 * (överbelastning, kvot, timeout) får knappen "Försök igen".
 */
function renderErrorBox(box, error, retry) {
  box.hidden = false;
  box.replaceChildren();
  const summary = document.createElement("p");
  summary.textContent = typeof error === "string" ? error : error?.message || t("Unknown error");
  box.append(summary);
  if (Array.isArray(error?.details) && error.details.length) {
    const list = document.createElement("ul");
    for (const line of error.details) {
      const item = document.createElement("li");
      item.textContent = line;
      list.append(item);
    }
    box.append(list);
  }
  if (error?.retryable && typeof retry === "function") {
    const again = document.createElement("button");
    again.type = "button";
    again.className = "secondary";
    again.textContent = t("Try again");
    again.addEventListener("click", () => {
      box.hidden = true;
      retry();
    });
    box.append(again);
  }
}

/**
 * Visar felrutan. Med flera CV:n får användaren också en väg tillbaka till
 * valet, så ett trasigt CV inte låser hela flödet.
 */
function showError(error, retry, alternative) {
  $("loading").hidden = true;
  $("content").hidden = true;
  renderErrorBox($("error"), error, retry);
  if (!alternative) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.textContent = alternative.label;
  button.addEventListener("click", () => {
    $("error").hidden = true;
    alternative.run();
  });
  $("error").append(button);
}

function showCreateError(error, retry) {
  renderErrorBox($("createError"), error, retry);
}

function modelLabel(modelId) {
  return FREE_GEMINI_MODELS.find(item => item.id === modelId)?.label || modelId;
}

/** Annonsens payload till Gemini — samma form i alla anrop. */
function jobPayload() {
  return {
    title: state.job.title || "",
    company: state.job.company || "",
    description: state.job.description || state.job.text,
    diagnostics: state.job.diagnostics || {}
  };
}

/** Bevisraden i kravlistan: var i CV:t citatet finns, eller en varning om det inte finns. */
function evidenceLines(item) {
  const evidence = locateEvidence({ cvEvidence: item.cvEvidence, sections: state.sections, cvText: state.fullCvText });
  const text = evidence.status === "section"
    ? t("CV: {evidence} · evidence in [{tag}]", { evidence: escapeHtml(item.cvEvidence), tag: escapeHtml(evidence.sectionTag) })
    : evidence.status === "cv"
      ? t("CV: {evidence} · the evidence is outside the editable sections", { evidence: escapeHtml(item.cvEvidence) })
      : t("CV: {evidence}", { evidence: escapeHtml(item.cvEvidence || t("no clear evidence")) });
  const warning = evidence.status === "missing"
    ? `<span class="requirement-unverified">${t("The evidence is not found verbatim in the CV – check the requirement yourself before selecting it.")}</span>`
    : "";
  return { text, warning };
}

/**
 * Google exponerar ingen endpoint för förbrukad kvot, så räknaren bygger på tilläggets
 * egna anrop. Dygnsgränsen är okänd tills ett 429-svar har namngett den (eller användaren
 * anger den i inställningarna); först då visas hur många anrop som är kvar.
 */
async function refreshUsageCounter() {
  const usage = await readGeminiUsage();
  const element = $("usageCounter");
  if (!element) return;
  const total = Object.values(usage.counts).reduce((sum, value) => sum + value, 0);
  const model = state.settings.model;
  const limit = dailyLimitFor(usage, state.settings, model);
  const usedForModel = usage.counts[model] || 0;
  element.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = String(total);
  const label = document.createElement("span");
  label.textContent = t("calls today");
  element.append(strong, label);
  if (limit) {
    const line = document.createElement("p");
    line.textContent = t("{left} left of {limit}", { left: Math.max(0, limit - usedForModel), limit });
    element.append(line);
  }
  element.title = [
    t("Gemini calls from this extension today, per model:"),
    ...Object.entries(usage.counts).map(([id, count]) => `${modelLabel(id)}: ${count}${usage.limits[id] ? t(" of {limit}", { limit: usage.limits[id] }) : ""}`),
    "",
    t("Google shows the exact quota in AI Studio → Rate limits. The counter resets at midnight Pacific time.")
  ].join("\n");
}

/**
 * Med flera CV:n väljs det CV analysen ska utgå från innan något skickas till
 * Gemini. Valet styr både vilket dokument som läses och vilken mall som kopieras;
 * originalmallen ändras aldrig.
 */
function showTemplateChooser() {
  renderTemplateChooser();
  $("loading").hidden = true;
  $("content").hidden = true;
  $("templatePanel").hidden = false;
}

function renderTemplateChooser() {
  const list = $("templateList");
  state.templateChoice = null;
  $("startAnalysis").disabled = true;
  list.replaceChildren(...state.templates.map((template, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "template-choice";
    button.dataset.index = String(index);
    button.setAttribute("aria-pressed", "false");
    const name = document.createElement("strong");
    name.textContent = template.name;
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.setAttribute("aria-hidden", "true");
    tick.textContent = "✓";
    button.append(name, tick);
    button.addEventListener("click", () => {
      state.templateChoice = index;
      for (const item of list.children) item.setAttribute("aria-pressed", item === button ? "true" : "false");
      $("startAnalysis").disabled = false;
    });
    return button;
  }));
}

function renderExtractionWarnings() {
  const warnings = state.job?.diagnostics?.extractionWarnings || [];
  $("extractionPanel").hidden = warnings.length === 0;
  $("extractionWarnings").innerHTML = warnings.map(item => `<li>${escapeHtml(t(EXTRACTION_WARNINGS[item] || item))}</li>`).join("");
}

/* ---------------- Kompetensväljare ---------------- */

function isBlocked(item) {
  return item.status === "not_found" && !state.allowUnsupported;
}

function renderRequirements() {
  const items = state.jobAnalysis;
  $("requirementsPanel").hidden = false;
  $("requirementsList").innerHTML = items.length
    ? [...groupBy(items, item => item.category)].map(([category, entries]) => `
      <section class="job-analysis-group">
        <h3>${escapeHtml(t(CATEGORY_LABELS[category] || CATEGORY_LABELS.other))}</h3>
        ${entries.map(({ item, index }) => {
          const blocked = isBlocked(item);
          const unverified = item.status === "not_found" && !blocked;
          const evidence = evidenceLines(item);
          return `<label class="requirement-item${blocked ? " blocked" : ""}${unverified ? " unverified" : ""}">
            <input type="checkbox" data-index="${index}" ${state.selected.has(item) ? "checked" : ""} ${blocked ? "disabled" : ""}>
            <span class="requirement-main">
              <span class="job-analysis-head"><strong>${escapeHtml(item.name)}</strong>
                <span class="pill ${item.manual ? "partial" : STATUS_CLASS[item.status] || ""}">${escapeHtml(t(IMPORTANCE_LABELS[item.importance] || "Other"))} · ${escapeHtml(item.manual ? t("Added manually") : t(STATUS_LABELS[item.status] || item.status))}</span></span>
              <span class="requirement-evidence">${t("Ad: {evidence}", { evidence: escapeHtml(item.evidence || t("no evidence")) })}</span>
              <span class="requirement-evidence">${evidence.text}</span>
              ${evidence.warning}
              ${item.recommendation ? `<span class="requirement-evidence">${t("Recommendation: {text}", { text: escapeHtml(item.recommendation) })}</span>` : ""}
              ${blocked ? `<span class="requirement-blocked">${t("Cannot be selected: the skill has no evidence in the CV and the “Allow unverified skills” setting is off.")}</span>` : ""}
              ${unverified ? `<span class="requirement-unverified">${t("Not supported by the CV – included only if you select it, and you are responsible for reviewing it.")}</span>` : ""}
              <button type="button" class="link-button requirement-remove" data-remove="${index}">${t("Remove")}</button>
            </span>
          </label>`;
        }).join("")}
      </section>`).join("")
    : `<p class="hint">${t("Gemini found no requirements in the ad.")}</p>`;

  const blockedCount = items.filter(isBlocked).length;
  $("unsupportedNotice").hidden = blockedCount === 0;
  $("unsupportedNotice").textContent = blockedCount
    ? blockedCount === 1
      ? t("1 skill has no evidence in the CV and cannot be selected with the current setting. You can allow it in Settings, but then you are responsible for reviewing the text.")
      : t("{count} skills have no evidence in the CV and cannot be selected with the current setting. You can allow them in Settings, but then you are responsible for reviewing the text.", { count: blockedCount })
    : "";
  refreshSelectionSummary();
}

function groupBy(items, keyFn) {
  const groups = new Map();
  items.forEach((item, index) => {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ item, index });
  });
  return groups;
}

/** Valen håller item-objekten, inte index: då överlever de att krav läggs till eller tas bort. */
function selectedItems() {
  return state.jobAnalysis.filter(item => state.selected.has(item));
}

function markSelectionStale() {
  if (state.proposals) state.stale = true;
}

function selectSupportedOnly() {
  state.selected = new Set(state.jobAnalysis.filter(item => item.status === "supported"));
}

function refreshSelectionSummary() {
  const count = selectedItems().length;
  $("selectionCount").textContent = count === 1
    ? t("{count} selected requirement", { count })
    : t("{count} selected requirements", { count });
  $("generate").disabled = state.busy || state.reanalyzing || !count;
  $("reanalyze").disabled = state.busy || state.reanalyzing;
  $("generate").textContent = state.proposals ? t("Generate the proposals again") : t("Generate text proposals");
  $("staleNotice").hidden = !(state.proposals && state.stale);
  // Bevarar modellinformationen från senaste anropet i stället för att nolla den.
  $("generateStatus").textContent = !state.jobAnalysis.length
    ? t("No requirement profile to choose from.")
    : count === 0
      ? t("Select at least one point to generate proposals.")
      : state.statusMessage;
}

/* ---------------- Förhandsgranskning ---------------- */

function approvedText(tag) {
  const section = state.sections.find(item => item.tag === tag);
  return state.edits.has(tag) ? state.edits.get(tag) : (section?.original ?? "");
}

function finalProposals() {
  return state.sections.map(section => ({ tag: section.tag, text: approvedText(section.tag) }));
}

function renderProposals() {
  $("proposalPanel").hidden = false;
  state.stale = false;
  $("staleNotice").hidden = true;
  $("diffs").innerHTML = state.sections.map(section => {
    const proposal = state.proposals?.find(item => item.tag === section.tag);
    const warnings = [];
    if (section.mixedFormatting) warnings.push(t("The section has several character formats. The replacement text takes the format of the section's first character."));
    const proposedLines = String(approvedText(section.tag) ?? "").split("\n").length;
    if (section.paragraphCount > 1 && proposedLines !== section.paragraphCount) {
      warnings.push(t("The section has {paragraphs} paragraphs but the proposal has {lines} lines. Paragraph breaks cannot be preserved — regenerate with one line per paragraph to keep the list.", { paragraphs: section.paragraphCount, lines: proposedLines }));
    }
    return `<article class="diff-card" data-tag="${escapeHtml(section.tag)}">
      <div class="diff-title"><strong>${escapeHtml(section.tag)}</strong><span class="pill" data-change-pill>—</span></div>
      <div class="diff-grid">
        <div><label>${t("Current text")}</label><pre>${escapeHtml(section.original.trim())}</pre></div>
        <div><label>${t("Proposed text (editable)")}</label><textarea class="proposal-input" data-tag="${escapeHtml(section.tag)}" rows="${Math.min(14, Math.max(4, section.original.split("\n").length + 2))}">${escapeHtml(approvedText(section.tag))}</textarea></div>
      </div>
      <p class="reason">${escapeHtml(proposal?.reason || t("Adaptation proposed from the selected requirements."))}</p>
      ${warnings.length ? `<ul class="section-warning">${warnings.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
      <div class="word-diff" data-diff="${escapeHtml(section.tag)}"></div>
      <div class="diff-actions">
        <button type="button" class="link-button" data-regenerate="${escapeHtml(section.tag)}">${t("Regenerate this section")}</button>
        <button type="button" class="link-button" data-reset="${escapeHtml(section.tag)}">${t("Reset the Gemini proposal")}</button>
      </div>
    </article>`;
  }).join("");
  refreshProposalSummary();
}

function refreshProposalSummary() {
  let changed = 0;
  for (const section of state.sections) {
    const isChanged = normalizeForCompare(approvedText(section.tag)) !== normalizeForCompare(section.original);
    if (isChanged) changed++;
    const card = document.querySelector(`.diff-card[data-tag="${CSS.escape(section.tag)}"]`);
    const pill = card?.querySelector("[data-change-pill]");
    if (pill) {
      pill.textContent = isChanged ? t("Changed") : t("Unchanged");
      pill.className = `pill ${isChanged ? "changed" : ""}`;
    }
  }
  $("changeCount").textContent = t("{count} changes", { count: changed });
  $("noChanges").hidden = changed > 0;
  $("create").disabled = !state.proposals || state.creating;
  for (const section of state.sections) updateWordDiff(section.tag);
  renderAdditionWarnings();
  renderConsistencyWarnings();
}

function updateWordDiff(tag) {
  const target = document.querySelector(`.word-diff[data-diff="${CSS.escape(tag)}"]`);
  const section = state.sections.find(item => item.tag === tag);
  if (!target || !section) return;
  target.replaceChildren(...wordDiff(section.original, approvedText(tag)).map(part => {
    if (part.type === "same") return document.createTextNode(part.text);
    const element = document.createElement(part.type === "del" ? "del" : "ins");
    element.textContent = part.text;
    return element;
  }));
}

/**
 * Årtal och siffror som dyker upp i förslaget utan stöd i CV:t eller annonsen blockeras
 * när CV:t skapas. Egennamn som inte känns igen visas som en varning att granska.
 */
function unverifiedAdditions(proposals) {
  return proposals.flatMap(proposal => {
    const section = state.sections.find(item => item.tag === proposal.tag);
    return findUnverifiedAdditions({
      tag: proposal.tag,
      original: section?.original || "",
      proposal: proposal.text,
      cvText: state.fullCvText,
      jobText: state.job?.description || state.job?.text || ""
    });
  });
}

function renderAdditionWarnings() {
  const element = $("additionWarnings");
  if (!element) return;
  const terms = [...new Set(unverifiedAdditions(finalProposals())
    .filter(item => item.severity === "warn")
    .map(item => item.term))];
  element.hidden = terms.length === 0;
  element.textContent = terms.length
    ? t("Check before you approve: {terms} appears in the proposal but not in the CV or the ad.", { terms: terms.join(", ") })
    : "";
}

/**
 * Konsekvenskontrollen räknas om vid varje redigering, så att en ändrad period syns
 * direkt i stället för först när kopian skapas.
 */
function renderConsistencyWarnings() {
  const element = $("consistencyWarnings");
  if (!element) return;
  const findings = checkProposalConsistency({ proposals: finalProposals(), cvText: state.fullCvText });
  element.hidden = findings.length === 0;
  element.textContent = findings.length
    ? `${t("Consistency check:")} ${findings.map(item => (item.tag ? `${item.message} [${item.tag}]` : item.message)).join(" ")}`
    : "";
}

/* ---------------- Cachad kravanalys ---------------- */

const ANALYSIS_CACHE_LIMIT = 10;

const analysisKey = () => analysisFingerprint({ job: state.job, cvText: state.fullCvText, model: state.settings.model });

async function readCachedAnalysis(fingerprint) {
  const { jobAnalyses = [] } = await chrome.storage.local.get("jobAnalyses");
  return jobAnalyses.find(entry => entry.fingerprint === fingerprint) || null;
}

async function saveCachedAnalysis(entry) {
  try {
    const { jobAnalyses = [] } = await chrome.storage.local.get("jobAnalyses");
    const kept = jobAnalyses.filter(item => item.fingerprint !== entry.fingerprint);
    await chrome.storage.local.set({ jobAnalyses: [entry, ...kept].slice(0, ANALYSIS_CACHE_LIMIT) });
  } catch {
    // Cachen är bara en optimering: ett skrivfel får inte stoppa anpassningen.
  }
}

/* ---------------- Arbetsflöde ---------------- */

async function init() {
  try {
    const [{ pendingJob }, settings] = await Promise.all([
      chrome.storage.session.get("pendingJob"),
      readSettings()
    ]);
    if (!pendingJob) throw new Error(t("No job ad found. Go back to LinkedIn and choose Adapt to CV from the right-click menu."));
    if (!settings.apiKey) throw new Error(t("Add your Gemini API key in the extension settings first."));
    const templates = resolveTemplates(settings);
    if (!templates.length) throw new Error(t("Add the link to your Google Docs template in Settings."));

    state.job = pendingJob;
    state.settings = settings;
    startI18n(settings);
    state.allowUnsupported = Boolean(settings.allowUnsupportedSkills);
    state.templates = templates;

    $("jobTitle").textContent = pendingJob.title || t("Job ad – title could not be identified");
    $("jobCompany").textContent = pendingJob.company || t("Company could not be identified automatically");
    $("jobLink").href = pendingJob.url;
    renderExtractionWarnings();
    const diagnostics = pendingJob.diagnostics || {};
    $("captureInfo").textContent = [
      pendingJob.location && t("Location: {value}", { value: pendingJob.location }),
      pendingJob.employmentType && t("Employment: {value}", { value: pendingJob.employmentType }),
      t("Description: {count} characters", { count: (diagnostics.descriptionLength || pendingJob.description?.length || 0).toLocaleString() }),
      Number.isFinite(diagnostics.timings?.totalMs) && t("Extraction time: {seconds} s", { seconds: (diagnostics.timings.totalMs / 1000).toFixed(1) }),
      t("Extraction source: {source}", { source: diagnostics.descriptionSource || t("unknown") }),
      diagnostics.jobId && t("Ad ID: {id}", { id: diagnostics.jobId }),
      t("Confidence: {percent} %", { percent: diagnostics.confidence ?? 0 })
    ].filter(Boolean).join(" · ");

    if (templates.length > 1) {
      // Analysen startar först när användaren har valt CV: valet styr både vilket
      // dokument som läses och vilken mall kopian skapas från.
      showTemplateChooser();
      return;
    }
    await startAnalysis(templates[0]);
  } catch (error) {
    showError(error, init);
  }
}

/** Hämtar det valda CV:t och kör kravanalysen. Med ett enda CV sker det direkt. */
async function startAnalysis(template) {
  state.templateId = extractDocId(template.url);
  state.templateName = template.name;
  $("templatePanel").hidden = true;
  $("loading").hidden = false;
  $("loading").setAttribute("aria-busy", "true");
  setProgress(0, t("Starting the CV adaptation"), t("Checking the ad and your settings."));
  try {
    setProgress(33, t("Ad and settings ready"), t("Fetching the CV template from Google Docs. Sign-in may be needed."));

    const originalDoc = await getDoc(state.templateId);
    const parsed = parseTemplate(originalDoc);
    if (parsed.errors.length) throw new Error(`${t("The template cannot be used:")}\n${parsed.errors.join("\n")}`);
    if (!parsed.sections.length) throw new Error(t("The template has no editable sections. Use the format [TAG]text[/TAG]."));
    state.sections = parsed.sections.map(section => ({
      tag: section.tag,
      original: section.original,
      mixedFormatting: section.mixedFormatting,
      multiParagraph: section.multiParagraph,
      paragraphCount: section.paragraphCount,
      listParagraphs: section.listParagraphs
    }));
    state.fullCvText = stripTags(parsed.containers.map(container => container.paragraphs.map(paragraph => paragraph.text).join("")).join("\n"));
    setProgress(66, t("CV template analysed"), t("{count} editable sections found. Next step is the requirement analysis.", { count: state.sections.length }));

    const fingerprint = analysisKey();
    let analysis = await readCachedAnalysis(fingerprint);
    if (analysis) {
      state.statusMessage = t("The requirement profile is reused from an earlier analysis with {model}.", { model: analysis.modelUsed });
    } else {
      setProgress(66, t("Analysing the ad"), t("Sending the ad and CV to Gemini for requirement analysis. This call cannot be reused until the ad is analysed."));
      const fresh = await analyzeJob({
        apiKey: state.settings.apiKey,
        model: state.settings.model,
        fallbackModels: state.settings.fallbackModels,
        job: jobPayload(),
        fullCvText: state.fullCvText
      });
      analysis = { items: fresh.jobAnalysis, modelUsed: fresh.modelUsed };
      state.statusMessage = t("The requirement profile was analysed with {model}.", { model: analysis.modelUsed });
      await saveCachedAnalysis({ fingerprint, at: new Date().toISOString(), modelUsed: analysis.modelUsed, items: analysis.items });
    }
    state.jobAnalysis = analysis.items;
    state.modelUsed = analysis.modelUsed;

    selectSupportedOnly();
    renderRequirements();
    setProgress(100, t("Analysis complete"), t("Choose which requirements the adaptation may build on, then generate text proposals."));
    await refreshUsageCounter();

    // Låt det avslutade steget synas en kort stund innan panelen stängs.
    await new Promise(resolve => setTimeout(resolve, 400));
    $("loading").setAttribute("aria-busy", "false");
    $("loading").hidden = true;
    $("templateNote").textContent = t("Based on: {name}", { name: state.templateName });
    $("templateNote").hidden = false;
    $("content").hidden = false;
  } catch (error) {
    showError(
      error,
      () => startAnalysis(template),
      state.templates.length > 1 ? { label: t("Choose another CV"), run: showTemplateChooser } : null
    );
  }
}

/** Modellerna i den ordning Gemini-anropen kan använda dem. */
function candidateModels() {
  return [state.settings.model, ...(state.settings.fallbackModels || [])].filter(Boolean);
}

/**
 * Dagens kvot per modell. Ett anrop får gå till vilken modell som helst i ordningen,
 * så genereringen stoppas först när ingen modell har utrymme kvar. En modell utan känd
 * gräns räknas som användbar — annars skulle en okänd gräns blockera allt.
 */
async function quotaShortfall(needed) {
  const usage = await readGeminiUsage();
  const models = candidateModels().map(model => {
    const limit = dailyLimitFor(usage, state.settings, model);
    return { model, limit, left: limit ? Math.max(0, limit - (usage.counts[model] || 0)) : null };
  });
  return models.some(entry => entry.left === null || entry.left >= needed) ? null : models;
}

function quotaMessage(models, needed) {
  const list = models.map(entry => t("{model}: {left} of {limit}", { model: modelLabel(entry.model), left: entry.left, limit: entry.limit })).join(", ");
  return t("Today's quota is used up for all models ({list}) and {count} calls are needed. The counter resets at midnight Pacific time, and Google shows the exact limit in AI Studio → Rate limits.", { list, count: needed });
}

async function generate(skipConfirm = false) {
  const items = selectedItems();
  if (!items.length) {
    refreshSelectionSummary();
    return;
  }
  const shortfall = await quotaShortfall(1);
  if (shortfall !== null) {
    showCreateError(quotaMessage(shortfall, 1));
    return;
  }
  if (state.edits.size) {
    const edited = [...state.edits.entries()].some(([tag, text]) => text !== (state.proposals?.find(item => item.tag === tag)?.text ?? ""));
    if (edited && !skipConfirm && !confirm(t("Your edits to the proposals will be replaced by a new generation. Continue?"))) return;
  }
  state.busy = true;
  state.statusMessage = t("Gemini is working…");
  refreshSelectionSummary();
  try {
    const result = await generateSections({
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      fallbackModels: state.settings.fallbackModels,
      preferredModel: state.modelUsed,
      job: jobPayload(),
      fullCvText: state.fullCvText,
      sections: state.sections,
      selectedRequirements: items,
      allowUnsupported: state.allowUnsupported,
      language: state.settings.language
    });
    state.proposals = result.sections;
    state.modelUsed = result.modelUsed;
    state.edits = new Map(result.sections.map(item => [item.tag, item.text]));
    renderProposals();
    state.statusMessage = t("The proposals were generated with {model}.", { model: result.modelUsed });
    $("createError").hidden = true;
  } catch (error) {
    state.statusMessage = "";
    showCreateError(error, () => generate(true));
  } finally {
    state.busy = false;
    refreshSelectionSummary();
    refreshUsageCounter();
  }
}

/**
 * Tvingar en ny kravanalys utan att läsa cachen. Sparas sedan som ny cachepost,
 * så nästa inläsning slipper anropa Gemini igen.
 */
async function reanalyze() {
  if (state.busy || state.reanalyzing) return;
  if (state.proposals && !confirm(t("A new requirement analysis replaces the profile and your selections. The proposals remain until you regenerate. Continue?"))) return;
  state.reanalyzing = true;
  state.statusMessage = t("Running a new requirement analysis…");
  $("analysisError").hidden = true;
  refreshSelectionSummary();
  try {
    const fresh = await analyzeJob({
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      fallbackModels: state.settings.fallbackModels,
      job: jobPayload(),
      fullCvText: state.fullCvText
    });
    state.jobAnalysis = fresh.jobAnalysis;
    state.modelUsed = fresh.modelUsed;
    state.statusMessage = t("The requirement profile was analysed with {model}.", { model: fresh.modelUsed });
    selectSupportedOnly();
    await saveCachedAnalysis({
      fingerprint: analysisKey(),
      at: new Date().toISOString(),
      url: state.job.url || "",
      title: state.job.title || "",
      items: fresh.jobAnalysis,
      modelUsed: fresh.modelUsed
    });
    markSelectionStale();
    renderRequirements();
  } catch (error) {
    state.statusMessage = "";
    renderErrorBox($("analysisError"), error, reanalyze);
    refreshSelectionSummary();
  } finally {
    state.reanalyzing = false;
    refreshSelectionSummary();
    refreshUsageCounter();
  }
}

/** Genererar om bara den valda sektionen — billigare än en ny full generering. */
async function regenerateSection(tag) {
  const section = state.sections.find(item => item.tag === tag);
  const items = selectedItems();
  if (!section || !items.length || state.busy) return;
  const shortfall = await quotaShortfall(1);
  if (shortfall !== null) {
    showCreateError(quotaMessage(shortfall, 1));
    return;
  }
  state.busy = true;
  state.statusMessage = t("Regenerating [{tag}]…", { tag });
  refreshSelectionSummary();
  try {
    const result = await generateSections({
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      fallbackModels: state.settings.fallbackModels,
      preferredModel: state.modelUsed,
      job: jobPayload(),
      fullCvText: state.fullCvText,
      sections: [section],
      selectedRequirements: items,
      allowUnsupported: state.allowUnsupported,
      language: state.settings.language
    });
    const fresh = result.sections[0];
    state.proposals = state.proposals
      ? state.proposals.map(item => (item.tag === tag ? { ...item, text: fresh.text, reason: fresh.reason } : item))
      : [{ tag, text: fresh.text, reason: fresh.reason }];
    state.edits.set(tag, fresh.text);
    const area = document.querySelector(`textarea[data-tag="${CSS.escape(tag)}"]`);
    if (area) area.value = fresh.text;
    state.statusMessage = t("[{tag}] was regenerated with {model}.", { tag, model: result.modelUsed });
    $("createError").hidden = true;
    refreshProposalSummary();
  } catch (error) {
    state.statusMessage = "";
    showCreateError(error, () => regenerateSection(tag));
  } finally {
    state.busy = false;
    refreshSelectionSummary();
    refreshUsageCounter();
  }
}

/**
 * Hårda hinder som gäller när Google Docs-kopian skapas:
 * påhittade uppgifter, ej godkända kompetenser, bakvända perioder och taggliknande text.
 * Returnerar felet som ska visas, eller null när förslagen får användas.
 */
function blockingProblem(proposals) {
  // Bara uppgifter som Gemini själv föreslagit blockeras: det användaren själv skriver in är användarens eget påstående.
  const additions = unverifiedAdditions(proposals).filter(item => item.severity === "block" && (state.proposals || []).some(proposal => proposal.tag === item.tag && (proposal.text || "").includes(item.term)));
  if (additions.length) {
    return t("Gemini proposes details that are not in the CV or the ad: {list}. Remove them before creating the CV, otherwise it would be invented experience.", { list: additions.map(item => `${item.term} (${item.tag})`).join(", ") });
  }
  const violations = unapprovedViolations(proposals);
  if (violations.length) {
    return t("The text contains skills without evidence in the CV that you have not approved: {list}. Remove them from the proposal, or allow unverified skills in Settings and select them deliberately.", { list: violations.map(item => `${item.name} (${item.tag})`).join(", ") });
  }
  const conflicts = checkProposalConsistency({ proposals, cvText: state.fullCvText }).filter(item => item.level === "block");
  if (conflicts.length) {
    return t("The consistency check stops: {list} Fix the periods in the proposals first — the CV is the source of the dates.", { list: conflicts.map(item => `${item.message} [${item.tag}]`).join(" ") });
  }
  try {
    for (const proposal of proposals) assertSafeProposalText(proposal.tag, proposal.text);
  } catch (error) {
    return error;
  }
  return null;
}

function unapprovedViolations(proposals) {
  const approvedNames = state.allowUnsupported
    ? selectedItems().filter(item => item.status === "not_found").map(item => item.name)
    : [];
  return findUnapprovedIntroductions({ proposals, jobAnalysis: state.jobAnalysis, approvedNames });
}

async function create() {
  const button = $("create");
  $("createError").hidden = true;
  const proposals = finalProposals();
  // Inget halvfärdigt dokument lämnas kvar i Drive.
  const problem = blockingProblem(proposals);
  if (problem) {
    showCreateError(problem);
    return;
  }
  state.creating = true;
  button.disabled = true;
  button.textContent = t("Creating the Google Docs copy…");
  try {
    const role = state.job.title || t("Adapted CV");
    const company = state.job.company || t("Company");
    const title = `${t("CV")} – ${role} – ${company}`.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120);
    const copy = await copyTemplate(state.templateId, title);
    try {
      await updateCopiedDoc(copy.id, proposals);
    } catch (error) {
      // En kopia som inte blev godkänd ska inte ligga kvar i Drive som ett halvfärdigt CV.
      const removed = await discardCopiedDoc(copy.id);
      const cleanup = removed
        ? t("The incomplete copy was removed from Google Drive.")
        : t("The copy could not be removed automatically — delete it in Google Drive.");
      throw new Error(`${error.message}\n${cleanup}`);
    }
    const url = copy.webViewLink || `https://docs.google.com/document/d/${copy.id}/edit`;
    const entry = { id: copy.id, url, role, company, createdAt: new Date().toISOString(), jobUrl: state.job.url };
    const { history = [] } = await chrome.storage.local.get("history");
    // Historiken gallras vid varje sparning så att gamla poster inte blir kvar för evigt.
    await chrome.storage.local.set({ history: pruneHistory([entry, ...history]) });
    chrome.runtime.sendMessage({ type: "CV_CREATED" }).catch(() => {});
    button.textContent = t("CV created");
    const done = document.createElement("section");
    done.className = "success-box";
    done.innerHTML = `<strong>${t("Your CV is ready and verified.")}</strong><p>${t("A copy is in Google Drive and contains exactly the text you approved. The original template is unchanged.")}</p><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${t("Open the Google Docs document")} ↗</a>`;
    $("content").prepend(done);
  } catch (error) {
    state.creating = false;
    button.disabled = false;
    button.textContent = t("Try creating the CV again");
    showCreateError(error);
  }
}

$("requirementsList").addEventListener("change", event => {
  const input = event.target.closest("input[type=checkbox]");
  if (!input) return;
  const item = state.jobAnalysis[Number(input.dataset.index)];
  if (!item) return;
  if (input.checked) state.selected.add(item);
  else state.selected.delete(item);
  markSelectionStale();
  refreshSelectionSummary();
});

/** Ett eget krav saknar Gemini-belägg och markeras därför som manuellt tillagt. */
function addRequirement() {
  const input = $("newRequirementName");
  const status = $("requirementStatus");
  const name = input.value.trim();
  const problem = name.length < 2
    ? t("Enter at least two characters.")
    : state.jobAnalysis.some(item => item.name.toLowerCase() === name.toLowerCase())
      ? t("The requirement is already in the list.")
      : null;
  if (problem) {
    status.hidden = false;
    status.textContent = problem;
    return;
  }
  const item = {
    category: "other",
    name,
    importance: "required",
    evidence: t("Added by you"),
    status: "supported",
    cvEvidence: "",
    recommendation: t("Manually added requirement – you are responsible for its accuracy."),
    manual: true
  };
  state.jobAnalysis.push(item);
  state.selected.add(item);
  input.value = "";
  status.hidden = true;
  markSelectionStale();
  renderRequirements();
}

$("addRequirement").addEventListener("click", addRequirement);

$("requirementsList").addEventListener("click", event => {
  const button = event.target.closest("button[data-remove]");
  if (!button) return;
  // Knappen ligger inuti en label: utan preventDefault skulle klicket också
  // markera kryssrutan.
  event.preventDefault();
  const [removed] = state.jobAnalysis.splice(Number(button.dataset.remove), 1);
  if (!removed) return;
  state.selected.delete(removed);
  markSelectionStale();
  renderRequirements();
});

$("startAnalysis").addEventListener("click", () => {
  if (state.templateChoice === null) return;
  startAnalysis(state.templates[state.templateChoice]);
});

$("selectSupported").addEventListener("click", () => {
  selectSupportedOnly();
  markSelectionStale();
  renderRequirements();
});

$("clearSelection").addEventListener("click", () => {
  state.selected.clear();
  markSelectionStale();
  renderRequirements();
});

$("diffs").addEventListener("input", event => {
  const area = event.target.closest("textarea[data-tag]");
  if (!area) return;
  state.edits.set(area.dataset.tag, area.value);
  refreshProposalSummary();
});

$("diffs").addEventListener("click", event => {
  const regenerate = event.target.closest("button[data-regenerate]");
  if (regenerate) { regenerateSection(regenerate.dataset.regenerate); return; }
  const button = event.target.closest("button[data-reset]");
  if (!button) return;
  const proposal = state.proposals?.find(item => item.tag === button.dataset.reset);
  if (!proposal) return;
  state.edits.set(proposal.tag, proposal.text);
  const area = document.querySelector(`textarea[data-tag="${CSS.escape(proposal.tag)}"]`);
  if (area) area.value = proposal.text;
  refreshProposalSummary();
});

$("generate").addEventListener("click", () => generate());
$("reanalyze").addEventListener("click", () => reanalyze());
$("copyDiagnostics").addEventListener("click", async () => {
  const button = $("copyDiagnostics");
  const payload = {
    job: { title: state.job?.title, company: state.job?.company, url: state.job?.url, location: state.job?.location, employmentType: state.job?.employmentType },
    diagnostics: state.job?.diagnostics || {},
    sections: state.sections.map(section => section.tag),
    settings: { model: state.settings.model, fallbackModels: state.settings.fallbackModels },
    usage: await readGeminiUsage()
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    button.textContent = t("Copied diagnostics");
    setTimeout(() => { button.textContent = t("Copy diagnostics"); }, 2500);
  } catch {
    showCreateError(t("Could not copy to the clipboard. Open the console and copy the output instead."));
    console.log(JSON.stringify(payload, null, 2));
  }
});
$("create").addEventListener("click", create);
$("cancel").addEventListener("click", () => window.close());

refreshUsageCounter();
init();
