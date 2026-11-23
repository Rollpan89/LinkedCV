import { extractDocId, geminiGenerate, getDoc, flattenDocContent, locateSections, copyTemplate, updateCopiedDoc, normalizeForCompare } from "./shared.js";

const $ = id => document.getElementById(id);
let state = { job: null, settings: null, originalDoc: null, sections: [], proposals: [], competencyAnalysis: [], templateId: null };

function setProgress(percent, title, detail) {
  const value = Math.max(0, Math.min(100, percent));
  $("progressPercent").textContent = `${value} %`;
  $("progressTitle").textContent = title;
  $("progressDetail").textContent = detail;
  $("progressFill").style.width = `${value}%`;
  $("progressBar").setAttribute("aria-valuenow", String(value));
}

function showError(message) {
  $("loading").hidden = true;
  $("content").hidden = true;
  $("error").hidden = false;
  $("error").textContent = message;
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function renderCompetencies() {
  const items = state.job?.competencies || [];
  const labels = { required: "Krav", preferred: "Meriterande", technology_stack: "Teknikstack", mentioned: "Omnämnd" };
  const classes = { required: "required", preferred: "preferred", technology_stack: "stack", mentioned: "mentioned" };
  $("competencyCount").textContent = `${items.length} identifierade`;
  $("noCompetencies").hidden = items.length > 0;
  $("competencyList").innerHTML = items.map(item => `<div class="competency-item"><strong>${esc(item.name)}</strong><span class="competency-label ${classes[item.classification] || "mentioned"}">${esc(labels[item.classification] || "Omnämnd")}</span><small>${esc(item.evidence || "")}</small></div>`).join("");
}

function renderCompetencyAnalysis() {
  const items = state.competencyAnalysis || [];
  const labels = { supported: "Belagd i CV:t", transferable: "Överförbar erfarenhet", not_found: "Saknar belägg" };
  const classes = { supported: "supported", transferable: "transferable", not_found: "not-found" };
  $("coverageCount").textContent = `${items.filter(x => x.status === "supported").length} belagda · ${items.filter(x => x.status === "transferable").length} överförbara · ${items.filter(x => x.status === "not_found").length} saknar belägg`;
  $("coverageList").innerHTML = items.map(item => `<article class="coverage-item"><div class="coverage-head"><strong>${esc(item.name)}</strong><span class="coverage-status ${classes[item.status] || "not-found"}">${esc(labels[item.status] || "Ej bedömd")}</span></div><small>${esc(item.classification || "")}</small><p>${esc(item.evidence || "")}</p><p class="reason">${esc(item.recommendation || "")}</p></article>`).join("");
  $("coveragePanel").hidden = items.length === 0;
}

function renderDiffs() {
  const byTag = new Map(state.proposals.map(p => [p.tag, p]));
  const changed = state.sections.filter(s => normalizeForCompare(byTag.get(s.tag)?.text ?? s.original) !== normalizeForCompare(s.original));
  $("changeCount").textContent = `${changed.length} ändringar`;
  $("diffs").innerHTML = changed.map(section => {
    const proposal = byTag.get(section.tag);
    return `<article class="diff-card"><div class="diff-title"><strong>${esc(section.tag)}</strong><span class="pill changed">Ändras</span></div><div class="diff-grid"><div><label>NUVARANDE TEXT</label><pre>${esc(section.original.trim())}</pre></div><div><label>FÖRESLAGEN TEXT</label><pre class="new-text">${esc(proposal?.text?.trim() ?? section.original.trim())}</pre></div></div><p class="reason">${esc(proposal?.reason || "Anpassning föreslagen utifrån annonsen.")}</p></article>`;
  }).join("");
  $("noChanges").hidden = changed.length > 0;
}

async function init() {
  setProgress(0, "Startar CV-anpassningen", "Kontrollerar annonsen och dina inställningar.");
  try {
    const [{ pendingJob }, { settings = {} }] = await Promise.all([
      chrome.storage.session.get("pendingJob"), chrome.storage.local.get("settings")
    ]);
    if (!pendingJob) throw new Error("Ingen jobbannons hittades. Gå tillbaka till LinkedIn och välj Anpassa till CV i högerklicksmenyn.");
    if (!settings.apiKey) throw new Error("Lägg till din Gemini API-nyckel i tilläggets inställningar först.");
    if (!settings.templateUrl) throw new Error("Ange länken till din Google Docs-mall i inställningarna.");
    state.job = pendingJob;
    state.settings = settings;
    setProgress(20, "Annons och inställningar klara", "Hämtar CV-mallen från Google Docs. Inloggning kan behövas.");
    state.templateId = extractDocId(settings.templateUrl);
    $("jobTitle").textContent = pendingJob.title;
    $("jobCompany").textContent = pendingJob.company || "Företag kunde inte identifieras automatiskt";
    $("jobLink").href = pendingJob.url;
    const d = pendingJob.diagnostics || {};
    $("captureInfo").textContent = [
      pendingJob.location && `Plats: ${pendingJob.location}`,
      pendingJob.employmentType && `Anställning: ${pendingJob.employmentType}`,
      `Beskrivning: ${(d.descriptionLength || pendingJob.description?.length || 0).toLocaleString("sv-SE")} tecken`,
      `Extraktionskälla: ${d.descriptionSource || "okänd"}`,
      d.jobId && `Annons-ID: ${d.jobId}`,
      `Identifierade tekniker: ${d.competencyCount ?? pendingJob.competencies?.length ?? 0}`,
      `Säkerhetsbedömning: ${d.confidence ?? 0} %`,
      d.jsonLdFound ? "Strukturerad annonsdata hittad" : "Ingen strukturerad annonsdata"
    ].filter(Boolean).join(" · ");

    const originalDoc = await getDoc(state.templateId);
    state.originalDoc = originalDoc;
    setProgress(40, "CV-mallen hämtad", "Läser dokumentets innehåll och redigeringsmarkeringar.");
    const flat = flattenDocContent(originalDoc.body?.content || []);
    state.sections = locateSections(flat.text).map(s => ({ tag: s.tag, original: s.original }));
    if (!state.sections.length) throw new Error("Mallen innehåller inga redigeringssektioner. Använd formatet [TAG]text[/TAG].");
    setProgress(60, "CV-mallen analyserad", `${state.sections.length} redigerbara sektioner hittades. Skickar underlaget till Gemini för analys.`);
    const analysis = await geminiGenerate({
      apiKey: settings.apiKey,
      model: settings.model,
      job: { title: pendingJob.title, company: pendingJob.company, description: pendingJob.description || pendingJob.text, competencies: pendingJob.competencies || [], jobSections: pendingJob.jobSections || {} },
      fullCvText: flat.text.replace(/\[\/?[A-Z0-9_ÄÖÅ-]+\]/g, ""),
      sections: state.sections
    });
    state.proposals = analysis.sections;
    state.competencyAnalysis = analysis.competencyAnalysis;
    renderCompetencies();
    renderCompetencyAnalysis();
    setProgress(80, "Gemini-analysen klar", "Förbereder jämförelsen mellan nuvarande och föreslagen CV-text.");
    renderDiffs();
    setProgress(100, "Analysen färdig", "Förslagen är klara att granska. Inget dokument har skapats ännu.");
    $("loading").setAttribute("aria-busy", "false");
    $("loading").hidden = true;
    $("content").hidden = false;
  } catch (error) {
    showError(error.message || String(error));
  }
}

$("create").addEventListener("click", async () => {
  const button = $("create");
  button.disabled = true;
  button.textContent = "Skapar Google Docs-kopia…";
  try {
    const role = state.job.title || "Anpassat CV";
    const company = state.job.company || "Företag";
    const title = `CV – ${role} – ${company}`.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120);
    const copy = await copyTemplate(state.templateId, title);
    await updateCopiedDoc(copy.id, state.originalDoc, state.proposals);
    const url = copy.webViewLink || `https://docs.google.com/document/d/${copy.id}/edit`;
    const entry = { id: copy.id, url, role, company, createdAt: new Date().toISOString(), jobUrl: state.job.url };
    const { history = [] } = await chrome.storage.local.get("history");
    await chrome.storage.local.set({ history: [entry, ...history].slice(0, 100), latest: entry });
    chrome.runtime.sendMessage({ type: "CV_CREATED" }).catch(() => {});
    $("create").textContent = "CV skapat";
    $("create").disabled = true;
    try { await chrome.action.openPopup(); } catch (_) { /* Chrome may block programmatic popup opening; the action badge and popup link remain available. */ }
    const done = document.createElement("section");
    done.className = "success-box";
    done.innerHTML = `<strong>Ditt CV är klart.</strong><p>En kopia har skapats i Google Drive. Originalmallen är oförändrad.</p><a href="${url}" target="_blank" rel="noreferrer">Öppna Google Docs-dokumentet ↗</a>`;
    $("content").prepend(done);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Försök skapa CV igen";
    showError(error.message || String(error));
  }
});
$("cancel").addEventListener("click", () => window.close());
init();
