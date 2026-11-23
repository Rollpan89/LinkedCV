const $ = id => document.getElementById(id);
const { history = [] } = await chrome.storage.local.get("history");
const { lastError = "" } = await chrome.storage.session.get("lastError");
if (lastError) { $("errorPanel").hidden = false; $("errorPanel").textContent = lastError; }
const sorted = [...history].sort((a,b) => b.createdAt.localeCompare(a.createdAt));
if (sorted.length) {
  const latest = sorted[0];
  $("latest").innerHTML = `<div class="latest"><span class="pill">KLART</span><strong>${escapeHtml(latest.role || "Anpassat CV")}</strong><span>${escapeHtml(latest.company || "")}</span><a class="primary-link" href="${escapeAttr(latest.url)}" target="_blank">Öppna senaste CV <span>↗</span></a><small>${new Date(latest.createdAt).toLocaleString("sv-SE")}</small></div>`;
  $("history").innerHTML = sorted.slice(0,5).map(item => `<a class="history-item" href="${escapeAttr(item.url)}" target="_blank"><span><b>${escapeHtml(item.role || "CV")}</b><small>${escapeHtml(item.company || "")}</small></span><span>↗</span></a>`).join("");
} else { $("history").innerHTML = `<p class="hint">Historiken är tom.</p>`; }
$("clearHistory").addEventListener("click", async () => { await chrome.storage.local.set({ history: [] }); location.reload(); });
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
function escapeHtml(v) { return String(v || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function escapeAttr(v) { return escapeHtml(v); }
