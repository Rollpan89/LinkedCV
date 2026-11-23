# CV Anpassaren – Chrome Extension (v0.1.4)

En Manifest V3-extension som läser en LinkedIn-jobbannons, analyserar en Google Docs-CV-mall med Gemini, visar ändringsförslag och skapar en kopia av mallen i Google Drive.

## Viktiga egenskaper

- Högerklicksmenyn **Anpassa till CV** visas på `linkedin.com/jobs/*`.
- Mallens dokument-ID anges i Inställningar. Förifylld testmall: `https://docs.google.com/document/d/1GoyOIz18axvOWhtDIrsHuCVlwu5BkyPIGQdGGukg03Y/edit`.
- Redigeringssektioner identifieras dynamiskt med `[TAG]text[/TAG]`.
- Endast texten mellan matchande taggar skickas som redigeringsbart innehåll till Gemini.
- Text utanför taggarna används endast som faktaunderlag och skrivs inte om.
- Gemini instrueras att behandla jobbannonsen som opålitlig data, att inte följa instruktioner i annonsen och att inte hitta på erfarenheter eller kompetenser.
- Användaren granskar ändringar innan en Google Docs-kopia skapas.
- Alla taggar i formatet `[TAG]` och `[/TAG]` tas bort i den skapade kopian.
- Historiken sparas lokalt i Chrome. Själva dokumenten ligger i Google Drive.

## Förutsättningar

1. Google Chrome.
2. Gemini API-nyckel från Google AI Studio. Gratisnivån har modell- och kvotbegränsningar och kan ändras av Google.
3. Google Cloud-projekt med **Google Drive API** och **Google Docs API** aktiverade.
4. OAuth-klient av typen **Chrome Extension** med tilläggets ID.

## Installera lokalt

1. Packa upp ZIP-filen i en permanent mapp.
2. Öppna `chrome://extensions`.
3. Aktivera **Utvecklarläge**.
4. Välj **Läs in opackat** och välj mappen `cv-adapter-extension`.
5. Kopiera tilläggets ID från tilläggssidan.
6. I Google Cloud Console: konfigurera OAuth-samtyckesskärmen, lägg till ditt Google-konto som testanvändare om appen är i testläge och skapa en OAuth-klient av typen **Chrome Extension** med tilläggets ID.
7. Ersätt `YOUR_CHROME_EXTENSION_OAUTH_CLIENT_ID.apps.googleusercontent.com` i `manifest.json` med klient-ID:t.
8. Ladda om tillägget på `chrome://extensions`.
9. Öppna tilläggets **Inställningar**. Ange Gemini API-nyckeln och Google Docs-mallens URL. Spara.
10. Klicka på **Anslut Google-konto** och godkänn de begärda behörigheterna.
11. Öppna en enskild jobbannons på LinkedIn, högerklicka och välj **Anpassa till CV**.

Om mappen flyttas och Chrome skapar ett nytt tilläggs-ID behöver OAuth-klienten uppdateras med det nya ID:t.

## Behörigheter och integritet

- `identity`: Google OAuth via Chromes identitets-API.
- `storage`: inställningar, tillfälligt annonsunderlag och lokal historik.
- `contextMenus`, `tabs`, `activeTab`: högerklicksmeny och öppna granskningssidan.
- `https://www.linkedin.com/*`: läsa annonsen i den aktiva LinkedIn-fliken.
- `https://generativelanguage.googleapis.com/*`: skicka annons och CV-innehåll till Gemini.
- `https://www.googleapis.com/*`: kopiera Google Docs-filen och uppdatera dokumentet.

**Google Drive-scope:** första versionen begär bred Drive-åtkomst för att kunna kopiera en befintlig mall som användaren anger med URL. Detta är en omfattande behörighet. En framtida, mer begränsad variant kan byggas med Google Picker och `drive.file`, men kräver ett separat filvalsflöde.

Gemini-nyckeln lagras i `chrome.storage.local` i den aktuella Chrome-profilen. Det är praktiskt för ett personligt, lokalt tillägg men inte en säker plats för en nyckel om tillägget distribueras till andra. Dela inte din tilläggsmapp eller nyckel.

## Formatering – teknisk avgränsning

Google Docs API behåller all dokumentstruktur och formattering utanför de redigerade intervallen. När innehåll inne i en taggad sektion ersätts infogas den nya texten vid sektionens första textposition och ärver i normalfallet formatteringen därifrån. Om en redigeringssektion innehåller flera olika teckenformat kan en ersättning därför inte garantera att varje ny teckendel får samma blandade formatering. För bästa resultat: håll varje redigeringssektion i ett konsekvent textformat.

Taggar som används för redigeringssektioner ska vara vanlig dokumenttext, inte text inuti bilder eller teckningar. Undvik nästlade taggar och använd unika taggnamn per sektion.

## Extraktionsmotor i v0.1.4

- Extraktionen är ombyggd för att inte vara beroende av LinkedIns genererade CSS-klasser eller interna komponentnamn.
- Prioritetsordning: JSON-LD `JobPosting`, semantiska DOM-landmärken, rubriker och innehållsbaserad rangordning av beskrivningskandidater.
- Dolda element, navigering, knappar och rekommenderade jobb filtreras bort så långt DOM-informationen medger.
- Expanderbara avsnitt öppnas via knapptext och ARIA-etiketter, inte CSS-klasser.
- DOM-stabilitet inväntas med `MutationObserver`, vilket bättre hanterar React-rendering och LinkedIns SPA-navigation.
- Diagnostik visar extraktionskälla, kandidatantal, poäng och uppskattad säkerhet. Säkerhetsprocenten är en heuristisk kvalitetsindikator, inte en statistiskt kalibrerad sannolikhet.
- Företag och plats är valfria metadata; saknas de kan annonsen ändå analyseras om titel och beskrivning är tillräckligt tydliga.

## Kända begränsningar i v0.1.4

- LinkedIn kan ändra semantik, text och DOM-struktur. En klassoberoende motor minskar beroendet men kan inte garantera korrekt extraktion på varje annonslayout.
- Om sidan visar flera annonser samtidigt kan kandidatrangordningen behöva förbättras för den aktuella layouten.
- Språket är låst till svenska enligt kravbilden.
- Diff-vyn visar hela texten före och efter per ändrad sektion, inte tecken-för-tecken-diff.
- Ändringar sker endast i taggade sektioner. Sektioner utan taggar kan inte AI-redigeras.
- Om Google Docs-mallen har flera tabs används huvudfliken i denna första version.
- Testa först med en kopia av din CV-mall och kontrollera resultatets formattering innan du använder det skarpt.

## Projektstruktur

- `manifest.json` – Manifest V3, behörigheter och OAuth-konfiguration.
- `background.js` – högerklicksmeny och arbetsflödesstart.
- `content.js` – extraherar jobbannonsen från LinkedIn.
- `shared.js` – Gemini, Google API, dokumenttolkning och tagghantering.
- `preview.html/js` – ändringsgranskning och skapande av dokumentkopia.
- `options.html/js` – mall, API-nyckel och Google-inloggning.
- `popup.html/js` – senaste dokumentet och historik.


### v0.1.1

Förbättrad injicering av content script. Om LinkedIn har navigerat till en jobbannons via sin SPA-navigation och skriptet därför saknas, injicerar tillägget `content.js` vid högerklick och försöker igen.


## v0.1.2 – förbättrad LinkedIn-extraktion

- Läser annonsbeskrivningen från flera kända LinkedIn-layoutvarianter och fallback-strukturer.
- Läser även `JobPosting` JSON-LD när LinkedIn exponerar sådan data.
- Försöker expandera knappar som "Visa mer" / "Show more" innan extraktionen.
- Hämtar titel, företag, plats och anställningstyp separat och visar extraktionskälla samt antal beskrivningstecken i förhandsgranskningen.
- Avbryter i stället för att skicka en ofullständig annons till Gemini när titel/företag saknas eller beskrivningen är kortare än 250 tecken.
- Gemini instrueras tydligare att lyfta överförbara, dokumenterade kompetenser utan att påstå att kandidaten har kompetenser som saknas i CV:t.

LinkedIn ändrar sin DOM löpande och kan visa olika innehåll beroende på inloggning, land och annonsvy. Extraktionen validerar därför innehållet och visar diagnostik, men en lyckad hämtning måste fortfarande verifieras mot den aktuella annonsen i användarens inloggade webbläsare.


## Extraktionsmotor i v0.1.7

- Läser jobb-ID från `currentJobId` eller annonsens URL och prioriterar den synliga jobblänk vars URL innehåller exakt samma ID när titeln väljs.
- Försöker identifiera arbetsgivaren via företagslänkar i samma begränsade DOM-område som jobblänken.
- Extraherar en första inventering av tekniska kompetenser med normaliserade alias och klassificerar omnämnanden som krav, meriterande, teknikstack eller övrigt omnämnande.
- Skickar kompetensinventeringen och identifierade annonsavsnitt vidare till Gemini som strukturerat underlag.
- Visar de identifierade teknikerna och deras klassificering i förhandsgranskningen, inklusive ett kort textutdrag som evidens.
- Avbryter när titeln är tvetydig, beskrivningen är för kort eller den samlade extraktionssäkerheten är för låg.

**Begränsning:** Kompetenslistan är lexikonbaserad och klassificeringen bygger på närliggande annonstext. Den är ett granskningsunderlag, inte en semantisk garanti. LinkedIns DOM kan variera; verifiering mot flera verkliga annonser behövs innan extraktionen kan betraktas som produktionssäker.
