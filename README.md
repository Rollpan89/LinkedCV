# CV Adapter – Chrome Extension (v1.0.0)

A Manifest V3 extension that reads a LinkedIn job ad, analyses a Google Docs CV
template with Gemini, shows the proposed changes for review and creates a
numbered copy of the template in Google Drive. The original template is never
modified.

The interface is in English by default; Swedish is available in Settings.
Swedish documentation: [README.sv.md](README.sv.md).

## What it does

- **Capture an ad**: right-click a LinkedIn job page and choose **Adapt to CV**.
  The ad text is read locally in the page, never by a remote server.
- **Requirement analysis**: Gemini compares the ad with the full CV text and
  returns each requirement with evidence from the ad and from the CV.
- **Your selection**: only the requirements you tick can influence the text.
  Skills without evidence are blocked unless you explicitly allow them.
- **Proposed changes**: a word-level diff per tagged section, editable before
  approval, with consistency and fabrication checks.
- **Create the copy**: only the text between `[TAG]` and `[/TAG]` is written to
  the new document; the tags are removed and everything outside is untouched.

## Install (development)

1. Clone the repository.
2. Open `chrome://extensions`, enable **Developer mode** and choose
   **Load unpacked**, then select this folder.
3. Open the extension's **Settings** and add:
   - a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey);
   - the link to a Google Docs template whose sections are wrapped in tags,
     for example `[PROFIL]…[/PROFIL]`;
   - connect your Google account.

## Template format

Only tagged sections are editable:

```
[PROFIL]
Systemutvecklare med nio års erfarenhet…
[/PROFIL]
```

Use **Check the template** in Settings to see which sections were found and
which headings look like sections but lack tags. Tags that are empty, nested,
duplicated or split across a paragraph break are rejected before anything is
copied.

## Privacy

- The Gemini API key is stored only in this Chrome profile and is never synced.
- Ad text and CV text are sent to the Gemini API with your own key.
- The template and the copy are handled through the Google Docs and Drive APIs.
- No backend, no analytics, no remote code.
- See [PRIVACY.md](PRIVACY.md) for the full policy.

## Development

```bash
npm install
npm test
```

Tests run with Node's built-in test runner and jsdom. They cover the content
script against saved LinkedIn pages, template parsing, Gemini fallbacks, quota
handling, the review flow and the settings page.

## Project files

- `manifest.json` – Manifest V3, permissions, OAuth, locales.
- `background.js` – context menu, capture and opening the review page.
- `content.js` – reads the job ad from the LinkedIn page.
- `preview.js` / `preview.html` – requirement selection, diff and creation.
- `options.js` / `options.html` – settings, templates, privacy controls.
- `popup.js` / `popup.html` – latest CV and history.
- `shared.js` – Gemini, Google Docs/Drive and template editing.
- `i18n.js` – English source strings and the Swedish dictionary.
- `_locales/` – extension name and description per browser language.
- `LAUNCH.md` – the manual steps for Chrome Web Store and Google OAuth.
