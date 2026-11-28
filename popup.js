import { readSettings } from "./shared.js";
import { getUiLanguage, startI18n, t } from "./i18n.js";

const $ = id => document.getElementById(id);
const settings = await readSettings();
startI18n(settings);
const { history = [] } = await chrome.storage.local.get("history");
const { lastError = "" } = await chrome.storage.session.get("lastError");
if (lastError) { $("errorPanel").hidden = false; $("errorPanel").textContent = lastError; }
const dateLocale = getUiLanguage() === "sv" ? "sv-SE" : "en-GB";
const sorted = [...history].sort((a,b) => b.createdAt.localeCompare(a.createdAt));
if (sorted.length) {
  const latest = sorted[0];
  $("latest").innerHTML = `<div class="latest"><span class="pill">${t("Done").toUpperCase()}</span><strong>${escapeHtml(latest.role || t("Adapted CV"))}</strong><span>${escapeHtml(latest.company || "")}</span><a class="primary-link" href="${escapeHtml(latest.url)}" target="_blank" rel="noopener noreferrer">${t("Open latest CV")} <span>↗</span></a><small>${new Date(latest.createdAt).toLocaleString(dateLocale)}</small></div>`;
  $("history").innerHTML = sorted.slice(0,5).map(item => `<a class="history-item" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer"><span><b>${escapeHtml(item.role || t("CV"))}</b><small>${escapeHtml(item.company || "")}</small></span><span>↗</span></a>`).join("");
} else { $("history").innerHTML = `<p class="hint">${t("History is empty.")}</p>`; }
$("clearHistory").addEventListener("click", async () => { await chrome.storage.local.set({ history: [] }); location.reload(); });
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
function escapeHtml(v) { return String(v || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
