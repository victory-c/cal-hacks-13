import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SERVER_URL } from "@canon/shared";

import { KEYS, memoryStorage, normalizeUrl, resolveRate, resolveServerUrl, safeStorage } from "./config.ts";

test("server URL: query wins and is remembered", () => {
  const st = memoryStorage();
  assert.equal(resolveServerUrl("?server=http://10.0.0.5:4100/", st), "http://10.0.0.5:4100");
  assert.equal(st.getItem(KEYS.server), "http://10.0.0.5:4100");
  assert.equal(resolveServerUrl("", st), "http://10.0.0.5:4100", "remembered on the next load");
});

test("server URL: falls back to the contract default", () => {
  assert.equal(resolveServerUrl("", memoryStorage()), DEFAULT_SERVER_URL);
  assert.equal(resolveServerUrl("?server=javascript:alert(1)", memoryStorage()), DEFAULT_SERVER_URL);
  assert.equal(resolveServerUrl("?server=not a url", memoryStorage()), DEFAULT_SERVER_URL);
});

test("normalizeUrl", () => {
  assert.equal(normalizeUrl(" https://canon.example/ "), "https://canon.example");
  assert.equal(normalizeUrl("http://localhost:4100/api/"), "http://localhost:4100/api");
  assert.equal(normalizeUrl("ftp://x"), null);
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl(null), null);
});

test("rate: unset by default, set via query, cleared via ?rate=0", () => {
  const st = memoryStorage();
  assert.equal(resolveRate("", st), null);
  assert.equal(resolveRate("?rate=3", st), 3);
  assert.equal(resolveRate("", st), 3, "remembered");
  assert.equal(resolveRate("?rate=0", st), null);
  assert.equal(st.getItem(KEYS.rate), null);
  assert.equal(resolveRate("?rate=abc", st), null);
});

test("safeStorage works without a window", () => {
  const st = safeStorage();
  st.setItem("k", "v");
  assert.equal(st.getItem("k"), "v");
  st.removeItem("k");
  assert.equal(st.getItem("k"), null);
});
