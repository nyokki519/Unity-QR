import test from "node:test";
import assert from "node:assert/strict";
import { validateCloudUpdateState } from "../scripts/cloud-update.js";
test("updates require completed migration and owned real HTTPS Worker", () => {
  const state = {
    application: "unity-qr-cloud-deploy-v1",
    complete: true,
    name: "unity-qr-free-123456789abc",
    ownerId: "a".repeat(32),
    accountId: "b".repeat(32),
    url: "https://unity-qr-free-123456789abc.example.workers.dev",
  };
  assert.doesNotThrow(() => validateCloudUpdateState(state));
  for (const change of [
    { complete: false },
    { ownerId: undefined },
    { url: "http://localhost:4173" },
    { url: "https://different.example.workers.dev" },
    { url: state.url + "/path" },
  ])
    assert.throws(() => validateCloudUpdateState({ ...state, ...change }));
});
