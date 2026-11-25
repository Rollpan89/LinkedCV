import test from "node:test";
import assert from "node:assert/strict";
import { pacificDateKey, parseDailyQuotaLimit } from "../shared.js";

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
