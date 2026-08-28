import assert from "node:assert/strict";
import test from "node:test";
import { developmentOriginsFor } from "./config.js";

test("开发来源包含本机非回环 IPv4 且不扩展到其他局域网地址", () => {
  const origins = developmentOriginsFor(["192.168.50.123", "192.168.50.123"]);

  assert.ok(origins.includes("http://localhost:5174"));
  assert.ok(origins.includes("http://127.0.0.1:5174"));
  assert.ok(origins.includes("http://192.168.50.123:5174"));
  assert.ok(origins.includes("http://192.168.50.123:4174"));
  assert.equal(origins.includes("http://192.168.50.124:5174"), false);
});
