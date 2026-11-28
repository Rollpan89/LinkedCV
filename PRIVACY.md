# Privacy policy – CV Adapter

Last updated: 27 November 2026

CV Adapter is a Chrome extension that adapts a CV stored in the user's own
Google Docs to a job ad the user is viewing. It has no backend of its own.

## What the extension processes

- **Job ad text** from the LinkedIn job page that the user explicitly captures
  with the context menu.
- **CV text** from the Google Docs template whose link the user has added in
  Settings.
- **A Gemini API key** that the user creates in Google AI Studio and enters in
  Settings.
- **A Google OAuth token** obtained through Chrome's identity API when the user
  connects their Google account.

## Where data goes

- Job ad text and CV text are sent to the **Google Gemini API**
  (`generativelanguage.googleapis.com`) using the user's own API key, to analyse
  requirements and to draft section proposals.
- The template and the created copy are read and written through the
  **Google Docs and Drive APIs** (`docs.googleapis.com`, `www.googleapis.com`)
  with the user's OAuth token.
- No other server is contacted. The extension contains no analytics, no
  telemetry, no advertising and no remote code.

## What is stored, and for how long

Stored locally in the user's Chrome profile (`chrome.storage.local`). The Google
OAuth token is managed by Chrome's identity API and is not stored by the
extension:

- the Gemini API key (never synced, never sent anywhere except Google's API);
- settings, which are synced across the user's Chrome profiles **without** the
  API key or any CV content;
- cached requirement analyses and the daily request counter;
- a history of created documents (role, company, link, timestamp), pruned
  automatically to 100 entries and 180 days.

The user can delete the cached analyses, the request counter, the history and
all local data from Settings at any time.

## Google user data

The extension's use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements. Google user data is used only to
perform the single purpose described above, is not transferred to third parties
other than the service providers named here, and is not used for advertising.

## Children

The extension is not directed at children under 13 and does not knowingly
process their data.

## Changes

Material changes to this policy will be published at this URL and noted in the
extension's changelog.

## Contact

Questions about this policy: _add a contact address before publishing_.
