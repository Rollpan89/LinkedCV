# Changelog

## 1.0.0 – Chrome Web Store release

**Interface**

- The interface is now in English by default, with Swedish selectable under
  **Settings → Interface language**. The language of the generated CV text is a
  separate setting.
- Extension name and description are localised through `_locales/en` and
  `_locales/sv`.
- Extraction warnings are stored as codes and translated in the review page.
- When several CVs are saved, you choose which one the analysis uses before it
  starts. With a single CV the flow runs automatically. The chosen CV is also
  the one the new copy is created from.

**Security and privacy**

- Removed the optional provider and its `https://*/*` host permission; the
  extension now requests only the hosts it uses.
- Removed the unused `tabs` permission.
- Background message handler rejects messages from other senders.
- Explicit instructions that the ad and CV text are data, never instructions.
- Content Security Policy meta tags on all extension pages.
- **Delete all data** removes the API key, caches, counter, history and the
  Google connection in one step.
- External links open with `noopener noreferrer`.

**Launch**

- Version 1.0.0, `LAUNCH.md` for OAuth verification and store submission, and
  `PRIVACY.md` with the policy in English.

## 0.4.0

**Mall och onboarding**

- Ny **Kontrollera mallen** i Inställningar: visar vilka taggade sektioner som hittas och vilka rubriker som ser ut som sektioner men saknar taggar, med färdiga taggförslag att klistra in. Originalmallen ändras aldrig.

**Granskning**

- Ordmarkerad diff per sektion: tillagd text i grönt, borttagen i rött, så att ändringen syns utan att jämföra två block.
- **Generera om den här sektionen** gör ett anrop för en sektion i stället för alla.
- Kvotvarning före anrop: räcker inte dagens kvot enligt räknaren avbryts anropet med en förklaring.

**Skärpt fabriceringsskydd**

- Årtal och siffror som läggs till men saknas i CV:t, originalet och annonsen blockerar skapandet.
- Nya egennamn som inte känns igen visas som varning i granskningsvyn.

**Robusthet och data**

- LinkedIn-uttaget faller tillbaka på sidans metabeskrivning och varnar när texten är förkortad.
- **Kopiera diagnostik** i förhandsgranskningen samlar annons, extraktionsstatus, modellval, kvotläge och extraktionens tider för felsökning.
- Ny **Integritet och data**-panel: vad som lämnar datorn, vad som sparas lokalt, och knappar för att rensa kravanalyser, anropsräknare och historik.
- Inställningar synkas via `chrome.storage.sync`; API-nyckeln stannar alltid lokalt.
- Historiken gallras automatiskt: högst 100 poster och inget äldre än 180 dagar. Gallringen sker både när ett CV sparas och när Inställningar öppnas.
- Extraktionen mäter sina egna tider (totalt, väntan på stabilt DOM och expansion) och visar dem i diagnostiken.

**Modeller**

- Reservmodellerna ordnas automatiskt efter vilka som faktiskt svarat, med användarens ordning som utgångspunkt.

## 0.3.0

- Strukturell Google Docs-redigering med dokumentets egna index i stället för teckenpositioner.
- Kompetensväljare med stödstatus och inställningen **Tillåt ej styrkta kompetenser**.
- Kopia skapas först efter godkännande; oförändrade sektioner rörs inte.
