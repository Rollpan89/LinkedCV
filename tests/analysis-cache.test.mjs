import test from "node:test";
import assert from "node:assert/strict";
import { analysisFingerprint } from "../shared.js";

const job = {
  url: "https://www.linkedin.com/jobs/view/4012345678",
  title: "Fullstackutvecklare",
  company: "AMF",
  description: "Vi söker en utvecklare med erfarenhet av JavaScript och React."
};
const base = { job, cvText: "Axel – utvecklare\nJava, Spring, React", model: "gemini-3.5-flash-lite" };

test("samma annons, CV och modell ger samma nyckel", () => {
  assert.equal(analysisFingerprint(base), analysisFingerprint({ ...base, job: { ...job } }));
});

test("ändrad annons, CV-text eller modell ger en ny nyckel", () => {
  assert.notEqual(analysisFingerprint(base), analysisFingerprint({ ...base, job: { ...job, description: "Annan annonstext" } }));
  assert.notEqual(analysisFingerprint(base), analysisFingerprint({ ...base, cvText: "Ett annat CV" }));
  assert.notEqual(analysisFingerprint(base), analysisFingerprint({ ...base, model: "gemini-3.8-flash" }));
});

test("beskrivning som skickas som text-fält räknas som samma annons", () => {
  const asText = { ...job, description: undefined, text: job.description };
  assert.equal(analysisFingerprint(base), analysisFingerprint({ ...base, job: asText }));
});
