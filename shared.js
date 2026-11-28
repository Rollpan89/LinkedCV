/* Delad logik: Gemini, Google Docs/Drive och redigeringssektioner. */
import { t } from "./i18n.js";
import { ANALYSIS_INSTRUCTION, sectionInstruction, CATEGORY_SYNONYMS, IMPORTANCE_SYNONYMS, STATUS_SYNONYMS, TEMPLATE_SECTIONS, YEAR_RANGE_PATTERN, ONGOING_YEAR, ANCHOR_STOPWORDS } from "./model-data.js";

export const FREE_GEMINI_MODELS = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" }
];
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_FALLBACK_MODELS = ["gemini-3.8-flash", "gemini-3.1-flash-lite"];
const FREE_MODEL_IDS = new Set(FREE_GEMINI_MODELS.map(model => model.id));

export const CATEGORIES = ["technical", "tools", "methods", "personal", "experience", "education", "responsibility", "other"];
export const IMPORTANCE_LEVELS = ["required", "preferred", "stack", "responsibility", "context"];
export const SUPPORT_STATUSES = ["supported", "transferable", "not_found"];

export function extractDocId(input) {
  const value = String(input || "").trim();
  const match = value.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(value)) return value;
  throw new Error(t("Enter a valid Google Docs link."));
}

export function normalizeForCompare(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

/**
 * Kort, stabil nyckel för att avgöra om en sparad kravanalys fortfarande gäller.
 * Samma annons, CV-text och modell ger samma nyckel; ändras något blir det en ny analys.
 * Versionen gör att en ändrad analysinstruktion ogiltigförklarar gamla analyser.
 */
const ANALYSIS_CACHE_VERSION = 2;

export function analysisFingerprint({ job = {}, cvText = "", model = "" } = {}) {
  const description = job.description || job.text || "";
  const parts = [
    ANALYSIS_CACHE_VERSION,
    job.url || "",
    job.title || "",
    job.company || "",
    description,
    cvText,
    model
  ];
  let hash = 5381;
  const joined = parts.join("\u0000");
  for (let index = 0; index < joined.length; index++) hash = ((hash << 5) + hash + joined.charCodeAt(index)) | 0;
  return hash.toString(36);
}

/* ------------------------------------------------------------------ *
 * Taggar
 * ------------------------------------------------------------------ */

const TAG_TOKEN_SOURCE = `\\[(\\/?)([\\p{L}\\p{N}_-]{1,40})\\]`;
// En tagg måste innehålla minst en bokstav, annars hade t.ex. "[2024]" tolkats som en tagg.
const looksLikeTagName = name => /\p{L}/u.test(name);

export function stripTags(value) {
  return String(value ?? "").replace(new RegExp(TAG_TOKEN_SOURCE, "gu"), token => (looksLikeTagName(token) ? "" : token));
}

/**
 * Ett förslag får aldrig innehålla taggliknande text. Taggar hör till mallen,
 * och om de hamnade i CV:t skulle nästa körning kunna tolka dem som sektioner.
 */
export function assertSafeProposalText(tag, text) {
  const tokens = findTagTokens(text);
  if (tokens.length) {
    throw new Error(t("The proposal for [{tag}] contains tag-like text ({tokens}). Tags may only exist in the template.", { tag, tokens: [...new Set(tokens)].join(", ") }));
  }
}

export function findTagTokens(value) {
  const found = [];
  const pattern = new RegExp(TAG_TOKEN_SOURCE, "gu");
  let match;
  const text = String(value ?? "");
  while ((match = pattern.exec(text)) !== null) {
    if (looksLikeTagName(match[0])) found.push(match[0]);
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * Gemini
 * ------------------------------------------------------------------ */

/**
 * Fel som kan bära en detaljlista för gränssnittet.
 * retryable=true betyder att felet är tillfälligt (överbelastning, kvot, timeout)
 * och att ett nytt försök kan lyckas.
 */
function modelFailureError(summary, details, { retryable = false } = {}) {
  const error = new Error(summary);
  error.details = details;
  error.retryable = retryable;
  return error;
}
const PACIFIC_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

/** Gratisnivåns dygnskvot nollställs vid midnatt Pacific time, enligt Googles dokumentation. */
export function pacificDateKey(date = new Date()) {
  return PACIFIC_DATE_FORMAT.format(date);
}

/**
 * Gemini API har ingen endpoint för förbrukad kvot. Ett 429-svar för dygnsgränsen
 * namnger dock själva gränsen i google.rpc.QuotaFailure, så den kan läsas härifrån.
 * Returnerar antalet tillåtna anrop per dag, eller null om svaret inte säger det.
 */
export function parseDailyQuotaLimit(body) {
  const details = body?.error?.details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    for (const violation of detail?.violations || []) {
      if (!String(violation?.quotaId || "").includes("PerDay")) continue;
      const value = Number(violation?.quotaValue);
      if (Number.isFinite(value) && value > 0) return Math.floor(value);
    }
  }
  return null;
}

/** Dagens räkning och kända dygnsgränser, per modell. */
export async function readGeminiUsage() {
  const today = pacificDateKey();
  try {
    const { geminiUsage } = await chrome.storage.local.get("geminiUsage");
    const sameDay = geminiUsage?.date === today;
    // Nytt Pacific-dygn: räkningen börjar om, men inlärda gränser behålls.
    return {
      date: today,
      counts: sameDay ? geminiUsage.counts || {} : {},
      limits: geminiUsage?.limits || {}
    };
  } catch {
    return { date: today, counts: {}, limits: {} };
  }
}

/**
 * Räknaren är kosmetisk och får aldrig stoppa ett anrop, så allt skrivs här.
 * mutate returnerar false när inget ändrats.
 */
async function updateUsage(mutate) {
  try {
    const usage = await readGeminiUsage();
    if (mutate(usage) === false) return;
    await chrome.storage.local.set({ geminiUsage: usage });
  } catch {
    // Okänt läge är bättre än att krascha; nästa anrop försöker igen.
  }
}

const recordUsage = modelId => updateUsage(usage => {
  usage.counts[modelId] = (usage.counts[modelId] || 0) + 1;
});

const learnDailyLimit = (modelId, limit) => updateUsage(usage => {
  if (usage.limits[modelId] === limit) return false;
  usage.limits[modelId] = limit;
});

const RETRYABLE_STATUSES = new Set([408, 500, 502, 503, 504]);
const GEMINI_MAX_ATTEMPTS = 4;
const GEMINI_BASE_DELAY_MS = 1000;
const GEMINI_MAX_DELAY_MS = 30000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Exponentiell backoff med jitter, som Googles egen rekommendation för 429 och 5xx:
 * 1 s, 2 s, 4 s (max 30 s) plus slumpmässig jitter. Serverns Retry-After respekteras
 * när den anger en längre väntetid än backoffen.
 */
function retryDelayMs(attempt, response) {
  const exponential = Math.min(GEMINI_BASE_DELAY_MS * 2 ** attempt, GEMINI_MAX_DELAY_MS);
  const headerSeconds = Number(response?.headers?.get?.("retry-after"));
  const fromHeader = Number.isFinite(headerSeconds) && headerSeconds > 0 ? Math.min(headerSeconds, 60) * 1000 : 0;
  return Math.max(exponential, fromHeader) + Math.floor(Math.random() * 500);
}

async function callGeminiModels({ apiKey, modelOrder, systemInstruction, userPayload, temperature = 0.1 }) {
  const ordered = [...new Set(modelOrder.filter(id => FREE_MODEL_IDS.has(id)))];
  if (!ordered.length) ordered.push(DEFAULT_MODEL);
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(userPayload) }] }],
    generationConfig: { temperature, responseMimeType: "application/json" }
  });
  const failures = [];
  let transient = true;
  for (const candidateModel of ordered) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidateModel)}:generateContent`;
    for (let attempt = 0; attempt < GEMINI_MAX_ATTEMPTS; attempt++) {
      await recordUsage(candidateModel);
      let response;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            body,
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        const reason = error?.name === "AbortError" ? "timeout" : (error?.message || t("network error"));
        if (attempt < GEMINI_MAX_ATTEMPTS - 1) {
          await sleep(retryDelayMs(attempt));
          continue;
        }
        failures.push(`${candidateModel}: ${reason}`);
        break;
      }
      const attemptData = await response.json().catch(() => ({}));
      if (response.ok) {
        const raw = attemptData?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("") || "";
        if (!raw) throw new Error(t("Gemini ({model}) returned an empty response. Check the API key and the model quota.", { model: candidateModel }));
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error(t("Gemini returned an invalid JSON response. Try again."));
        }
        await recordModelResult(candidateModel, true);
        return {
          parsed,
          modelUsed: candidateModel,
          finishReason: attemptData?.candidates?.[0]?.finishReason || "",
          blockReason: attemptData?.promptFeedback?.blockReason || ""
        };
      }
      const detail = String(attemptData?.error?.message || `HTTP ${response.status}`).slice(0, 240);
      if (response.status === 429) {
        const dailyLimit = parseDailyQuotaLimit(attemptData);
        if (dailyLimit) await learnDailyLimit(candidateModel, dailyLimit);
      }
      failures.push(`${candidateModel}: HTTP ${response.status} – ${detail}`);
      // 429 betyder att kvoten är slut och 404 att modellen är borta. Ingen av dem blir
      // bättre av ett nytt försök inom några sekunder, så nästa modell provas direkt.
      if (response.status === 429 || response.status === 404) {
        if (response.status === 404) transient = false;
        break;
      }
      if (!RETRYABLE_STATUSES.has(response.status)) {
        // Övriga 4xx (nyckel, behörighet, felaktigt anrop) kan inte lyckas genom att försöka igen.
        throw new Error(t("Gemini ({model}) rejected the request (HTTP {status}): {detail}", { model: candidateModel, status: response.status, detail }));
      }
      if (attempt < GEMINI_MAX_ATTEMPTS - 1) await sleep(retryDelayMs(attempt, response));
    }
    await recordModelResult(candidateModel, false);
  }
  const details = [
    ...failures,
    t("503 means temporary overload at Google, not necessarily that your quota is used up. 429 means rate or quota limiting. No paid models have been called.")
  ];
  if (transient) {
    throw modelFailureError(t("Google's Gemini service is temporarily overloaded. Try again in a moment."), details, { retryable: true });
  }
  throw modelFailureError(t("None of the free Gemini models could answer."), details);
}



const MAX_REQUIREMENTS = 80;

const normalizeKey = value => String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
const allowList = values => Object.fromEntries(values.map(value => [value, value]));

/**
 * Gemini följer oftast schemat men inte alltid: kategorier kan komma som "Technical",
 * "verktyg" eller "teknikstack". Kategori och prioritet är presentation och normaliseras
 * därför till närmaste kända värde. Status styr om en kompetens får väljas, så en okänd
 * status behandlas som "saknar belägg" — hellre försiktigt än att släppa in något CV:t
 * inte styrker. Tidigare avvisades hela analysen av en enda avvikande sträng.
 */
const CATEGORY_ALIASES = { ...allowList(CATEGORIES), ...CATEGORY_SYNONYMS };
const IMPORTANCE_ALIASES = { ...allowList(IMPORTANCE_LEVELS), ...IMPORTANCE_SYNONYMS };
const STATUS_ALIASES = { ...allowList(SUPPORT_STATUSES), ...STATUS_SYNONYMS };

const REQUIREMENT_KEYS = new Set(["jobanalysis", "job_analysis", "requirements", "requirementprofile", "analysis", "items"]);

const looksLikeRequirements = list => list.some(item => item && typeof item === "object" && "name" in item);

/**
 * Modellen lägger oftast listan under jobAnalysis, men ibland på toppnivå, under
 * job_analysis/requirements eller i ett omslagsobjekt. En lista under en känd nyckel
 * godtas även om den är tom, så att felet kan förklaras i stället för att bara kastas.
 */
function findRequirementsArray(value, depth = 0) {
  if (depth > 2 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) return looksLikeRequirements(value) ? value : null;
  const entries = Object.entries(value);
  for (const [key, nested] of entries) {
    if (REQUIREMENT_KEYS.has(key.toLowerCase()) && Array.isArray(nested)) return nested;
  }
  for (const [, nested] of entries) {
    const found = findRequirementsArray(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function validateJobAnalysis(items, context = {}) {
  if (!Array.isArray(items)) {
    const parsed = context.parsed;
    const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : [];
    throw modelFailureError(t("Gemini returned no requirement profile."), [
      keys.length ? t("The response contained the keys: {keys}.", { keys: keys.join(", ") }) : t("The response contained no list of requirements."),
      context.finishReason ? t("Finish reason from Gemini: {reason}.", { reason: context.finishReason }) : "",
      context.blockReason ? t("The response was blocked: {reason}.", { reason: context.blockReason }) : "",
      t("Try again, or change the model in Settings if it repeats.")
    ].filter(Boolean), { retryable: !context.blockReason && context.finishReason !== "SAFETY" });
  }
  if (!items.length) {
    throw modelFailureError(t("Gemini found no requirements in the ad."), [
      t("The response was an empty list of requirements."),
      t("Check that the ad description above is complete — if it is short, the extraction from LinkedIn may have failed."),
      t("Try again in a moment.")
    ], { retryable: true });
  }
  const normalized = [];
  for (const item of items.slice(0, MAX_REQUIREMENTS)) {
    if (!item || typeof item.name !== "string" || !item.name.trim()) continue;
    normalized.push({
      ...item,
      name: item.name.trim(),
      category: CATEGORY_ALIASES[normalizeKey(item.category)] || "other",
      importance: IMPORTANCE_ALIASES[normalizeKey(item.importance)] || "context",
      status: STATUS_ALIASES[normalizeKey(item.status)] || "not_found"
    });
  }
  if (!normalized.length) {
    throw modelFailureError(t("Gemini returned no usable requirements."), [t("All entries lacked a name.")], { retryable: true });
  }
  return normalized;
}

export async function analyzeJob({ apiKey, model, fallbackModels = [], job, fullCvText }) {
  const { parsed, modelUsed, finishReason, blockReason } = await callGeminiModels({
    apiKey,
    modelOrder: await rankedModelOrder([model, ...fallbackModels]),
    systemInstruction: ANALYSIS_INSTRUCTION,
    userPayload: { job_ad: job, complete_cv: fullCvText }
  });
  return { jobAnalysis: validateJobAnalysis(findRequirementsArray(parsed), { parsed, finishReason, blockReason }), modelUsed };
}

export async function generateSections({ apiKey, model, fallbackModels = [], preferredModel, job, fullCvText, sections, selectedRequirements = [], allowUnsupported = false, language = DEFAULT_LANGUAGE }) {
  const { parsed, modelUsed } = await callGeminiModels({
    apiKey,
    modelOrder: await rankedModelOrder([preferredModel, model, ...fallbackModels]),
    systemInstruction: sectionInstruction(language),
    temperature: 0.1,
    userPayload: {
      job_ad: job,
      complete_cv_as_context: fullCvText,
      selected_requirements: selectedRequirements.map(item => ({
        name: item.name,
        category: item.category,
        importance: item.importance,
        evidence: item.evidence,
        status: item.status,
        cvEvidence: item.cvEvidence,
        recommendation: item.recommendation
      })),
      allow_unsupported_skills: Boolean(allowUnsupported),
      editable_sections: sections.map(section => ({ tag: section.tag, text: section.original }))
    }
  });
  if (!Array.isArray(parsed?.sections)) throw new Error(t("The Gemini response has no sections."));
  const allowed = new Set(sections.map(section => section.tag));
  const returned = new Set();
  if (parsed.sections.length !== sections.length) throw new Error(t("Gemini did not return exactly one change per editable CV section. No document was created."));
  for (const item of parsed.sections) {
    if (!allowed.has(item?.tag) || typeof item.text !== "string" || returned.has(item.tag)) {
      throw new Error(t("Gemini returned an unknown, duplicated or invalid CV section. No document was created."));
    }
    returned.add(item.tag);
  }
  if (returned.size !== allowed.size) throw new Error(t("The Gemini response is missing one or more CV sections. No document was created."));
  return { sections: parsed.sections, modelUsed };
}

/**
 * Lexikal skyddsnät: en kompetens som saknar stöd i CV:t får aldrig smygas in i
 * ett förslag utan att användaren uttryckligen har tillåtit och valt den.
 */
export function findUnapprovedIntroductions({ proposals, jobAnalysis, approvedNames = [] }) {
  const approved = new Set(approvedNames.map(name => String(name).trim().toLowerCase()));
  const violations = [];
  for (const item of jobAnalysis || []) {
    if (item?.status !== "not_found") continue;
    const name = String(item.name || "").trim();
    if (name.length < 2 || approved.has(name.toLowerCase())) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "iu");
    for (const proposal of proposals) {
      if (pattern.test(String(proposal.text || ""))) violations.push({ tag: proposal.tag, name });
    }
  }
  return violations;
}

/* ------------------------------------------------------------------ *
 * Krav och bevis
 * ------------------------------------------------------------------ */

/**
 * Citattecken, streck och blanksteg skiljer sig mellan Geminis svar och CV-texten.
 * Nyckeln gör jämförelsen okänslig för sådant som inte ändrar innebörden.
 */
function evidenceKey(value) {
  return String(value ?? "")
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const EVIDENCE_GAP = /\s*(?:\u2026|\.{3,})\s*/;

/** Citatdelarna måste förekomma i angiven ordning, inte bara var för sig. */
function containsInOrder(haystack, fragments) {
  if (!haystack) return false;
  let from = 0;
  for (const fragment of fragments) {
    const at = haystack.indexOf(fragment, from);
    if (at === -1) return false;
    from = at + fragment.length;
  }
  return true;
}

/**
 * Letar upp ett cvEvidence-citat i CV:t och namnger sektionen det kommer från.
 * Ett citat som inte finns i CV-texten är ett tecken på att kravet inte är styrkt;
 * det markeras för granskning i stället för att presenteras som belagt.
 * Citat med ellips matchas som en sekvens i angiven ordning.
 */
export function locateEvidence({ cvEvidence = "", sections = [], cvText = "" } = {}) {
  const fragments = evidenceKey(cvEvidence).split(EVIDENCE_GAP).filter(Boolean);
  // Ett tomt eller mycket kort citat säger inget om var belägget kommer ifrån.
  if (!fragments.length || fragments.join("").length < 3) return { status: "none", sectionTag: null };
  for (const section of sections || []) {
    if (containsInOrder(evidenceKey(section?.original), fragments)) return { status: "section", sectionTag: section.tag || null };
  }
  return { status: containsInOrder(evidenceKey(cvText), fragments) ? "cv" : "missing", sectionTag: null };
}

/* ------------------------------------------------------------------ *
 * Konsekvenskontroll av förslagen
 * ------------------------------------------------------------------ */


function rangeFromMatch(match) {
  const start = Number(match[1]);
  const endText = match[2].toLowerCase();
  const end = ONGOING_YEAR.has(endText) ? "nu" : Number(endText);
  return { start, end, key: `${start}-${end}`, text: match[0].replace(/\s+/g, " ") };
}

function yearRanges(text) {
  return [...String(text ?? "").matchAll(YEAR_RANGE_PATTERN)].map(rangeFromMatch);
}

/**
 * Närmast föregående egennamn på samma rad, t.ex. arbetsgivaren i "Utvecklare på AMF 2019–2025".
 * "Utvecklare" räknas inte eftersom bara det sista versala ordet före perioden används.
 */
function rangeAnchor(text, index) {
  const line = String(text ?? "").slice(0, index).split("\n").pop() || "";
  const words = [...line.matchAll(/[\p{L}][\p{L}\p{N}&.-]*/gu)].map(match => match[0].replace(/[.,;:]+$/, ""));
  for (let position = words.length - 1; position >= 0; position--) {
    const word = words[position];
    if (!/^\p{Lu}/u.test(word)) continue;
    if (ANCHOR_STOPWORDS.has(word.toLowerCase())) continue;
    if (word.length < 2) continue;
    return { key: word.toLowerCase(), display: word };
  }
  return null;
}

/**
 * Konsekvenskontroll: årtalsperioder är det mest faktatunga i ett CV och det som
 * lättast hamnar i konflikt när Gemini skriver om flera sektioner samtidigt.
 *
 * block: en bakvänd period (2025–2019) får aldrig skrivas in.
 * warn: en period som inte finns i CV:t, eller samma företeelse med olika perioder.
 *       En legitim omformatering ska inte låsa flödet, så dessa avgör användaren.
 *
 * Perioder jämförs normaliserade, så "2019–nu", "2019 - nu" och "2019–pågående" är samma sak.
 */
export function checkProposalConsistency({ proposals = [], cvText = "" } = {}) {
  const findings = [];
  const known = new Set(yearRanges(cvText).map(range => range.key));
  const anchors = new Map();
  for (const proposal of proposals || []) {
    const text = String(proposal?.text ?? "");
    for (const range of yearRanges(text)) {
      if (typeof range.end === "number" && range.end < range.start) {
        findings.push({ level: "block", tag: proposal.tag, message: t("The period {period} is reversed.", { period: range.text }) });
        continue;
      }
      if (!known.has(range.key)) {
        findings.push({ level: "warn", tag: proposal.tag, message: t("The period {period} is not found in the CV.", { period: range.text }) });
      }
    }
    for (const match of text.matchAll(YEAR_RANGE_PATTERN)) {
      const anchor = rangeAnchor(text, match.index);
      if (!anchor) continue;
      if (!anchors.has(anchor.key)) anchors.set(anchor.key, { display: anchor.display, keys: new Set(), tags: new Set() });
      const entry = anchors.get(anchor.key);
      const range = rangeFromMatch(match);
      entry.keys.add(range.key.replace(/-/g, "–"));
      entry.tags.add(proposal.tag);
    }
  }
  for (const entry of anchors.values()) {
    if (entry.keys.size < 2) continue;
    findings.push({
      level: "warn",
      tag: null,
      message: t("{name} is stated with different periods ({periods}).", { name: entry.display, periods: [...entry.keys].join(", ") })
    });
  }
  return findings;
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ *
 * Ordmarkerad diff och skärpt fabriceringsskydd
 * ------------------------------------------------------------------ */

const TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}+#./%-]*/gu;
const WORD_PATTERN = /\s+|[^\s]+/g;

function pushDiffPart(parts, type, value) {
  const last = parts[parts.length - 1];
  if (last && last.type === type) last.text += value;
  else parts.push({ type, text: value });
}

/**
 * Ordvis diff (LCS) mellan original och förslag, så att granskningen kan visa exakt
 * vad som lades till och togs bort. Mycket stora texter jämförs som hela block.
 */
export function wordDiff(before, after) {
  const a = String(before ?? "").match(WORD_PATTERN) || [];
  const b = String(after ?? "").match(WORD_PATTERN) || [];
  if (a.length * b.length > 200000) {
    return [{ type: "del", text: String(before ?? "") }, { type: "ins", text: String(after ?? "") }];
  }
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const parts = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pushDiffPart(parts, "same", a[i]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      pushDiffPart(parts, "del", a[i]);
      i++;
    } else {
      pushDiffPart(parts, "ins", b[j]);
      j++;
    }
  }
  while (i < a.length) pushDiffPart(parts, "del", a[i++]);
  while (j < b.length) pushDiffPart(parts, "ins", b[j++]);
  return parts;
}

function isSentenceStart(text, index) {
  for (let position = index - 1; position >= 0; position--) {
    if (/\s/.test(text[position])) continue;
    return /[.!?:]/.test(text[position]);
  }
  return true;
}

/**
 * Skyddsnät utöver kompetensnamnen: årtal, siffror och egennamn som läggs till men
 * varken finns i originaltexten, CV:t eller annonsen är typiska spår av påhittad
 * erfarenhet. Siffror blockeras, egennamn varnas om.
 */
export function findUnverifiedAdditions({ tag, original = "", proposal = "", cvText = "", jobText = "" }) {
  const known = `${original}\n${cvText}\n${jobText}`.toLowerCase();
  const inserted = wordDiff(original, proposal)
    .filter(part => part.type === "ins")
    .map(part => part.text)
    .join(" ");
  const findings = [];
  const seen = new Set();
  for (const match of inserted.matchAll(TOKEN_PATTERN)) {
    const token = match[0].replace(/[.,;:]+$/, "");
    if (token.length < 2 || seen.has(token)) continue;
    const hasDigit = /\d/.test(token);
    const capitalized = /^\p{Lu}/u.test(token);
    if (!hasDigit && !capitalized) continue;
    if (known.includes(token.toLowerCase())) continue;
    // Ett versalt ord i början av en mening är oftast bara meningsstart, inte ett egennamn.
    const techLike = hasDigit || token === token.toUpperCase();
    if (capitalized && !techLike && isSentenceStart(inserted, match.index)) continue;
    seen.add(token);
    findings.push({ tag, term: token, severity: hasDigit ? "block" : "warn" });
  }
  return findings;
}

/* ------------------------------------------------------------------ *
 * Inställningar, modellstatistik och datastyrning
 * ------------------------------------------------------------------ */

/**
 * Inställningarna ligger lokalt (API-nyckeln får aldrig lämna datorn) och, utan nyckel,
 * även i chrome.storage.sync så att man slipper mata in allt igen på en ny dator.
 */
/**
 * Lägger till eller tar bort en dygnsgräns för en modell utan att röra andra modellers
 * gränser. Arbetar på en kopia så att anroparens objekt aldrig muteras.
 */
export function withDailyLimit(dailyLimits, model, limit) {
  const next = { ...(dailyLimits || {}) };
  const value = Math.floor(Number(limit));
  if (Number.isFinite(value) && value > 0) next[model] = value;
  else delete next[model];
  return next;
}

export async function readSettings() {
  const local = await chrome.storage.local.get(["settings", "settingsStamp"]).catch(() => ({}));
  const synced = await chrome.storage.sync.get(["settings", "settingsStamp"]).catch(() => ({}));
  const localSettings = local?.settings || {};
  // Inställningarna sparas som ett snapshot med en tidsstämpel per lagring.
  const localStamp = Number(local?.settingsStamp) || 0;
  const syncedStamp = Number(synced?.settingsStamp) || 0;
  // Bara synkade värden som är nyare än de lokala får slå igenom. En misslyckad
  // sync-skrivning lämnar gamla värden kvar i sync, och de får aldrig rulla tillbaka
  // en ändring som redan sparats lokalt. API-nyckeln hämtas alltid lokalt.
  // Saknas lokala inställningar helt (ny profil, eller en sync-post från en äldre version
  // utan tidsstämpel) finns inget att skydda och då gäller synken.
  const useSynced = syncedStamp > localStamp || (!local?.settings && Boolean(synced?.settings));
  return { ...localSettings, ...(useSynced ? synced?.settings || {} : {}), apiKey: localSettings.apiKey || "" };
}

export async function writeSettings(settings) {
  // API-nyckeln stannar i den här profilen; allt annat får synkas.
  const { apiKey = "", ...syncable } = settings;
  const stamp = Date.now();
  await chrome.storage.local.set({ settings: { ...syncable, apiKey }, settingsStamp: stamp });
  try {
    await chrome.storage.sync.set({ settings: syncable, settingsStamp: stamp });
  } catch {
    // Synk är bekvämlighet. Ändringen ligger kvar lokalt med sin tidsstämpel och kan
    // därför inte skrivas över av äldre värden som blev kvar i sync.
  }
}

/**
 * Historiken över skapade CV:n är en bekvämlighet, inte ett arkiv. Posterna gallras
 * därför automatiskt: poster utan id räknas som skräp, poster äldre än
 * HISTORY_MAX_AGE_DAYS tas bort och listan kapas till HISTORY_LIMIT. Poster med
 * okänt datum behålls, eftersom de kan komma från en äldre version av tillägget.
 */
export const HISTORY_LIMIT = 100;
export const HISTORY_MAX_AGE_DAYS = 180;

export function pruneHistory(entries, { now = Date.now(), limit = HISTORY_LIMIT, maxAgeDays = HISTORY_MAX_AGE_DAYS } = {}) {
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  return (Array.isArray(entries) ? entries : [])
    .filter(entry => entry && typeof entry.id === "string" && entry.id)
    .map(entry => ({ entry, at: Date.parse(entry.createdAt) }))
    .filter(({ at }) => !Number.isFinite(at) || at >= cutoff)
    .sort((a, b) => (Number.isFinite(b.at) ? b.at : -Infinity) - (Number.isFinite(a.at) ? a.at : -Infinity))
    .slice(0, Math.max(0, limit))
    .map(({ entry }) => entry);
}

export async function clearAnalysisCache() {
  await chrome.storage.local.remove("jobAnalyses");
}

export async function clearUsageCounter() {
  await chrome.storage.local.remove("geminiUsage");
}

/** Raderar allt som tillägget sparat: nycklar, cachar, räknare, historik och Google-anslutning. */
export async function clearAllData() {
  const settings = await readSettings();
  const { apiKey, googleConnectedAt, ...rest } = settings;
  await writeSettings(rest);
  await chrome.storage.local.remove(["jobAnalyses", "geminiUsage", "modelStats", "history", "lastError"]);
  try {
    await chrome.storage.session.remove(["pendingJob", "lastError"]);
  } catch {
    // session-lagringen kan saknas i äldre Chrome; resten är redan rensat.
  }
  try {
    await chrome.identity.clearAllCachedAuthTokens();
  } catch {
    // Ingen token att rensa.
  }
}

export async function readModelStats() {
  try {
    const { modelStats = {} } = await chrome.storage.local.get("modelStats");
    return modelStats;
  } catch {
    return {};
  }
}

export async function recordModelResult(modelId, ok) {
  try {
    const stats = await readModelStats();
    const entry = stats[modelId] || { ok: 0, fail: 0 };
    if (ok) entry.ok += 1;
    else entry.fail += 1;
    stats[modelId] = entry;
    await chrome.storage.local.set({ modelStats: stats });
  } catch {
    // Statistik är en optimering och får aldrig stoppa ett anrop.
  }
}

/**
 * Ordnar modellerna efter hur ofta de faktiskt svarat. Ett svagt prior (1 av 2) gör att
 * en enstaka motgång inte kastar om listan, och lika resultat behåller användarens ordning.
 */
export async function rankedModelOrder(modelIds) {
  const unique = [...new Set(modelIds.filter(id => FREE_MODEL_IDS.has(id)))];
  const stats = await readModelStats();
  return unique
    .map((id, index) => {
      const { ok = 0, fail = 0 } = stats[id] || {};
      return { id, index, score: (ok + 1) / (ok + fail + 2) };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.id);
}

/* ------------------------------------------------------------------ *
 * Mallkontroll (onboarding)
 * ------------------------------------------------------------------ */


/**
 * Läser mallen och sammanfattar vad som är taggat och vilka rubriker som ser ut som
 * sektioner men saknar taggar. Originalmallen ändras aldrig — förslagen är text att klistra in.
 */
export function summarizeTemplate(doc) {
  const parsed = parseTemplate(doc);
  const content = documentText(doc) || "";
  const missingHeadings = TEMPLATE_SECTIONS
    .map(([tag, pattern, label]) => ({ tag, label, pattern }))
    .filter(({ pattern }) => new RegExp(`(?:^|\\n)\\s*(?:${pattern})\\s*:?\\s*(?:\\n|$)`, "i").test(content))
    .filter(({ tag }) => !parsed.sections.some(section => section.tag === tag))
    .map(({ tag, label }) => ({ tag, label }));
  return {
    sections: parsed.sections.map(section => ({ tag: section.tag, text: section.original })),
    errors: parsed.errors,
    missingHeadings
  };
}

/* ------------------------------------------------------------------ *
 * Google OAuth och REST
 * ------------------------------------------------------------------ */

/** Escapar text som ska in i HTML; sidorna bygger listrader som strängar. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

/** Känd dygnsgräns för en modell: från ett 429-svar eller användarens inställning. */
export function dailyLimitFor(usage, settings = {}, model) {
  return usage.limits[model] || Number(settings.dailyLimits?.[model]) || 0;
}

/* ------------------------------------------------------------------ *
 * Mallar och språk
 * ------------------------------------------------------------------ */

export const LANGUAGES = ["sv", "en"];
export const DEFAULT_LANGUAGE = "sv";


/**
 * Mallistan. Nya inställningar har en lista med namn och länkar, äldre har en enda
 * templateUrl. Originalmallen ändras aldrig; listan avgör bara vilka mallar som får
 * kopieras.
 */
export function resolveTemplates(settings = {}) {
  const templates = (Array.isArray(settings.templates) ? settings.templates : [])
    .map(item => ({ name: String(item?.name || "").trim() || t("Unnamed template"), url: String(item?.url || "").trim() }))
    .filter(item => item.url);
  if (templates.length) return templates;
  return settings.templateUrl ? [{ name: t("My template"), url: String(settings.templateUrl).trim() }] : [];
}

export async function getGoogleToken(interactive = true) {
  const result = await chrome.identity.getAuthToken({ interactive });
  if (!result?.token) throw new Error(t("Google returned no access token."));
  return result.token;
}

export async function googleRequest(url, options = {}) {
  const token = await getGoogleToken(true);
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  if (response.status === 401) {
    await chrome.identity.removeCachedAuthToken({ token });
    throw new Error(t("The Google sign-in has expired. Try again."));
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || t("Google API error ({status}).", { status: response.status }));
  return data;
}

export async function getDoc(documentId) {
  return googleRequest(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`);
}

export async function copyTemplate(documentId, title) {
  return googleRequest(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(documentId)}/copy?fields=id,name,webViewLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: title })
  });
}

/* ------------------------------------------------------------------ *
 * Google Docs struktur
 *
 * Google Docs adresserar innehåll med absoluta index. Ett stycke är en
 * strukturell enhet vars text består av en eller flera textRun, och varje
 * textRun har ett eget startIndex. Index kan därför inte härledas genom att
 * räkna tecken i en tillplattad textsträng: hopp mellan stycken, tabellceller
 * och inbäddade objekt förskjuter indexen. Allt nedan arbetar därför med
 * dokumentets egna strukturella index.
 * ------------------------------------------------------------------ */

function paragraphRecord(element) {
  const paragraph = element?.paragraph;
  if (!paragraph) return null;
  const runs = [];
  for (const item of paragraph.elements || []) {
    const content = item?.textRun?.content;
    if (typeof content !== "string" || content.length === 0) continue;
    runs.push({ startIndex: item.startIndex, text: content, textStyle: item.textRun.textStyle || {} });
  }
  const indexMap = [];
  let text = "";
  for (const run of runs) {
    for (let offset = 0; offset < run.text.length; offset++) indexMap.push(run.startIndex + offset);
    text += run.text;
  }
  return {
    startIndex: element.startIndex,
    endIndex: element.endIndex,
    text,
    indexMap,
    runs,
    // Punktlistor och numrering hör till stycket, inte till texten. Känner vi igen
    // dem kan texten bytas ut utan att listformatet förstörs.
    bullet: Boolean(paragraph.bullet),
    listId: paragraph.bullet?.listId || null
  };
}

export function collectContainers(doc) {
  const containers = [];
  const walk = (content, path) => {
    let paragraphs = null;
    const flush = () => {
      if (paragraphs && paragraphs.length) containers.push({ id: containers.length, path, paragraphs });
      paragraphs = null;
    };
    for (const element of content || []) {
      if (element?.paragraph) {
        const record = paragraphRecord(element);
        if (!record) continue;
        if (!paragraphs) paragraphs = [];
        const previous = paragraphs[paragraphs.length - 1];
        record.offsetStart = previous ? previous.offsetEnd : 0;
        record.offsetEnd = record.offsetStart + record.text.length;
        paragraphs.push(record);
        continue;
      }
      // Tabeller och andra strukturelement bryter textflödet: taggar får inte
      // sträcka sig över en sådan gräns.
      flush();
      if (element?.table?.tableRows) {
        element.table.tableRows.forEach((row, rowIndex) => (row.tableCells || []).forEach((cell, cellIndex) => {
          walk(cell.content, `${path} › tabell ${rowIndex + 1}:${cellIndex + 1}`);
        }));
      }
      if (element?.tableOfContents?.content) walk(element.tableOfContents.content, `${path} › ${t("table of contents")}`);
    }
    flush();
  };
  walk(doc?.body?.content, t("body"));
  return containers;
}

/**
 * Signatur för dokumentets struktur utan textinnehåll: antal textbehållare och
 * tabellernas form. Används för att verifiera att en redigering inte har byggt
 * om dokumentet utanför de taggade sektionerna.
 */
export function structureSignature(doc) {
  const tables = [];
  const walk = content => {
    for (const element of content || []) {
      if (element?.table?.tableRows) {
        tables.push(element.table.tableRows.map(row => (row.tableCells || []).length));
        for (const row of element.table.tableRows) for (const cell of row.tableCells || []) walk(cell.content);
      }
      if (element?.tableOfContents?.content) walk(element.tableOfContents.content);
    }
  };
  walk(doc?.body?.content);
  return JSON.stringify({ containers: collectContainers(doc).length, tables });
}

export function documentText(doc) {
  return collectContainers(doc).map(container => container.paragraphs.map(paragraph => paragraph.text).join("")).join("\n");
}

function styleRunAt(container, absoluteIndex) {
  for (const paragraph of container.paragraphs) {
    for (const run of paragraph.runs) {
      if (absoluteIndex >= run.startIndex && absoluteIndex < run.startIndex + run.text.length) return run;
    }
  }
  return null;
}

/** Textstil som ska gälla för ersättningstexten i en sektion. */
function textStylePayload(style) {
  if (!style) return null;
  const value = {};
  for (const [key, entry] of Object.entries(style)) {
    if (key === "link" || entry === null || entry === undefined) continue;
    value[key] = entry;
  }
  const fields = Object.keys(value);
  if (!fields.length) return null;
  return { value, fields: fields.join(",") };
}

function buildSection({ container, text, indexMap, open, close, documentEnd }) {
  const openStart = indexMap[open.from];
  const openEnd = indexMap[open.to - 1] + 1;
  const closeStart = indexMap[close.from];
  const closeEnd = indexMap[close.to - 1] + 1;
  const openToken = text.slice(open.from, open.to);
  const closeToken = text.slice(close.from, close.to);
  const openStandalone = isTagOnlyParagraph(open.paragraph, openToken);
  const closeStandalone = isTagOnlyParagraph(close.paragraph, closeToken);
  // En tagg som står ensam på sin rad tas bort tillsammans med radbrytningen,
  // annars lämnas tomma stycken kvar i CV:t.
  const openWholeParagraph = openStandalone && canRemoveParagraph(container, open.paragraph, documentEnd);
  const closeWholeParagraph = closeStandalone && canRemoveParagraph(container, close.paragraph, documentEnd);

  const contentStartOffset = openWholeParagraph ? open.paragraph.offsetEnd : open.to;
  const contentEndOffset = closeWholeParagraph ? close.paragraph.offsetStart : close.from;
  if (contentEndOffset < contentStartOffset) return { error: t("The section [{tag}] has indexes out of order and cannot be edited.", { tag: open.name }) };
  const contentText = text.slice(contentStartOffset, contentEndOffset);
  if (!contentText.trim()) return { error: t("The section [{tag}] is empty. Add content or remove the tag before the CV is created.", { tag: open.name }) };

  const contentStart = contentStartOffset < indexMap.length ? indexMap[contentStartOffset] : closeStart;
  const contentEnd = contentEndOffset < indexMap.length ? indexMap[contentEndOffset] : closeStart;

  // Vilka stycken som ingår i sektionen och var deras text ligger. Används för att
  // byta text per stycke i stället för att radera hela intervallet: styckebrotten
  // bär listformatet, så de måste få ligga kvar.
  const paragraphSpans = [];
  for (const paragraph of container.paragraphs) {
    const spanStart = Math.max(contentStart, paragraph.startIndex);
    const spanEnd = Math.min(contentEnd, paragraph.text.endsWith("\n") ? paragraph.endIndex - 1 : paragraph.endIndex);
    if (spanEnd <= spanStart) continue;
    paragraphSpans.push({
      startIndex: spanStart,
      endIndex: spanEnd,
      bullet: Boolean(paragraph.bullet),
      text: paragraph.text.replace(/\n$/, "")
    });
  }

  const styles = new Set();
  for (const paragraph of container.paragraphs) {
    for (const run of paragraph.runs) {
      const runEnd = run.startIndex + run.text.length;
      if (runEnd <= contentStart || run.startIndex >= contentEnd) continue;
      if (!run.text.replace(/[\n\u000b]/g, "")) continue;
      styles.add(JSON.stringify(run.textStyle || {}));
    }
  }

  return {
    tag: open.name,
    containerId: container.id,
    original: contentText.replace(/\n$/, ""),
    contentText,
    contentStart,
    contentEnd,
    openStart,
    spanFrom: openWholeParagraph ? open.paragraph.offsetStart : open.from,
    spanTo: closeWholeParagraph ? close.paragraph.offsetEnd : close.to,
    openDelete: openWholeParagraph
      ? { startIndex: open.paragraph.startIndex, endIndex: open.paragraph.endIndex }
      : { startIndex: openStart, endIndex: openEnd },
    closeDelete: closeWholeParagraph
      ? { startIndex: close.paragraph.startIndex, endIndex: close.paragraph.endIndex }
      : { startIndex: closeStart, endIndex: closeEnd },
    style: textStylePayload(styleRunAt(container, contentStart)?.textStyle),
    paragraphSpans,
    paragraphCount: paragraphSpans.length,
    listParagraphs: paragraphSpans.filter(span => span.bullet).length,
    mixedFormatting: styles.size > 1,
    multiParagraph: contentText.includes("\n")
  };
}

function isTagOnlyParagraph(paragraph, token) {
  return paragraph.text.replace(/\n$/, "").trim() === token;
}

function canRemoveParagraph(container, paragraph, documentEnd) {
  // Det sista stycket i dokumentet får behålla sin radbrytning, och en
  // tabellcell måste alltid innehålla minst ett stycke.
  return container.paragraphs.length > 1 && (paragraph.endIndex ?? 0) < documentEnd;
}

/**
 * Tolkar dokumentets taggade sektioner. Returnerar alltid errors-listan; om den
 * innehåller något får dokumentet inte redigeras.
 */
export function parseTemplate(doc) {
  const containers = collectContainers(doc);
  const allParagraphs = containers.flatMap(container => container.paragraphs);
  const documentEnd = allParagraphs.reduce((max, paragraph) => Math.max(max, paragraph.endIndex ?? paragraph.startIndex ?? 1), 1);
  const sections = [];
  const errors = [];
  const seen = new Set();

  for (const container of containers) {
    const text = container.paragraphs.map(paragraph => paragraph.text).join("");
    const indexMap = [];
    for (const paragraph of container.paragraphs) indexMap.push(...paragraph.indexMap);
    const paragraphAt = offset => {
      for (const paragraph of container.paragraphs) {
        if (offset >= paragraph.offsetStart && offset < paragraph.offsetEnd) return paragraph;
      }
      return container.paragraphs[container.paragraphs.length - 1];
    };

    const pattern = new RegExp(TAG_TOKEN_SOURCE, "gu");
    let match;
    let open = null;
    while ((match = pattern.exec(text)) !== null) {
      const token = match[0];
      const name = match[2];
      if (!looksLikeTagName(name)) continue;
      const from = match.index;
      const to = from + token.length;
      const startParagraph = paragraphAt(from);
      const endParagraph = paragraphAt(to - 1);
      if (startParagraph !== endParagraph) {
        errors.push(t("The tag {tag} is split across a paragraph break and cannot be removed safely.", { tag: token }));
        continue;
      }
      if (match[1] !== "/") {
        if (open) errors.push(t("The tag [{open}] is never closed before [{tag}] begins. Nested tags are not supported.", { open: open.name, tag: name }));
        open = { name, from, to, paragraph: startParagraph };
        continue;
      }
      if (!open) {
        errors.push(t("The tag {tag} has no matching opening tag.", { tag: token }));
        continue;
      }
      if (open.name !== name) {
        errors.push(t("The tag [{open}] is closed by {tag}. Tag names must be identical.", { open: open.name, tag: token }));
        open = null;
        continue;
      }
      const section = buildSection({ container, text, indexMap, open, close: { from, to, paragraph: startParagraph }, documentEnd });
      if (section.error) {
        errors.push(section.error);
      } else if (seen.has(name)) {
        errors.push(t("The tag name [{tag}] is used more than once. Each section must have a unique tag name.", { tag: name }));
      } else {
        seen.add(name);
        sections.push(section);
      }
      open = null;
    }
    if (open) errors.push(t("The tag [{tag}] has no closing [/{tag}].", { tag: open.name }));
  }

  return { containers, sections, errors, documentEnd, structure: structureSignature(doc) };
}

function toApprovedMap(approved) {
  if (approved instanceof Map) return approved;
  if (Array.isArray(approved)) return new Map(approved.map(item => [item?.tag, String(item?.text ?? "")]));
  return new Map(Object.entries(approved || {}));
}

function resolveReplacement(section, approvedText) {
  let text = String(approvedText ?? "");
  if (text.length && /\n$/.test(section.contentText) && !/\n$/.test(text)) text += "\n";
  return { changed: normalizeForCompare(text) !== normalizeForCompare(section.contentText), text };
}

/**
 * Returnerar en rad per stycke när sektionen består av flera stycken och förslaget
 * har exakt samma antal rader. Då kan texten bytas stycke för stycke och
 * listformatet bevaras. Ändras antalet rader går det inte att mappa raderna
 * säkert, och då används en vanlig ersättning av hela intervallet.
 */
function parallelLines(section, requested) {
  const spans = section.paragraphSpans || [];
  if (spans.length < 2) return null;
  const lines = String(requested ?? "").split("\n");
  return lines.length === spans.length ? lines : null;
}

/** Bygger de batchUpdate-request som redigerar kopian. */
export function buildUpdateRequests(parsed, approved) {
  const approvedMap = toApprovedMap(approved);
  const requests = [];
  const ordered = [...parsed.sections].sort((a, b) => b.openStart - a.openStart);
  for (const section of ordered) {
    const requested = approvedMap.get(section.tag) ?? section.contentText;
    const replacement = resolveReplacement(section, requested);
    // Requesten tillämpas i ordning. Genom att arbeta bakifrån i dokumentet
    // påverkas aldrig index för sektioner som ännu inte redigerats.
    requests.push({ deleteContentRange: { range: { ...section.closeDelete } } });
    if (replacement.changed) {
      const lines = parallelLines(section, requested);
      if (lines) {
        // En rad per stycke: byt bara texten inne i varje stycke, så att
        // styckebrotten, punkterna och numreringen ligger kvar orörda.
        for (let index = section.paragraphSpans.length - 1; index >= 0; index--) {
          const span = section.paragraphSpans[index];
          const line = lines[index];
          if (span.endIndex > span.startIndex) {
            requests.push({ deleteContentRange: { range: { startIndex: span.startIndex, endIndex: span.endIndex } } });
          }
          if (line.length) {
            requests.push({ insertText: { location: { index: span.startIndex }, text: line } });
            if (section.style) {
              requests.push({
                updateTextStyle: {
                  range: { startIndex: span.startIndex, endIndex: span.startIndex + line.length },
                  textStyle: section.style.value,
                  fields: section.style.fields
                }
              });
            }
          }
        }
      } else {
        if (section.contentEnd > section.contentStart) {
          requests.push({ deleteContentRange: { range: { startIndex: section.contentStart, endIndex: section.contentEnd } } });
        }
        if (replacement.text.length) {
          requests.push({ insertText: { location: { index: section.contentStart }, text: replacement.text } });
          if (section.style) {
            requests.push({
              updateTextStyle: {
                range: { startIndex: section.contentStart, endIndex: section.contentStart + replacement.text.length },
                textStyle: section.style.value,
                fields: section.style.fields
              }
            });
          }
        }
      }
    }
    requests.push({ deleteContentRange: { range: { ...section.openDelete } } });
  }
  return requests;
}

/** Den text dokumentet ska ha efter redigeringen, utan taggar. */
export function expectedDocumentText(parsed, approved) {
  const approvedMap = toApprovedMap(approved);
  return parsed.containers.map(container => {
    const own = parsed.sections.filter(section => section.containerId === container.id).sort((a, b) => b.spanFrom - a.spanFrom);
    let text = container.paragraphs.map(paragraph => paragraph.text).join("");
    for (const section of own) {
      const replacement = resolveReplacement(section, approvedMap.get(section.tag) ?? section.contentText);
      const next = replacement.changed ? replacement.text : section.contentText;
      text = text.slice(0, section.spanFrom) + next + text.slice(section.spanTo);
    }
    return text;
  }).join("\n");
}

export function normalizeDocumentText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").split("\n").map(line => line.replace(/[ \t]+$/, "")).join("\n").trim();
}

function describeDifference(expected, actual) {
  let index = 0;
  while (index < expected.length && index < actual.length && expected[index] === actual[index]) index++;
  const from = Math.max(0, index - 40);
  const expectedExcerpt = expected.slice(from, index + 60).replace(/\n/g, "⏎");
  const actualExcerpt = actual.slice(from, index + 60).replace(/\n/g, "⏎");
  return t("Expected: \"{expected}\"\nActual: \"{actual}\"", { expected: expectedExcerpt, actual: actualExcerpt });
}

/** Läser tillbaka kopian och kontrollerar att den godkända texten är exakt det som skrevs. */
export async function verifyCopiedDoc(copyId, parsed, approved) {
  const copyDoc = await getDoc(copyId);
  if (structureSignature(copyDoc) !== parsed.structure) {
    throw new Error(t("The copy's structure (paragraphs, tables or cells) differs from the template after editing. The document was not approved."));
  }
  const expected = normalizeDocumentText(expectedDocumentText(parsed, approved));
  const actual = normalizeDocumentText(documentText(copyDoc));
  if (actual !== expected) {
    throw new Error(t("The Google Docs copy does not match the approved text. No CV was approved. {difference}", { difference: describeDifference(expected, actual) }));
  }
  const remaining = findTagTokens(actual);
  if (remaining.length) {
    throw new Error(t("Tags remain in the created copy ({tags}). Check the document before using it.", { tags: [...new Set(remaining)].join(", ") }));
  }
  return { text: actual };
}

/**
 * Tar bort en kopia som inte kunde godkännas, så att inget halvfärdigt CV blir
 * liggande i Drive. Får aldrig kasta: ett städfel ska inte skymma originalfelet.
 */
export async function discardCopiedDoc(fileId) {
  try {
    await googleRequest(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Uppdaterar en kopia av mallen. Kopian läses om från Google Docs innan
 * redigeringen så att indexen alltid kommer från det dokument som faktiskt
 * ändras, aldrig från en tidigare hämtad mall.
 */
export async function updateCopiedDoc(copyId, approvedSections) {
  const copyDoc = await getDoc(copyId);
  const parsed = parseTemplate(copyDoc);
  if (parsed.errors.length) throw new Error(`${t("The copy cannot be edited safely:")}\n${parsed.errors.join("\n")}`);
  if (!parsed.sections.length) throw new Error(t("The copy contains no [TAG]...[/TAG] sections."));
  const approved = toApprovedMap(approvedSections);
  for (const [tag, text] of approved) {
    if (typeof text !== "string") throw new Error(t("The proposal for [{tag}] is not text.", { tag }));
    assertSafeProposalText(tag, text);
  }
  const copyTags = new Set(parsed.sections.map(section => section.tag));
  const missing = parsed.sections.filter(section => !approved.has(section.tag)).map(section => section.tag);
  if (missing.length) throw new Error(t("The following sections in the copy have no approved proposal: {list}.", { list: missing.join(", ") }));
  const unknown = [...approved.keys()].filter(tag => !copyTags.has(tag));
  if (unknown.length) throw new Error(t("The proposals contain tags that are not in the copy: {list}. The copy has changed since the review.", { list: unknown.join(", ") }));
  const requests = buildUpdateRequests(parsed, approved);
  if (!requests.length) throw new Error(t("No changes could be calculated for the copy."));
  await googleRequest(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(copyId)}:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests })
  });
  await verifyCopiedDoc(copyId, parsed, approved);
  return { requestCount: requests.length };
}
