import test from "node:test";
import assert from "node:assert/strict";
import { pacificDateKey, parseDailyQuotaLimit, analyzeJob } from "../shared.js";

test("dygnsnyckeln följer Pacific time, inte UTC", () => {
  // 07:59 UTC är fortfarande 23:59 dagen innan i Pacific (PST, UTC-8).
  assert.equal(pacificDateKey(new Date("2026-11-25T07:59:00Z")), "2026-11-24");
  assert.equal(pacificDateKey(new Date("2026-11-25T08:01:00Z")), "2026-11-25");
});

test("lär in dygnsgränsen från ett 429-svar", () => {
  const body = {
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      details: [{
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          { quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: "15" },
          { quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "500" }
        ]
      }]
    }
  };
  assert.equal(parseDailyQuotaLimit(body), 500);
});

test("ignorerar svar som bara namnger minutgränsen", () => {
  const body = {
    error: {
      details: [{
        violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: "15" }]
      }]
    }
  };
  assert.equal(parseDailyQuotaLimit(body), null);
  assert.equal(parseDailyQuotaLimit({}), null);
  assert.equal(parseDailyQuotaLimit(null), null);
});

test("ett 429 går vidare till nästa modell utan att försöka om", async () => {
  const quotaBody = {
    error: {
      code: 429,
      details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }] }]
    }
  };
  const analysisItem = {
    category: "technical",
    name: "Java",
    importance: "required",
    status: "supported",
    evidence: "Java",
    cvEvidence: "Java",
    recommendation: "Behåll"
  };
  const okBody = {
    candidates: [{ content: { parts: [{ text: JSON.stringify({ jobAnalysis: [analysisItem] }) }] } }]
  };
  const realFetch = globalThis.fetch;
  const urls = [];
  const responses = [{ status: 429, body: quotaBody }, { status: 200, body: okBody }];
  globalThis.fetch = async url => {
    urls.push(String(url));
    const next = responses.shift() || responses[0];
    return { ok: next.status === 200, status: next.status, headers: { get: () => null }, json: async () => next.body };
  };
  try {
    const result = await analyzeJob({
      apiKey: "test",
      model: "gemini-3.5-flash-lite",
      fallbackModels: ["gemini-3.8-flash"],
      job: { title: "Utvecklare", company: "AMF", description: "Vi söker en Java-utvecklare." },
      fullCvText: "Java"
    });
    assert.equal(result.modelUsed, "gemini-3.8-flash");
    assert.equal(urls.length, 2);
    assert.match(urls[0], /gemini-3\.5-flash-lite/);
    assert.match(urls[1], /gemini-3\.8-flash/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
