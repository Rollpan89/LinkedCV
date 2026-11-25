import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTemplate,
  buildUpdateRequests,
  expectedDocumentText,
  documentText,
  normalizeDocumentText,
  findUnapprovedIntroductions,
  assertSafeProposalText,
  structureSignature,
  stripTags
} from "../shared.js";

/* ------------------------------------------------------------------ *
 * Minimal Google Docs-simulator.
 *
 * Dokumentet representeras som en teckenström med en stil per tecken.
 * Stycken uppstår vid varje "\n", precis som i Google Docs, så index
 * förskjuts automatiskt när text infogas eller tas bort. Requesten tillämpas
 * i samma ordning som API:et tillämpar dem.
 * ------------------------------------------------------------------ */

class FakeDocs {
  constructor(paragraphs) {
    this.chars = [];
    for (const runs of paragraphs) {
      for (const run of runs) {
        for (const character of run.text) this.chars.push({ ch: character, style: { ...(run.style || {}) } });
      }
    }
  }

  get text() {
    return this.chars.map(character => character.ch).join("");
  }

  apply(request) {
    if (request.deleteContentRange) {
      const { startIndex, endIndex } = request.deleteContentRange.range;
      assert.ok(startIndex >= 1, `delete startIndex ${startIndex} är utanför dokumentet`);
      assert.ok(endIndex <= this.chars.length + 1, `delete endIndex ${endIndex} är utanför dokumentet (${this.chars.length + 1})`);
      assert.ok(endIndex > startIndex, "tom deleteContentRange");
      this.chars.splice(startIndex - 1, endIndex - startIndex);
      return;
    }
    if (request.insertText) {
      const index = request.insertText.location.index;
      assert.ok(index >= 1 && index <= this.chars.length + 1, `insert index ${index} är utanför dokumentet`);
      const inherited = this.chars[index - 1]?.style ?? this.chars[index - 2]?.style ?? {};
      const inserted = [...request.insertText.text].map(character => ({ ch: character, style: { ...inherited } }));
      this.chars.splice(index - 1, 0, ...inserted);
      return;
    }
    if (request.updateTextStyle) {
      const { startIndex, endIndex } = request.updateTextStyle.range;
      const fields = request.updateTextStyle.fields.split(",");
      for (let index = startIndex - 1; index < endIndex - 1; index++) {
        for (const field of fields) {
          if (request.updateTextStyle.textStyle[field] === undefined) delete this.chars[index].style[field];
          else this.chars[index].style[field] = request.updateTextStyle.textStyle[field];
        }
      }
      return;
    }
    throw new Error(`Okänd request: ${JSON.stringify(request)}`);
  }

  applyAll(requests) {
    for (const request of requests) this.apply(request);
    return this;
  }

  stylesFor(needle) {
    const start = this.text.indexOf(needle);
    assert.ok(start >= 0, `"${needle}" finns inte i dokumentet`);
    return this.chars.slice(start, start + needle.length).map(character => character.style);
  }

  toDoc() {
    const paragraphs = [];
    let current = [];
    for (const character of this.chars) {
      current.push(character);
      if (character.ch === "\n") {
        paragraphs.push(current);
        current = [];
      }
    }
    if (current.length) paragraphs.push([...current, { ch: "\n", style: {} }]);
    let index = 1;
    const content = paragraphs.map(chars => {
      const runs = [];
      for (const character of chars) {
        const last = runs[runs.length - 1];
        if (last && JSON.stringify(last.style) === JSON.stringify(character.style)) last.text += character.ch;
        else runs.push({ text: character.ch, style: character.style });
      }
      const startIndex = index;
      const elements = runs.map(run => {
        const element = { startIndex: index, endIndex: index + run.text.length, textRun: { content: run.text, textStyle: run.style } };
        index += run.text.length;
        return element;
      });
      return { startIndex, endIndex: index, paragraph: { elements } };
    });
    return { body: { content } };
  }
}

function buildDoc(paragraphs) {
  let index = 1;
  const content = paragraphs.map(runs => {
    const startIndex = index;
    const elements = runs.map(run => {
      const element = { startIndex: index, endIndex: index + run.text.length, textRun: { content: run.text, textStyle: run.style || {} } };
      index += run.text.length;
      return element;
    });
    return { startIndex, endIndex: index, paragraph: { elements } };
  });
  return { body: { content } };
}

const plain = text => ({ text, style: {} });

/* ------------------------------------------------------------------ *
 * Test: taggar inom ett stycke, uppdelade över flera textRun
 * ------------------------------------------------------------------ */

test("hittar en tagg som Google Docs har delat upp i flera textRun", () => {
  const paragraphs = [
    [plain("ERFARENHET\n")],
    [
      { text: "[SUM", style: {} },
      { text: "MARY]", style: {} },
      { text: "Utvecklare med Java och Spring", style: { bold: true } },
      { text: "[/SU", style: { bold: true } },
      { text: "MMARY]\n", style: {} }
    ],
    [plain("Övrig text\n")]
  ];
  const parsed = parseTemplate(buildDoc(paragraphs));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.sections.length, 1);
  const [section] = parsed.sections;
  assert.equal(section.tag, "SUMMARY");
  assert.equal(section.original, "Utvecklare med Java och Spring");
  // Stycket börjar på index 12 och "[SUMMARY]" är nio tecken.
  assert.equal(section.contentStart, 12 + 9, "innehållet börjar direkt efter öppningstaggen");
  assert.equal(section.contentEnd, section.contentStart + "Utvecklare med Java och Spring".length);

  const replacement = "Utvecklare med Java, Spring Boot och Kubernetes";
  const approved = new Map([["SUMMARY", replacement]]);
  const requests = buildUpdateRequests(parsed, approved);
  const simulated = new FakeDocs(paragraphs).applyAll(requests);

  assert.equal(simulated.text, "ERFARENHET\n" + replacement + "\nÖvrig text\n");
  assert.equal(simulated.text, expectedDocumentText(parsed, approved));
  assert.equal(normalizeDocumentText(documentText(simulated.toDoc())), normalizeDocumentText(simulated.text));
  for (const style of simulated.stylesFor(replacement)) assert.deepEqual(style, { bold: true });
});

/* ------------------------------------------------------------------ *
 * Test: taggar på egna rader och innehåll över flera stycken
 * ------------------------------------------------------------------ */

test("tar bort taggrader och behåller styckesstrukturen", () => {
  const paragraphs = [
    [plain("Rubrik\n")],
    [plain("[SKILLS]\n")],
    [plain("Java\n")],
    [plain("Spring\n")],
    [plain("[/SKILLS]\n")],
    [plain("Slut\n")]
  ];
  const parsed = parseTemplate(buildDoc(paragraphs));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.sections.length, 1);
  assert.equal(parsed.sections[0].original, "Java\nSpring");
  assert.equal(parsed.sections[0].multiParagraph, true);

  const approved = new Map([["SKILLS", "Java, Spring, SQL"]]);
  const requests = buildUpdateRequests(parsed, approved);
  const simulated = new FakeDocs(paragraphs).applyAll(requests);

  assert.equal(simulated.text, "Rubrik\nJava, Spring, SQL\nSlut\n");
  assert.equal(simulated.text, expectedDocumentText(parsed, approved));
});

test("behåller radbrytningarna när förslaget har flera rader", () => {
  const paragraphs = [
    [plain("[SKILLS]\n")],
    [plain("Java\n")],
    [plain("Spring\n")],
    [plain("[/SKILLS]\n")],
    [plain("Slut\n")]
  ];
  const parsed = parseTemplate(buildDoc(paragraphs));
  const approved = new Map([["SKILLS", "Java\nSpring Boot\nSQL"]]);
  const simulated = new FakeDocs(paragraphs).applyAll(buildUpdateRequests(parsed, approved));
  // Förslaget saknar avslutande radbrytning; den läggs till eftersom sektionens
  // innehåll slutade med ett styckebrott.
  assert.equal(simulated.text, "Java\nSpring Boot\nSQL\nSlut\n");
  assert.equal(simulated.text, expectedDocumentText(parsed, approved));
});

/* ------------------------------------------------------------------ *
 * Test: flera sektioner i samma stycke (indexförskjutning)
 * ------------------------------------------------------------------ */

test("redigerar flera sektioner i samma stycke utan att indexen glider", () => {
  const paragraphs = [[plain("[A]ett[/A] och [B]två[/B]\n")]];
  const parsed = parseTemplate(buildDoc(paragraphs));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.sections.map(section => section.tag), ["A", "B"]);

  const approved = new Map([["A", "ETT MYCKET LÄNGRE TEXT"], ["B", "2"]]);
  const requests = buildUpdateRequests(parsed, approved);
  assert.equal(requests[0].deleteContentRange.range.startIndex, 22, "den sista sektionen redigeras först");

  const simulated = new FakeDocs(paragraphs).applyAll(requests);
  assert.equal(simulated.text, "ETT MYCKET LÄNGRE TEXT och 2\n");
  assert.equal(simulated.text, expectedDocumentText(parsed, approved));
});

/* ------------------------------------------------------------------ *
 * Test: oförändrad sektion behåller text och formatering exakt
 * ------------------------------------------------------------------ */

test("rör inte innehållet när förslaget är oförändrat", () => {
  const paragraphs = [[
    { text: "[A]", style: {} },
    { text: "Java", style: { bold: true } },
    { text: "[/A]\n", style: {} }
  ]];
  const parsed = parseTemplate(buildDoc(paragraphs));
  const approved = new Map([["A", "Java"]]);
  const requests = buildUpdateRequests(parsed, approved);
  assert.equal(requests.filter(request => request.insertText).length, 0);
  assert.equal(requests.filter(request => request.deleteContentRange).length, 2, "endast taggarna tas bort");

  const simulated = new FakeDocs(paragraphs).applyAll(requests);
  assert.equal(simulated.text, "Java\n");
  assert.deepEqual(simulated.stylesFor("Java"), [{ bold: true }, { bold: true }, { bold: true }, { bold: true }]);
});

/* ------------------------------------------------------------------ *
 * Test: ogiltiga taggar stoppar processen
 * ------------------------------------------------------------------ */

test("stoppar dokument med saknad, tom eller felaktig tagg", () => {
  const cases = [
    { paragraphs: [[plain("[A]text\n")]], expected: /saknar avslutande/ },
    { paragraphs: [[plain("[A][/A]\n")]], expected: /är tom/ },
    { paragraphs: [[plain("[A]x[/A] [A]y[/A]\n")]], expected: /används flera gånger/ },
    { paragraphs: [[plain("[A][B]x[/B][/A]\n")]], expected: /Nästlade taggar/ },
    { paragraphs: [[plain("[/A]x\n")]], expected: /saknar en matchande öppningstag/ },
    { paragraphs: [[plain("[A]x[/B]\n")]], expected: /måste vara identiska/ },
    // En tagg som delats över ett styckebrott kan inte paras ihop; den avslutande taggen blir ensam.
    { paragraphs: [[plain("text[SK\n"), plain("ILLS]x[/SKILLS]\n")]], expected: /saknar en matchande öppningstag|delad över ett styckebrott/ }
  ];
  for (const { paragraphs, expected } of cases) {
    const parsed = parseTemplate(buildDoc(paragraphs));
    assert.ok(parsed.errors.length, `förväntade fel för ${JSON.stringify(paragraphs)}`);
    assert.match(parsed.errors.join(" "), expected);
  }
});

test("behandlar hakparenteser utan bokstäver som vanlig text", () => {
  const parsed = parseTemplate(buildDoc([[plain("Anställd [2024] och [2025]\n")]]));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.sections.length, 0);
  assert.equal(stripTags("Anställd [2024] med [SKILLS]Java[/SKILLS]"), "Anställd [2024] med Java");
});

/* ------------------------------------------------------------------ *
 * Test: tabellceller har egna index och får inte skrivas sönder
 * ------------------------------------------------------------------ */

test("redigerar en sektion i en tabellcell med dokumentets egna index", () => {
  const doc = {
    body: {
      content: [
        { startIndex: 1, endIndex: 8, paragraph: { elements: [{ startIndex: 1, endIndex: 8, textRun: { content: "Rubrik\n", textStyle: {} } }] } },
        {
          startIndex: 8,
          endIndex: 32,
          table: {
            tableRows: [{ tableCells: [{ content: [
              {
                startIndex: 10,
                endIndex: 32,
                paragraph: {
                  elements: [
                    { startIndex: 10, endIndex: 18, textRun: { content: "[SKILLS]", textStyle: {} } },
                    { startIndex: 18, endIndex: 22, textRun: { content: "Java", textStyle: { italic: true } } },
                    { startIndex: 22, endIndex: 31, textRun: { content: "[/SKILLS]", textStyle: {} } },
                    { startIndex: 31, endIndex: 32, textRun: { content: "\n", textStyle: {} } }
                  ]
                }
              }
            ] }] }]
          }
        },
        { startIndex: 32, endIndex: 38, paragraph: { elements: [{ startIndex: 32, endIndex: 38, textRun: { content: "Slut\n", textStyle: {} } }] } }
      ]
    }
  };
  const parsed = parseTemplate(doc);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.sections.length, 1);
  const [section] = parsed.sections;
  assert.equal(section.tag, "SKILLS");
  assert.equal(section.contentStart, 18);
  assert.equal(section.contentEnd, 22);

  const approved = new Map([["SKILLS", "Java, Spring"]]);
  const requests = buildUpdateRequests(parsed, approved);
  for (const request of requests) {
    const range = request.deleteContentRange?.range ?? request.updateTextStyle?.range ?? { startIndex: request.insertText.location.index, endIndex: request.insertText.location.index };
    assert.ok(range.startIndex >= 10 && range.endIndex <= 31, `request utanför sektionen: ${JSON.stringify(request)}`);
  }
  assert.equal(expectedDocumentText(parsed, approved), "Rubrik\n\nJava, Spring\n\nSlut\n");
});

test("accepterar godkända sektioner både som lista och som Map", () => {
  const paragraphs = [[plain("[A]x[/A]\n")]];
  const parsed = parseTemplate(buildDoc(paragraphs));
  assert.equal(expectedDocumentText(parsed, [{ tag: "A", text: "y" }]), "y\n");
  assert.equal(expectedDocumentText(parsed, new Map([["A", "y"]])), "y\n");
  const simulated = new FakeDocs(paragraphs).applyAll(buildUpdateRequests(parsed, [{ tag: "A", text: "y" }]));
  assert.equal(simulated.text, "y\n");
});

/* ------------------------------------------------------------------ *
 * Test: struktur och taggar i förslagen
 * ------------------------------------------------------------------ */

test("struktursignaturen påverkas inte av textredigering men fångar tabelländringar", () => {
  const paragraphs = [[plain("Rubrik\n")], [plain("[A]Java[/A]\n")], [plain("Slut\n")]];
  const doc = buildDoc(paragraphs);
  const parsed = parseTemplate(doc);
  const updated = new FakeDocs(paragraphs).applyAll(buildUpdateRequests(parsed, new Map([["A", "Java, Spring"]]))).toDoc();
  assert.equal(structureSignature(updated), parsed.structure);

  const withTable = structuredClone(doc);
  withTable.body.content.splice(2, 0, { startIndex: 0, endIndex: 0, table: { tableRows: [{ tableCells: [{ content: [] }] }] } });
  assert.notEqual(structureSignature(withTable), parsed.structure);
});

test("avvisar förslag som innehåller taggliknande text", () => {
  assert.doesNotThrow(() => assertSafeProposalText("A", "Java, Spring Boot och [2024]"));
  assert.throws(() => assertSafeProposalText("A", "Java [/A] Spring"), /taggliknande text/);
  assert.throws(() => assertSafeProposalText("A", "[SKILLS]Java[/SKILLS]"), /taggliknande text/);
});

/* ------------------------------------------------------------------ *
 * Test: skyddsnätet för kompetenser utan belägg
 * ------------------------------------------------------------------ */

test("flaggar kompetenser utan belägg som smugits in i förslaget", () => {
  const jobAnalysis = [
    { name: "Kubernetes", status: "not_found" },
    { name: "Java", status: "supported" },
    { name: "AWS", status: "not_found" }
  ];
  const proposals = [{ tag: "SKILLS", text: "Java, Spring Boot och Kubernetes i produktion." }];
  const violations = findUnapprovedIntroductions({ proposals, jobAnalysis });
  assert.deepEqual(violations, [{ tag: "SKILLS", name: "Kubernetes" }]);

  const approved = findUnapprovedIntroductions({ proposals, jobAnalysis, approvedNames: ["Kubernetes"] });
  assert.deepEqual(approved, [], "uttryckligen godkända kompetenser blockerar inte");
});
