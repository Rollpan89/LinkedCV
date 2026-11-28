# Launch checklist – Chrome Web Store and Google OAuth

This file collects the manual steps that cannot be done from the code base.
Everything here is written so it can be copied into the Google Cloud Console,
the Chrome Web Store developer dashboard or an email to Google.

## 1. Google OAuth verification (longest lead time)

The extension requests two Google scopes in `manifest.json`:

| Scope | Class | Why it is needed |
| --- | --- | --- |
| `https://www.googleapis.com/auth/documents` | Sensitive | Read the tagged sections of the user's template and write the approved text into the copy. |
| `https://www.googleapis.com/auth/drive` | Restricted | Copy the user's own template into a new document in their Drive. |

The restricted `drive` scope triggers a **CASA Tier 2 security assessment** in
addition to normal OAuth verification. Plan for 4–6 weeks and a possible fee.

Steps in Google Cloud Console → APIs & Services → OAuth consent screen:

1. App name: **CV Adapter**. Support email, developer contact, logo (128×128).
2. Authorized domains: the domain that hosts the privacy policy.
3. Privacy policy URL: the hosted version of `PRIVACY.md`.
4. Scopes: add the two scopes above and paste the justification text below.
5. Demo video: record the full flow — paste template URL, check template,
   choose requirements, generate proposals, approve, open the created copy.
6. Submit for verification. When Google responds with the CASA questionnaire,
   answer it from `PRIVACY.md` and the data-flow description below.

### Scope justification (paste into the form)

> The extension adapts a CV that the user already owns in Google Docs to a job
> ad the user is currently viewing. `documents` is used to read the tagged
> sections of the template the user pasted and to write the text the user
> explicitly approved into the newly created copy. `drive` is used only for the
> Drive `files.copy` call that creates that copy from the user's own template.
> No file is listed, searched or modified without a direct user action, and the
> original template is never written to.

### Data flow summary (for CASA)

- Job ad text: read from the LinkedIn jobs page in the browser, sent to the
  Gemini API with the user's own API key.
- CV text: read from the user's Google Docs template, sent to the same Gemini
  API call for comparison.
- Google credentials: obtained through `chrome.identity`, never stored by the
  extension.
- Storage: API key and history stay in `chrome.storage.local` on the device;
  only non-secret settings are synced. No backend, no analytics.

### Until verification is complete

An unverified app with sensitive scopes shows the "Google hasn't verified this
app" warning and is capped at 100 users. Either accept that for a soft launch or
wait for verification before publishing.

## 2. Privacy policy and Chrome Web Store data disclosure

- Host `PRIVACY.md` at a public URL and use that URL in both consoles.
- Chrome Web Store → Privacy practices:
  - Single purpose: "Adapts the user's existing Google Docs CV to the job ad
    they are viewing on LinkedIn."
  - Data collected: website content (job ad), personal communications (CV text),
    authentication information (Google OAuth token handled by Chrome).
  - Certify: data is not sold, not used for advertising, not used for purposes
    unrelated to the single purpose, and not read by humans.
  - Justify each host permission: LinkedIn (read the job ad), Gemini (analysis
    and text generation), Google APIs (Drive/Docs copy).

## 3. Permissions

`tabs` was removed because `chrome.tabs.sendMessage`/`create` do not require it
and the context menu receives the tab URL through the LinkedIn host permission.
Keep `scripting` for the SPA fallback injection, and `identity` for OAuth.

## 4. Localisation

- UI language: English by default, Swedish selectable in Settings.
- CV output language: separate setting, unchanged.
- Manifest name/description: `_locales/en`, `_locales/sv` with `default_locale`.
- Store listing: English as the primary language, Swedish as an additional one.

## 5. Release

1. Bump `version` in `manifest.json` and `package.json`.
2. `npm test` must pass.
3. Load the unpacked extension, run the manual smoke test:
   - capture an ad from LinkedIn, analyse, generate, approve, open the copy;
   - switch the UI language to Swedish and back;
   - clear all data and confirm the API key and history are gone.
4. Upload the zip, fill in the listing, submit for review.
