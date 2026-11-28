import { readSettings } from "./shared.js";
import { setUiLanguage, t } from "./i18n.js";

const MENU_ID = "adapt-cv-to-job";

/** Menyns text följer gränssnittsspråket, så den byggs om när inställningarna ändras. */
async function buildMenu() {
  let settings = {};
  try {
    settings = await readSettings();
  } catch {
    // Utan inställningar används engelska.
  }
  setUiLanguage(settings.uiLanguage);
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: t("Adapt to CV"), contexts: ["page", "selection"], documentUrlPatterns: ["https://www.linkedin.com/jobs/*"] });
  });
}

chrome.runtime.onInstalled.addListener(buildMenu);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.settings) return;
  buildMenu();
});

async function ensureContentScript(tabId) {
  // First try the already registered listener. If LinkedIn's SPA route was
  // entered after document_idle, inject explicitly and wait for its ping.
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "PING_CV_ADAPTER" });
    if (ping?.ok) return;
  } catch (_) {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: "PING_CV_ADAPTER" });
      if (ping?.ok) return;
    } catch (_) {}
  }
  throw new Error(t("Could not reach the extraction engine on the LinkedIn page. Reload the ad and try again."));
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  try {
    try {
      const settings = await readSettings();
      setUiLanguage(settings.uiLanguage);
    } catch {
      // Engelska används om inställningarna inte kan läsas.
    }
    await ensureContentScript(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_JOB_AD" });
    if (response?.error) throw new Error(response.error);
    const description = String(response?.description || "").trim();
    const diagnostics = response?.diagnostics || {};
    // Metadata and confidence are diagnostic only. Partial captures remain useful.
    if (description.length < 80) {
      throw new Error(t("Too little ad text could be extracted for a meaningful analysis ({count} characters). Open the full ad view and try again.", { count: description.length }));
    }
    await chrome.storage.session.set({ pendingJob: {
      text: String(response.text || "").slice(0, 30000), description: description.slice(0, 26000),
      title: response.title, company: response.company || "", location: response.location || "",
      employmentType: response.employmentType || "", diagnostics, url: tab.url, capturedAt: new Date().toISOString()
    }});
    await chrome.tabs.create({ url: chrome.runtime.getURL("preview.html") });
  } catch (error) {
    await chrome.storage.session.set({ lastError: error.message || String(error) });
    await chrome.action.openPopup().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === "CV_CREATED") {
    chrome.action.setBadgeText({ text: "✓" }); chrome.action.setBadgeBackgroundColor({ color: "#137a50" });
    sendResponse({ ok: true });
  }
  return false;
});
