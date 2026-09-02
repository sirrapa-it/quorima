import { test } from "node:test";
import assert from "node:assert/strict";

import {
  backoffMs,
  describeRateLimit,
  rateLimitInfo,
  withRateLimitRetry,
} from "./retry.js";

/**
 * Exact de vorm die de soap-library op 2 september 2026 gooide toen Twinfield
 * afknelde. De faultstring liegt: het is geen XML-probleem maar een 429.
 */
const realRateLimitError = () => ({
  Fault: {
    faultcode: 500,
    faultstring: "Invalid XML",
    detail: "Error: Non-whitespace before first tag.\nLine: 0\nColumn: 1\nChar: {",
    statusCode: 500,
  },
  response: {
    status: 429,
    statusText: "Too Many Requests",
    headers: {
      "content-type": "application/json",
      "retry-after": "4",
      "x-ratelimit-clientid-limit": "50",
      "x-ratelimit-clientid-remaining": "23",
    },
  },
});

// ─── herkenning ───────────────────────────────────────────────────────

test("herkent de echte Twinfield 429 ondanks de 'Invalid XML' faultstring", () => {
  const info = rateLimitInfo(realRateLimitError());
  assert.ok(info, "moet als rate limit herkend worden");
  assert.equal(info.retryAfterSeconds, 4);
  assert.equal(info.remaining, 23);
});

test("headers zijn hoofdletterongevoelig", () => {
  const info = rateLimitInfo({ response: { status: 429, headers: { "Retry-After": "7" } } });
  assert.equal(info?.retryAfterSeconds, 7);
});

test("429 zonder retry-after geeft null voor de wachttijd, niet 0", () => {
  const info = rateLimitInfo({ response: { status: 429, headers: {} } });
  assert.ok(info);
  assert.equal(info.retryAfterSeconds, null);
});

test("gewone fouten worden niet als rate limit gezien", () => {
  assert.equal(rateLimitInfo(new Error("boem")), null);
  assert.equal(rateLimitInfo({ response: { status: 500 } }), null);
  assert.equal(rateLimitInfo(null), null);
  assert.equal(rateLimitInfo("tekst"), null);
});

test("een echte XML-fout zonder 429 blijft een gewone fout", () => {
  const err = {
    Fault: { faultstring: "Invalid XML", detail: "Char: {", statusCode: 500 },
    response: { status: 500, headers: {} },
  };
  assert.equal(rateLimitInfo(err), null, "zonder retry-after en zonder 429 niet herhalen");
});

// ─── wachttijd ────────────────────────────────────────────────────────

test("retry-after van de server wint van exponentiële backoff", () => {
  assert.equal(backoffMs(1, { retryAfterSeconds: 4, remaining: null }), 4000);
  assert.equal(backoffMs(3, { retryAfterSeconds: 4, remaining: null }), 4000);
});

test("zonder retry-after loopt de wachttijd exponentieel op, met plafond", () => {
  assert.equal(backoffMs(1, null), 2000);
  assert.equal(backoffMs(2, null), 4000);
  assert.equal(backoffMs(3, null), 8000);
  assert.equal(backoffMs(10, null), 30_000, "plafond, anders hangt de cron minutenlang");
});

test("een absurde retry-after wordt afgetopt", () => {
  assert.equal(backoffMs(1, { retryAfterSeconds: 3600, remaining: null }), 30_000);
});

test("de omschrijving noemt de echte oorzaak", () => {
  const msg = describeRateLimit({ retryAfterSeconds: 4, remaining: 23 });
  assert.match(msg, /429/);
  assert.match(msg, /4s/);
  assert.match(msg, /23 calls over/);
});

// ─── retry-lus ────────────────────────────────────────────────────────

const noSleep = async () => {};

test("slaagt alsnog na een rate limit", async () => {
  let calls = 0;
  const out = await withRateLimitRetry(
    async () => {
      calls++;
      if (calls === 1) throw realRateLimitError();
      return "gelukt";
    },
    { sleepFn: noSleep },
  );
  assert.equal(out, "gelukt");
  assert.equal(calls, 2);
});

test("herhaalt tot maxAttempts en faalt dan met een eerlijke melding", async () => {
  let calls = 0;
  await assert.rejects(
    withRateLimitRetry(
      async () => { calls++; throw realRateLimitError(); },
      { maxAttempts: 3, sleepFn: noSleep },
    ),
    (err: Error) => {
      assert.match(err.message, /rate limit/i);
      assert.match(err.message, /3 pogingen/);
      assert.match(err.message, /Invalid XML/, "verwijst naar de misleidende SOAP-melding");
      return true;
    },
  );
  assert.equal(calls, 3);
});

test("een niet-429 fout gaat er direct doorheen, zonder retry", async () => {
  let calls = 0;
  await assert.rejects(
    withRateLimitRetry(
      async () => { calls++; throw new Error("verlopen token"); },
      { sleepFn: noSleep },
    ),
    /verlopen token/,
  );
  assert.equal(calls, 1, "wachten maakt een verkeerde query niet beter");
});

test("meldt elke poging aan de aanroeper", async () => {
  const msgs: string[] = [];
  let calls = 0;
  await withRateLimitRetry(
    async () => {
      calls++;
      if (calls < 3) throw realRateLimitError();
      return true;
    },
    { sleepFn: noSleep, onRetry: (m) => msgs.push(m) },
  );
  assert.equal(msgs.length, 2);
  assert.match(msgs[0]!, /poging 1\/4/);
  assert.match(msgs[1]!, /poging 2\/4/);
});

test("wacht de tijd die de server vraagt", async () => {
  const waits: number[] = [];
  let calls = 0;
  await withRateLimitRetry(
    async () => {
      calls++;
      if (calls === 1) throw realRateLimitError();
      return true;
    },
    { sleepFn: async (ms) => { waits.push(ms); } },
  );
  assert.deepEqual(waits, [4000]);
});

test("slaagt hij meteen, dan wordt er niet gewacht", async () => {
  const waits: number[] = [];
  const out = await withRateLimitRetry(async () => "ok", {
    sleepFn: async (ms) => { waits.push(ms); },
  });
  assert.equal(out, "ok");
  assert.deepEqual(waits, []);
});
