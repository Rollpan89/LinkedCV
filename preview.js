import { extractDocId, geminiGenerate, getDoc, flattenDocContent, locateSections, copyTemplate, updateCopiedDoc, normalizeForCompare } from "./shared.js";

const $ = id => document.getElementById(id);
let state = { job: null, originalDoc: null, sections: [], proposals: [], jobAnalysis: [], templateId: null };

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
function renderExtractionWarnings() {
  const warnings=state.job?.diagnostics?.extractionWarnings||[];
  $("extractionPanel").hidden=warnings.length===0;
  $("extractionWarnings").innerHTML=warnings.map(item=>`<li>${esc(item)}</li>`).join("");
}
function renderJobAnalysis() {
  const items=state.jobAnalysis||[];
  const labels={technical:"Teknik och kompetenser",experience:"Erfarenhet",education:"Utbildning",personal:"Personliga egenskaper",responsibility:"Arbetsuppgifter och ansvar",preferred:"Meriterande",other:"Övriga krav"};
  const statusLabels={supported:"Belagt i CV:t",transferable:"Överförbar erfarenhet",not_found:"Saknar belägg"};
  const groups=new Map();for(const item of items){const key=item.category||"other";if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
  $("jobAnalysisCount").textContent=`${items.length} punkter`;
  $("jobAnalysisList").innerHTML=[...groups.entries()].map(([key,entries])=>`<section class="job-analysis-group"><h3>${esc(labels[key]||labels.other)}</h3>${entries.map(item=>`<article class="job-analysis-item"><div class="job-analysis-head"><strong>${esc(item.name||"Oklassificerat krav")}</strong><span class="pill">${esc(statusLabels[item.status]||"Ej bedömt")}</span></div><p><strong>Annons:</strong> ${esc(item.evidence||"")}</p><p><strong>CV:</strong> ${esc(item.cvEvidence||"Inget tydligt belägg")}</p><p><strong>Rekommendation:</strong> ${esc(item.recommendation||"")}</p></article>`).join("")}</section>`).join("");
  $("jobAnalysisPanel").hidden=items.length===0;
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
    setProgress(20, "Annons och inställningar klara", "Hämtar CV-mallen från Google Docs. Inloggning kan behövas.");
    state.templateId = extractDocId(settings.templateUrl);
    $("jobTitle").textContent = pendingJob.title || "Jobbannons – titel kunde inte identifieras";
    $("jobCompany").textContent = pendingJob.company || "Företag kunde inte identifieras automatiskt";
    state.job=pendingJob;
    renderExtractionWarnings();
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
      job: { title: pendingJob.title || "", company: pendingJob.company || "", description: pendingJob.description || pendingJob.text, diagnostics: pendingJob.diagnostics || {} },
      fullCvText: flat.text.replace(/\[\/?[A-Z0-9_ÄÖÅ-]+\]/g, ""),
      sections: state.sections
    });
    state.proposals = analysis.sections;
    state.jobAnalysis = analysis.jobAnalysis || [];
    renderJobAnalysis();
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
    await chrome.storage.local.set({ history: [entry, ...history].slice(0, 100) });
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
