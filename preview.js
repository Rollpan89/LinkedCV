import {
  analyzeJob,
  analysisFingerprint,
  findUnverifiedAdditions,
  FREE_GEMINI_MODELS,
  readGeminiUsage,
  readSettings,
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
  stripTags
} from "./shared.js";

const $ = id => document.getElementById(id);

const CATEGORY_LABELS = {
  technical: "Tekniska kompetenser",
  tools: "Verktyg och plattformar",
  methods: "Metoder och arbetssätt",
  personal: "Personliga kompetenser",
  experience: "Erfarenhet",
  education: "Utbildning",
  responsibility: "Arbetsuppgifter och ansvar",
  other: "Övriga krav"
};
const STATUS_LABELS = { supported: "Belagt i CV:t", transferable: "Delvis belagt", not_found: "Saknar belägg" };
const STATUS_CLASS = { supported: "ok", transferable: "partial", not_found: "warn" };
const IMPORTANCE_LABELS = { required: "Krav", preferred: "Meriterande", stack: "Teknikstack", responsibility: "Ansvar", context: "Kontext" };

const state = {
  job: null,
  settings: {},
  templateId: null,
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
  summary.textContent = typeof error === "string" ? error : error?.message || "Okänt fel";
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
    again.textContent = "Försök igen";
    again.addEventListener("click", () => {
      box.hidden = true;
      retry();
    });
    box.append(again);
  }
}

function showError(error, retry) {
  $("loading").hidden = true;
  $("content").hidden = true;
  renderErrorBox($("error"), error, retry);
}

function showCreateError(error, retry) {
  renderErrorBox($("createError"), error, retry);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function modelLabel(modelId) {
  return FREE_GEMINI_MODELS.find(item => item.id === modelId)?.label || modelId;
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
  const limit = usage.limits[model] || Number(state.settings.dailyLimits?.[model]) || 0;
  const usedForModel = usage.counts[model] || 0;
  element.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = String(total);
  const label = document.createElement("span");
  label.textContent = "anrop idag";
  element.append(strong, label);
  if (limit) {
    const line = document.createElement("p");
    line.textContent = `${Math.max(0, limit - usedForModel)} kvar av ${limit}`;
    element.append(line);
  }
  element.title = [
    "Gemini-anrop från det här tillägget idag, per modell:",
    ...Object.entries(usage.counts).map(([id, count]) => `${modelLabel(id)}: ${count}${usage.limits[id] ? ` av ${usage.limits[id]}` : ""}`),
    "",
    "Google visar den exakta kvoten i AI Studio → Rate limits. Räknaren nollställs vid midnatt Pacific time."
  ].join("\n");
}

function renderExtractionWarnings() {
  const warnings = state.job?.diagnostics?.extractionWarnings || [];
  $("extractionPanel").hidden = warnings.length === 0;
  $("extractionWarnings").innerHTML = warnings.map(item => `<li>${esc(item)}</li>`).join("");
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
        <h3>${esc(CATEGORY_LABELS[category] || CATEGORY_LABELS.other)}</h3>
        ${entries.map(({ item, index }) => {
          const blocked = isBlocked(item);
          const unverified = item.status === "not_found" && !blocked;
          const evidence = locateEvidence({ cvEvidence: item.cvEvidence, sections: state.sections, cvText: state.fullCvText });
          const cvLine = evidence.status === "section"
            ? `CV: ${esc(item.cvEvidence)} · belägg i [${esc(evidence.sectionTag)}]`
            : evidence.status === "cv"
              ? `CV: ${esc(item.cvEvidence)} · belägget finns utanför de redigerbara sektionerna`
              : `CV: ${esc(item.cvEvidence || "inget tydligt belägg")}`;
          const evidenceWarning = evidence.status === "missing"
            ? `<span class="requirement-unverified">Belägget finns inte ordagrant i CV:t – kontrollera kravet själv innan du väljer det.</span>`
            : "";
          return `<label class="requirement-item${blocked ? " blocked" : ""}${unverified ? " unverified" : ""}">
            <input type="checkbox" data-index="${index}" ${state.selected.has(index) ? "checked" : ""} ${blocked ? "disabled" : ""}>
            <span class="requirement-main">
              <span class="job-analysis-head"><strong>${esc(item.name)}</strong>
                <span class="pill ${STATUS_CLASS[item.status] || ""}">${esc(IMPORTANCE_LABELS[item.importance] || "Övrigt")} · ${esc(STATUS_LABELS[item.status] || item.status)}</span></span>
              <span class="requirement-evidence">Annons: ${esc(item.evidence || "inget belägg")}</span>
              <span class="requirement-evidence">${cvLine}</span>
              ${evidenceWarning}
              ${item.recommendation ? `<span class="requirement-evidence">Rekommendation: ${esc(item.recommendation)}</span>` : ""}
              ${blocked ? `<span class="requirement-blocked">Kan inte väljas: kompetensen saknar belägg i CV:t och inställningen ”Tillåt ej styrkta kompetenser” är av.</span>` : ""}
              ${unverified ? `<span class="requirement-unverified">Ej styrkt av CV:t – inkluderas bara om du väljer den, och du ansvarar själv för granskningen.</span>` : ""}
            </span>
          </label>`;
        }).join("")}
      </section>`).join("")
    : `<p class="hint">Gemini hittade inga krav i annonsen.</p>`;

  const blockedCount = items.filter(isBlocked).length;
  $("unsupportedNotice").hidden = blockedCount === 0;
  $("unsupportedNotice").textContent = blockedCount
    ? `${blockedCount} kompetens${blockedCount === 1 ? "" : "er"} saknar belägg i CV:t och kan inte väljas med nuvarande inställning. Du kan tillåta dem i Inställningar, men då ansvarar du själv för att granska texten.`
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

function selectedItems() {
  return [...state.selected].sort((a, b) => a - b).map(index => state.jobAnalysis[index]).filter(Boolean);
}

function markSelectionStale() {
  if (state.proposals) state.stale = true;
}

function selectSupportedOnly() {
  state.selected = new Set(state.jobAnalysis
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status === "supported")
    .map(({ index }) => index));
}

function refreshSelectionSummary() {
  const count = selectedItems().length;
  $("selectionCount").textContent = `${count} valda`;
  $("generate").disabled = state.busy || state.reanalyzing || !count;
  $("reanalyze").disabled = state.busy || state.reanalyzing;
  $("generate").textContent = state.proposals ? "Generera om förslagen" : "Generera textförslag";
  $("staleNotice").hidden = !(state.proposals && state.stale);
  // Bevarar modellinformationen från senaste anropet i stället för att nolla den.
  $("generateStatus").textContent = !state.jobAnalysis.length
    ? "Ingen kravprofil att välja från."
    : count === 0
      ? "Välj minst en punkt för att kunna generera förslag."
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
    if (section.mixedFormatting) warnings.push("Sektionen har flera olika teckenformat. Ersättningstexten får formatet från sektionens första tecken.");
    const proposedLines = String(approvedText(section.tag) ?? "").split("\n").length;
    if (section.paragraphCount > 1 && proposedLines !== section.paragraphCount) {
      warnings.push(`Sektionen har ${section.paragraphCount} stycken men förslaget har ${proposedLines} rader. Styckebrotten kan då inte bevaras — gör om förslaget med en rad per stycke om du vill behålla punktlistan.`);
    }
    return `<article class="diff-card" data-tag="${esc(section.tag)}">
      <div class="diff-title"><strong>${esc(section.tag)}</strong><span class="pill" data-change-pill>—</span></div>
      <div class="diff-grid">
        <div><label>NUVARANDE TEXT</label><pre>${esc(section.original.trim())}</pre></div>
        <div><label>FÖRESLAGEN TEXT (redigerbar)</label><textarea class="proposal-input" data-tag="${esc(section.tag)}" rows="${Math.min(14, Math.max(4, section.original.split("\n").length + 2))}">${esc(approvedText(section.tag))}</textarea></div>
      </div>
      <p class="reason">${esc(proposal?.reason || "Anpassning föreslagen utifrån de valda kraven.")}</p>
      ${warnings.length ? `<ul class="section-warning">${warnings.map(item => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}
      <div class="word-diff" data-diff="${esc(section.tag)}"></div>
      <div class="diff-actions">
        <button type="button" class="link-button" data-regenerate="${esc(section.tag)}">Generera om den här sektionen</button>
        <button type="button" class="link-button" data-reset="${esc(section.tag)}">Återställ Gemini-förslaget</button>
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
      pill.textContent = isChanged ? "Ändras" : "Oförändrad";
      pill.className = `pill ${isChanged ? "changed" : ""}`;
    }
  }
  $("changeCount").textContent = `${changed} ändringar`;
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
    ? `Kontrollera innan du godkänner: ${terms.join(", ")} nämns i förslaget men finns inte i CV:t eller annonsen.`
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
    ? `Konsekvenskontroll: ${findings.map(item => (item.tag ? `${item.message} [${item.tag}]` : item.message)).join(" ")}`
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
  $("loading").hidden = false;
  $("loading").setAttribute("aria-busy", "true");
  setProgress(0, "Startar CV-anpassningen", "Kontrollerar annonsen och dina inställningar.");
  try {
    const [{ pendingJob }, settings] = await Promise.all([
      chrome.storage.session.get("pendingJob"),
      readSettings()
    ]);
    if (!pendingJob) throw new Error("Ingen jobbannons hittades. Gå tillbaka till LinkedIn och välj Anpassa till CV i högerklicksmenyn.");
    if (!settings.apiKey) throw new Error("Lägg till din Gemini API-nyckel i tilläggets inställningar först.");
    if (!settings.templateUrl) throw new Error("Ange länken till din Google Docs-mall i inställningarna.");

    state.job = pendingJob;
    state.settings = settings;
    state.allowUnsupported = Boolean(settings.allowUnsupportedSkills);
    state.templateId = extractDocId(settings.templateUrl);

    $("jobTitle").textContent = pendingJob.title || "Jobbannons – titel kunde inte identifieras";
    $("jobCompany").textContent = pendingJob.company || "Företag kunde inte identifieras automatiskt";
    $("jobLink").href = pendingJob.url;
    renderExtractionWarnings();
    const diagnostics = pendingJob.diagnostics || {};
    $("captureInfo").textContent = [
      pendingJob.location && `Plats: ${pendingJob.location}`,
      pendingJob.employmentType && `Anställning: ${pendingJob.employmentType}`,
      `Beskrivning: ${(diagnostics.descriptionLength || pendingJob.description?.length || 0).toLocaleString("sv-SE")} tecken`,
      `Extraktionskälla: ${diagnostics.descriptionSource || "okänd"}`,
      diagnostics.jobId && `Annons-ID: ${diagnostics.jobId}`,
      `Säkerhetsbedömning: ${diagnostics.confidence ?? 0} %`
    ].filter(Boolean).join(" · ");
    setProgress(33, "Annons och inställningar klara", "Hämtar CV-mallen från Google Docs. Inloggning kan behövas.");

    const originalDoc = await getDoc(state.templateId);
    const parsed = parseTemplate(originalDoc);
    if (parsed.errors.length) throw new Error(`Mallen kan inte användas:\n${parsed.errors.join("\n")}`);
    if (!parsed.sections.length) throw new Error("Mallen innehåller inga redigeringssektioner. Använd formatet [TAG]text[/TAG].");
    state.sections = parsed.sections.map(section => ({
      tag: section.tag,
      original: section.original,
      mixedFormatting: section.mixedFormatting,
      multiParagraph: section.multiParagraph,
      paragraphCount: section.paragraphCount,
      listParagraphs: section.listParagraphs
    }));
    state.fullCvText = stripTags(parsed.containers.map(container => container.paragraphs.map(paragraph => paragraph.text).join("")).join("\n"));
    setProgress(66, "CV-mallen analyserad", `${state.sections.length} redigerbara sektioner hittades. Nästa steg är kravanalysen.`);

    const fingerprint = analysisKey();
    let analysis = await readCachedAnalysis(fingerprint);
    if (analysis) {
      state.statusMessage = `Kravprofilen återanvänds från en tidigare analys med ${analysis.modelUsed}.`;
    } else {
      setProgress(66, "Analyserar annonsen", "Skickar annons och CV till Gemini för kravanalys. Det här anropet kan inte återanvändas förrän annonsen är analyserad.");
      const fresh = await analyzeJob({
        apiKey: settings.apiKey,
        model: settings.model,
        fallbackModels: settings.fallbackModels,
        job: { title: pendingJob.title || "", company: pendingJob.company || "", description: pendingJob.description || pendingJob.text, diagnostics },
        fullCvText: state.fullCvText
      });
      analysis = { items: fresh.jobAnalysis, modelUsed: fresh.modelUsed };
      state.statusMessage = `Kravprofilen är analyserad med ${analysis.modelUsed}.`;
      await saveCachedAnalysis({ fingerprint, at: new Date().toISOString(), modelUsed: analysis.modelUsed, items: analysis.items });
    }
    state.jobAnalysis = analysis.items;
    state.modelUsed = analysis.modelUsed;

    selectSupportedOnly();
    renderRequirements();
    setProgress(100, "Analysen är klar", "Välj vilka krav CV-anpassningen får bygga på och generera sedan textförslag.");
    await refreshUsageCounter();

    // Låt det avslutade steget synas en kort stund innan panelen stängs.
    await new Promise(resolve => setTimeout(resolve, 400));
    $("loading").setAttribute("aria-busy", "false");
    $("loading").hidden = true;
    $("content").hidden = false;
  } catch (error) {
    showError(error, init);
  }
}

async function quotaShortfall(needed) {
  const usage = await readGeminiUsage();
  const model = state.settings.model;
  const limit = usage.limits[model] || Number(state.settings.dailyLimits?.[model]) || 0;
  if (!limit) return null;
  const left = Math.max(0, limit - (usage.counts[model] || 0));
  return left < needed ? left : null;
}

function quotaMessage(left, needed) {
  return `Dagens kvot för ${modelLabel(state.settings.model)} räcker inte: ${left} anrop kvar, ${needed} behövs. Räknaren nollställs vid midnatt Pacific time, och Google visar den exakta gränsen i AI Studio → Rate limits.`;
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
    if (edited && !skipConfirm && !confirm("Dina redigeringar av förslagen ersätts av en ny generering. Fortsätt?")) return;
  }
  state.busy = true;
  state.statusMessage = "Gemini arbetar…";
  refreshSelectionSummary();
  try {
    const result = await generateSections({
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      fallbackModels: state.settings.fallbackModels,
      preferredModel: state.modelUsed,
      job: { title: state.job.title || "", company: state.job.company || "", description: state.job.description || state.job.text, diagnostics: state.job.diagnostics || {} },
      fullCvText: state.fullCvText,
      sections: state.sections,
      selectedRequirements: items,
      allowUnsupported: state.allowUnsupported
    });
    state.proposals = result.sections;
    state.modelUsed = result.modelUsed;
    state.edits = new Map(result.sections.map(item => [item.tag, item.text]));
    renderProposals();
    state.statusMessage = `Förslagen är genererade med ${result.modelUsed}.`;
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
  if (state.proposals && !confirm("En ny kravanalys ersätter kravprofilen och de val du gjort. Förslagen ligger kvar tills du genererar om. Fortsätt?")) return;
  state.reanalyzing = true;
  state.statusMessage = "Gör en ny kravanalys…";
  $("analysisError").hidden = true;
  refreshSelectionSummary();
  try {
    const fresh = await analyzeJob({
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      fallbackModels: state.settings.fallbackModels,
      job: { title: state.job.title || "", company: state.job.company || "", description: state.job.description || state.job.text, diagnostics: state.job.diagnostics || {} },
      fullCvText: state.fullCvText
    });
    state.jobAnalysis = fresh.jobAnalysis;
    state.modelUsed = fresh.modelUsed;
    state.statusMessage = `Kravprofilen är analyserad med ${fresh.modelUsed}.`;
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
  state.statusMessage = `Genererar om [${tag}]…`;
  refreshSelectionSummary();
  try {
    const result = await generateSections({
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      fallbackModels: state.settings.fallbackModels,
      preferredModel: state.modelUsed,
      job: { title: state.job.title || "", company: state.job.company || "", description: state.job.description || state.job.text, diagnostics: state.job.diagnostics || {} },
      fullCvText: state.fullCvText,
      sections: [section],
      selectedRequirements: items,
      allowUnsupported: state.allowUnsupported
    });
    const fresh = result.sections[0];
    state.proposals = state.proposals
      ? state.proposals.map(item => (item.tag === tag ? { ...item, text: fresh.text, reason: fresh.reason } : item))
      : [{ tag, text: fresh.text, reason: fresh.reason }];
    state.edits.set(tag, fresh.text);
    const area = document.querySelector(`textarea[data-tag="${CSS.escape(tag)}"]`);
    if (area) area.value = fresh.text;
    state.statusMessage = `[${tag}] är omgenererad med ${result.modelUsed}.`;
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
  // Bara uppgifter som Gemini själv föreslagit blockeras: det användaren själv skriver in är användarens eget påstående.
  const additions = unverifiedAdditions(proposals).filter(item => item.severity === "block" && (state.proposals || []).some(proposal => proposal.tag === item.tag && (proposal.text || "").includes(item.term)));
  if (additions.length) {
    showCreateError(`Gemini föreslår uppgifter som inte finns i CV:t eller annonsen: ${additions.map(item => `${item.term} (${item.tag})`).join(", ")}. Ta bort dem innan du skapar CV:t, annars vore det en påhittad erfarenhet.`);
    return;
  }
  const violations = unapprovedViolations(proposals);
  if (violations.length) {
    showCreateError(`Texten innehåller kompetenser som saknar belägg i CV:t och som du inte har godkänt: ${violations.map(item => `${item.name} (${item.tag})`).join(", ")}. Ta bort dem ur förslaget, eller tillåt ej styrkta kompetenser i inställningarna och välj dem medvetet.`);
    return;
  }
  const conflicts = checkProposalConsistency({ proposals, cvText: state.fullCvText }).filter(item => item.level === "block");
  if (conflicts.length) {
    showCreateError(`Konsekvenskontrollen stoppar kopian: ${conflicts.map(item => `${item.message} [${item.tag}]`).join(" ")} Rätta perioderna i förslagen först — CV:t är källan till årtalen.`);
    return;
  }
  // Kontrollera förslagen innan en kopia skapas, så att inget halvfärdigt
  // dokument lämnas kvar i Google Drive.
  try {
    for (const proposal of proposals) assertSafeProposalText(proposal.tag, proposal.text);
  } catch (error) {
    showCreateError(error);
    return;
  }
  state.creating = true;
  button.disabled = true;
  button.textContent = "Skapar Google Docs-kopia…";
  try {
    const role = state.job.title || "Anpassat CV";
    const company = state.job.company || "Företag";
    const title = `CV – ${role} – ${company}`.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120);
    const copy = await copyTemplate(state.templateId, title);
    try {
      await updateCopiedDoc(copy.id, proposals);
    } catch (error) {
      // En kopia som inte blev godkänd ska inte ligga kvar i Drive som ett halvfärdigt CV.
      const removed = await discardCopiedDoc(copy.id);
      const cleanup = removed
        ? "Den ofullständiga kopian har tagits bort från Google Drive."
        : "Kopian kunde inte tas bort automatiskt — radera den i Google Drive.";
      throw new Error(`${error.message}\n${cleanup}`);
    }
    const url = copy.webViewLink || `https://docs.google.com/document/d/${copy.id}/edit`;
    const entry = { id: copy.id, url, role, company, createdAt: new Date().toISOString(), jobUrl: state.job.url };
    const { history = [] } = await chrome.storage.local.get("history");
    await chrome.storage.local.set({ history: [entry, ...history].slice(0, 100) });
    chrome.runtime.sendMessage({ type: "CV_CREATED" }).catch(() => {});
    button.textContent = "CV skapat";
    const done = document.createElement("section");
    done.className = "success-box";
    done.innerHTML = `<strong>Ditt CV är klart och kontrollerat.</strong><p>En kopia finns i Google Drive och innehåller exakt den text du godkände. Originalmallen är oförändrad.</p><a href="${esc(url)}" target="_blank" rel="noreferrer">Öppna Google Docs-dokumentet ↗</a>`;
    $("content").prepend(done);
  } catch (error) {
    state.creating = false;
    button.disabled = false;
    button.textContent = "Försök skapa CV igen";
    showCreateError(error);
  }
}

$("requirementsList").addEventListener("change", event => {
  const input = event.target.closest("input[type=checkbox]");
  if (!input) return;
  const index = Number(input.dataset.index);
  if (input.checked) state.selected.add(index);
  else state.selected.delete(index);
  markSelectionStale();
  refreshSelectionSummary();
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
    button.textContent = "Diagnostik kopierad";
    setTimeout(() => { button.textContent = "Kopiera diagnostik"; }, 2500);
  } catch {
    showCreateError("Kunde inte kopiera till urklipp. Öppna konsolen och kopiera utskriften i stället.");
    console.log(JSON.stringify(payload, null, 2));
  }
});
$("create").addEventListener("click", create);
$("cancel").addEventListener("click", () => window.close());

refreshUsageCounter();
init();
