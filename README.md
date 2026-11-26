# CV Anpassaren – Chrome Extension (v0.3.0)

En Manifest V3-extension som läser en LinkedIn-jobbannons, analyserar en Google Docs-CV-mall med Gemini, visar ändringsförslag och skapar en kopia av mallen i Google Drive.

## v0.4.0 – onboarding, granskning och datastyrning

- **Kontrollera mallen** i Inställningar läser mallen och listar taggade sektioner samt rubriker som saknar taggar, med färdiga taggförslag. Inget skrivs till mallen.
- **Ordmarkerad diff** per sektion: tillagd text i grönt, borttagen i rött, uppdateras när du redigerar förslaget.
- **Generera om den här sektionen** gör ett anrop för en sektion i stället för alla, och ett anrop avbryts med förklaring om räknaren visar att dagens kvot är slut.
- **Skärpt fabriceringsskydd**: årtal och siffror som saknas i CV:t, originalet och annonsen blockerar skapandet; nya egennamn visas som varning.
- **Kopiera diagnostik** samlar annons, extraktionsstatus, modellval, kvotläge och extraktionens tider (totalt, DOM-väntan och expansion) till urklipp.
- **Integritet och data**: beskriver vad som lämnar datorn och låter dig rensa kravanalyser, anropsräknare och historik. Historiken gallras automatiskt: högst 100 poster, och inget äldre än 180 dagar.
- Inställningar synkas mellan Chrome-profiler via `chrome.storage.sync`; API-nyckeln lämnar aldrig datorn.
- Reservmodellerna ordnas automatiskt efter vilka som faktiskt svarat, med din ordning som utgångspunkt vid lika resultat.
- En valfri **reservleverantör** (OpenAI-kompatibel adress, modell och nyckel) kan anges i Inställningar och används bara när ingen Gemini-modell kan svara. Även då gäller samma regler för vad som får skrivas; texten skickas till den adress du själv anger och nyckeln lämnar aldrig datorn.

## v0.3.0 – strukturell Google Docs-redigering och kompetensval

Den här versionen ersätter prototypens tillplattade textpositioner med dokumentets egna strukturella index och inför det kompetensval som kravbilden förutsätter.

**Google Docs-redigering**

- Sektioner hittas och redigeras med absoluta `startIndex`/`endIndex` från Google Docs API i stället för teckenpositioner i en hopslagen textsträng. Taggar som Docs har delat upp i flera `textRun` hanteras, liksom hopp mellan stycken och tabellceller.
- Kopian läses om från Google Docs direkt före redigeringen, så indexen kommer alltid från det dokument som faktiskt ändras. Ändras mallen mellan granskning och kopiering avbryts flödet.
- Alla taggar valideras innan något skrivs: saknad, tom, dubblerad, nästlad eller avvikande tagg stoppar processen. Taggar som delats över ett styckebrott stoppar också.
- En tagg som står ensam på sin rad tas bort tillsammans med radbrytningen, så inga tomma stycken lämnas kvar. Sista stycket i dokumentet och enkelstyckes tabellceller behåller alltid sin radbrytning.
- Oförändrade sektioner rörs inte alls: bara taggarna tas bort, vilket bevarar text och formatering exakt.
- Ersatt text får sektionens första textstil via en explicit `updateTextStyle` i samma batch, i stället för att förlita sig på att Docs ärver stilen vid infogningspunkten.
- Efter `batchUpdate` läses kopian tillbaka och jämförs tecken för tecken med den godkända texten. Stämmer den inte, eller finns taggar kvar, avbryts flödet med en felbeskrivning i stället för att dokumentet "repareras".
- Requesten skickas bakifrån och fram, så index för sektioner som ännu inte redigerats påverkas aldrig.

**Arbetsflöde**

- Två steg hos Gemini: först en kravprofil för hela annonsen, sedan textförslag utifrån de krav användaren har valt.
- Svarsformen tolereras: kravlistan hittas även om modellen lägger den på toppnivå eller under en annan nyckel (`job_analysis`, `requirements`, `data.requirements`). Ett tomt eller ofullständigt svar ger ett förklarande fel med svarets nycklar, Geminis slutorsak och en **Försök igen**-knapp i stället för ett rått meddelande.
- Kravprofilen normaliseras innan den visas: kategorier och prioriteter som Gemini skriver på annat sätt ("Technical", "verktyg", "teknikstack") mappas till kända värden, och ett krav med okänd stödstatus behandlas som att det saknar belägg. Ett enskilt avvikande fält fäller alltså inte hela analysen.
- Kravanalysen cachas per annons i `chrome.storage.local`, med annonsens text, CV-texten och vald modell i nyckeln. Öppnar du samma annons igen eller laddar om förhandsgranskningen återanvänds analysen, så "Generera om förslagen" bara gör sektionsanropet och en 503 aldrig tvingar fram en ny full analys.
- Länken **Analysera om** i kompetensväljaren tvingar en ny kravanalys utan att läsa cachen. Valen återställs till de kompetenser som CV:t styrker, och den nya analysen sparas så nästa inläsning återanvänder den.
- Vid 503/5xx/timeout försöker anropet igen med exponentiell backoff och jitter (1, 2, 4 sekunder, högst fyra försök per modell, `Retry-After` respekteras) innan nästa kostnadsfria modell provas. Ett 429 (kvot) försöks aldrig om — det blir inte bättre inom några sekunder och varje försök drar mer kvot — utan nästa modell provas direkt. Är alla fel tillfälliga visas en förklaring och knappen **Försök igen**; permanenta fel som ogiltig nyckel eller borttagen modell visar felet direkt.
- Statusraden i förhandsgranskningen visar vilken modell som utförde anropet och behåller den informationen även efter att förslagen ritats upp. Den ersätts bara av en ny status, till exempel vid en ny generering.
- Kompetensväljaren visar kategori, prioritet, stödstatus, annonsbelägg, CV-belägg och rekommendation. Användaren väljer själv vad som får påverka texten; inget läggs till automatiskt.
- Inställningen **Tillåt ej styrkta kompetenser** styr om krav som saknar belägg i CV:t får väljas. Är den av kan de inte väljas alls; är den på markeras de tydligt och användaren ansvarar för granskningen.
- Förslagen är redigerbara textfält i förhandsgranskningen. Det som står i fälten är exakt det som skrivs till kopian.
- Ett skyddsnät kontrollerar den godkända texten innan kopian skapas: en kompetens som saknar belägg och inte uttryckligen har godkänts får inte förekomma i förslaget. Skyddsnätet är lexikalt och jämför kravens namn med texten.
- Förslag som innehåller taggliknande text avvisas innan någon kopia skapas, så att inget halvfärdigt dokument lämnas i Google Drive.
- Efter redigeringen jämförs även dokumentets struktur (antal textbehållare och tabellernas form) med mallen, utöver textjämförelsen och taggkontrollen.
- Kompetenser som saknar belägg markeras särskilt i väljaren när inställningen tillåter dem: egen ram, egen färg och texten ”Ej styrkt av CV:t – du ansvarar själv för granskningen”.
- Sektioner med blandad formatering eller flera stycken varnas om i förhandsgranskningen, eftersom en omskrivning då får enhetlig stil respektive slår ihop stycken.

**Tester**

`npm test` kör `node --test tests/*.test.mjs`. Testerna simulerar Google Docs API: `deleteContentRange`, `insertText` och `updateTextStyle` tillämpas i samma ordning som API:et, med index som förskjuts på samma sätt. De verifierar taggar delade över flera `textRun`, taggrader, flera sektioner i samma stycke, tabellceller, oförändrade sektioner, samtliga valideringsfel och skyddsnätet för ej styrkta kompetenser. Testerna kräver ingen extern testdependency och inget Google-konto.

**Inte verifierat i den här miljön:** redigering mot ett skarpt Google Docs-dokument, LinkedIn-extraktion i en inloggad webbläsarsession och OAuth med ett riktigt tilläggs-ID. Se avsnitten nedan.

## v0.1.9 – titelidentifiering i LinkedIns jobbhuvud

- Identifierar även annonstitlar som LinkedIn renderar som fristående textnoder i stället för rubriker eller titel-element.
- Försöker matcha titeln i direkt anslutning till företagslänken innan flera kandidater klassas som tvetydiga.
- AMF-regressionstestet använder nu samma typ av textnod som den aktuella annonsen.

## Viktiga egenskaper

- Högerklicksmenyn **Anpassa till CV** visas på `linkedin.com/jobs/*`.
- Mallens dokument-ID anges i Inställningar. 
- Redigeringssektioner identifieras dynamiskt med `[TAG]text[/TAG]`.
- Endast texten mellan matchande taggar skickas som redigeringsbart innehåll till Gemini.
- Text utanför taggarna används endast som faktaunderlag och skrivs inte om.
- Gemini instrueras att behandla jobbannonsen som opålitlig data, att inte följa instruktioner i annonsen och att inte hitta på erfarenheter eller kompetenser.
- Användaren granskar ändringar innan en Google Docs-kopia skapas.
- Räknaren i övre högra hörnet visar hur många Gemini-anrop tillägget har gjort under det aktuella Pacific-dygnet. Gemini API saknar endpoint för förbrukad kvot, så räkningen görs lokalt per modell; dygnsgränsen läses från ett 429-svar (som namnger `GenerateRequestsPerDayPerProjectPerModel-FreeTier`) eller från fältet i Inställningar, och först då visas hur många anrop som är kvar.
- Alla taggar i formatet `[TAG]` och `[/TAG]` tas bort i den skapade kopian.
- Historiken sparas lokalt i Chrome och gallras automatiskt (högst 100 poster, 180 dagar). Själva dokumenten ligger i Google Drive.

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
6. I Google Cloud Console: konfigurera OAuth-samtyckesskärmen, lägg till ditt Google-konto som testanvändare om appen är i testläge och kontrollera att OAuth-klienten av typen **Chrome Extension** använder exakt samma tilläggs-ID som visas i `chrome://extensions`.
7. `oauth2.client_id` är redan ifyllt i projektets `manifest.json`. Byt endast värdet om du har skapat en ny OAuth-klient för samma tilläggs-ID.
8. Ladda om tillägget på `chrome://extensions`.
9. Öppna tilläggets **Inställningar**. Ange Gemini API-nyckeln och Google Docs-mallens URL. Spara.
10. Klicka på **Anslut Google-konto** och godkänn de begärda behörigheterna.
11. Öppna en enskild jobbannons på LinkedIn, högerklicka och välj **Anpassa till CV**.

Om mappen flyttas och Chrome skapar ett nytt tilläggs-ID behöver OAuth-klienten uppdateras med det nya ID:t.

**Viktigt om `manifest.json` → `key`:** fältet ska innehålla tilläggets Base64-kodade publika nyckel, inte dess 32 tecken långa ID. Det nuvarande värdet i repositoryt ser ut att vara själva ID-strängen. Jag har inte ändrat det utan den ursprungliga publika nyckeln, eftersom en ny nyckel kan ge ett annat tilläggs-ID och därmed kräva en ny OAuth-klient.

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

Google Docs API behåller all dokumentstruktur och formattering utanför de redigerade intervallen, och redigeringen rör aldrig något index utanför en taggad sektion. En oförändrad sektion behåller sin text och formatering exakt eftersom bara taggarna tas bort.

När innehållet i en sektion byts ut får den nya texten sektionens första textstil, som appliceras explicit med `updateTextStyle` i samma batch. En sektion med blandad formatering (t.ex. fetstil mitt i texten) kan därför inte behålla varje teckendel separat: ersättningstexten blir enhetlig. Förhandsgranskningen varnar när en sektion har blandad formatering eller sträcker sig över flera stycken, så att du kan kontrollera sektionen i den skapade kopian. För bästa resultat: håll varje redigeringssektion i ett konsekvent textformat.

Stycken inom sektionen behåller sin styckestil. Om förslaget är en enda rad slås en flerradig sektion ihop, vilket förhandsgranskningen också varnar om.

Taggar som används för redigeringssektioner ska vara vanlig dokumenttext, inte text inuti bilder eller teckningar. Undvik nästlade taggar och använd unika taggnamn per sektion.

## Extraktionsmotor i v0.1.8

- Jobb-ID från `/jobs/view/{id}` prioriteras framför `currentJobId` i query-parametrar. På LinkedIns sökvy används `currentJobId` som fallback.
- Titel hämtas från det aktiva jobbhuvudets titel-element när en annonslänk med exakt jobb-ID saknas. Kandidater avgränsas till den aktiva annonsens detaljvy.
- Företagslänken i samma jobbhuvud används för att koppla företagsnamnet till rätt annons.
- Extraktionen letar efter sektionen `Om jobbet` / `About the job` och använder den som primär beskrivningskälla.
- Endast expanderingsknappar inuti den identifierade jobbannonsbeskrivningen klickas. Företagsprofil och rekommenderade jobb lämnas orörda.
- Korrigerad whitespace-normalisering för radbrytningar, tabbtecken och hårda mellanslag.
- Diagnostiken skiljer nu mellan en identifierad jobbsektion och generell semantisk DOM-rangordning.

### AMF-regressionstest

Öppna `tests/amf-regression.html?currentJobId=4492556919` i Chrome. Testfixturen laddar den riktiga `content.js`-extraktionsmotorn och kontrollerar jobb-ID, titeln `Digital designer`, företaget `AMF`, att beskrivningen hämtas från `Om jobbet`, att jobbtextens `Visa mer` expanderas och att motsvarande knapp i företagsprofilen inte klickas. Testet är ett manuellt webbläsartest och kräver ingen extern testdependency.

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
- `shared.js` – Gemini, Google API, strukturell dokumenttolkning, taggvalidering, redigeringsrequest och verifiering.
- `preview.html/js` – kravprofil, kompetensval, redigerbara förslag och skapande av dokumentkopia.
- `options.html/js` – mall, API-nyckel, modellval, kompetensinställning och Google-inloggning.
- `popup.html/js` – senaste dokumentet och historik.
- `tests/google-docs.test.mjs` – offline-tester för Google Docs-redigeringen (Docs-simulator).
- `package.json` – endast för testkörning (`npm test`); påverkar inte tillägget i Chrome.


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


## 0.2.0 – innehållsbaserad extraktion och kravprofil

- Saknad eller tvetydig titel, arbetsgivare eller plats blockerar inte längre CV-anpassningen.
- Endast mycket kort annonstext (under 80 tecken) stoppar flödet; extraktionssäkerhet används som diagnostik.
- Extraktionsvarningar visas separat i förhandsgranskningen.
- Gemini identifierar tekniska krav, erfarenhet, utbildning, personliga egenskaper, ansvar och meriterande önskemål.
- Förhandsgranskningen visar kravprofilen med belägg från annonsen.
- Google Docs-mallflöde, manifestnyckel och OAuth-klient lämnas oförändrade.


## 0.2.1 – förenklad kodbas

- Kravidentifiering och CV-matchning utförs samlat av Gemini utifrån hela annonstexten och hela CV:t.
- Den äldre lexikonbaserade teknikextraktionen och regelbaserade annonsklassificeringen har tagits bort.
- Extraktionsmotorn ansvarar enbart för att samla in annonsinnehåll och diagnostik.
- Oanvända hjälpfunktioner, exports, meddelandehantering och CSS-regler har tagits bort.
- Ett anrop till en odefinierad företagsfunktion har tagits bort.
## 0.2.2 – kostnadsfri Gemini-fallback

- Primär Gemini-modell och två reservmodeller kan väljas i inställningarna.
- Endast modeller med verifierad kostnadsfri standardnivå tillåts: `gemini-3.8-flash`, `gemini-3.5-flash-lite` och `gemini-3.1-flash-lite`.
- Vid överbelastning, kvotbegränsning, tillfälliga serverfel eller timeout provas nästa vald kostnadsfri modell automatiskt.
- Betalda eller okända modell-ID:n filtreras bort innan API-anrop och kan aldrig användas som reserv.
- Förhandsgranskningen visar vilken modell som faktiskt genomförde analysen.
- Google kan ändra priser, gratiskvoter och modellernas tillgänglighet; modellen körs på Googles kostnadsfria API-nivå och har därför fortfarande begränsningar.

