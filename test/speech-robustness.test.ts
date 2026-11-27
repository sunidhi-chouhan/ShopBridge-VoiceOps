import "./helpers";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAffirmative, matchProducts, nearOrderNumbers, productMatchScore, soundKey } from "../server/voiceops/policy";

const catalogue = [
  { name: "Maheshwari cotton sari" }, { name: "Cane and hide tote" }, { name: "Stoneware serving bowl" }, { name: "Hammered brass jhumkas" },
  { name: "Chandan attar, 10 ml" }, { name: "Block-print kantha throw" }, { name: "Vegetable-tanned belt" }, { name: "Narmada clay cup, set of two" },
];

describe("spoken product names", () => {
  it("Hinglish spellings and plurals share a sound key", () => {
    for (const group of [["saree", "sari", "saari", "sarees"], ["jhumke", "jhumka", "jhumkas", "jumka"], ["chaddar", "chadar"]]) {
      assert.equal(new Set(group.map(soundKey)).size, 1, group.join("/"));
    }
  });
  it("finds the one product a seller means", () => {
    for (const [said, expected] of [["saree", "Maheshwari cotton sari"], ["Jhumke", "Hammered brass jhumkas"], ["brass ke jhumke", "Hammered brass jhumkas"], ["clay cup", "Narmada clay cup, set of two"], ["kantha", "Block-print kantha throw"]]) {
      assert.deepEqual(matchProducts(said, catalogue).map((p) => p.name), [expected], said);
    }
  });
  it("does not invent a match for unrelated words", () => {
    assert.deepEqual(matchProducts("laptop", catalogue), []);
    assert.equal(productMatchScore("sari", "Block-print kantha throw"), 0);
  });
});

describe("Tamil and Tanglish confirmations", () => {
  it("accepts a clear Tamil yes", () => {
    for (const yes of ["ஆமாம், அனுப்புங்க.", "ஆமா", "Aama, anuppunga.", "Seri, pannunga", "சரி"]) assert.equal(isAffirmative(yes), true, yes);
  });
  it("refuses a Tamil no or a changed mind", () => {
    for (const no of ["இல்ல, வேண்டாம்", "Illa, vendam", "ஆமா... இல்ல, இருங்க", "Aama, illa wait"]) assert.equal(isAffirmative(no), false, no);
  });
});

describe("misheard order numbers", () => {
  it("suggests real orders one digit away, never more", () => {
    assert.deepEqual(nearOrderNumbers(1353, [1042, 1050, 1053, 1055]), [1053]);
    assert.deepEqual(nearOrderNumbers(1059, [1050, 1053, 1055]), [1050, 1053, 1055]);
    assert.deepEqual(nearOrderNumbers(2222, [1042, 1050]), []);
    assert.deepEqual(nearOrderNumbers(1050, [1050]), [], "an exact match is not a near miss");
  });
});

describe("client address behind proxies", () => {
  it("uses the last X-Forwarded-For hop on Cloud Run and the first elsewhere", async () => {
    const { clientKey } = await import("../server/auth");
    const req = { headers: { "x-forwarded-for": "6.6.6.6, 49.36.1.2" }, socket: { remoteAddress: "10.0.0.1" } } as any;
    assert.equal(clientKey(req, { K_SERVICE: "shopbridge" } as any), "49.36.1.2", "a forged first hop is ignored on Cloud Run");
    assert.equal(clientKey(req, {} as any), "6.6.6.6");
    assert.equal(clientKey({ headers: {}, socket: { remoteAddress: "10.0.0.1" } } as any, {} as any), "10.0.0.1");
  });
});
