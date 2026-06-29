/**
 * Unit tests for the pure logic behind scripts/update-config.ts
 * (scripts/config-fields.ts). No validator / provider / `anchor build` needed —
 * these run standalone via `yarn test:unit` and within the full `anchor test`.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import {
  ConfigFields,
  computeChanges,
  fmt,
  normalize,
  parseArgv,
  parseFeeBps,
  readConfigFile,
  requirePubkey,
} from "../../scripts/config-fields";

// A couple of well-formed devnet/base58 pubkeys to exercise the pubkey paths.
const PK_A = "5gfPFweV3zJovznZqBra3rv5tWJ5EHVzQY1PqvNA4HGg";
const PK_B = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function tmpFile(name: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-config-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

describe("update-config / config-fields", () => {
  describe("parseFeeBps", () => {
    it("accepts the inclusive bounds 0 and 10000", () => {
      expect(parseFeeBps("fee", 0)).to.equal(0);
      expect(parseFeeBps("fee", 10000)).to.equal(10000);
    });

    it("coerces numeric strings", () => {
      expect(parseFeeBps("fee", "1500")).to.equal(1500);
    });

    it("rejects out-of-range, negative, fractional and non-numeric values", () => {
      expect(() => parseFeeBps("fee", -1)).to.throw(/0\.\.10000/);
      expect(() => parseFeeBps("fee", 10001)).to.throw(/0\.\.10000/);
      expect(() => parseFeeBps("fee", 1.5)).to.throw(/0\.\.10000/);
      expect(() => parseFeeBps("fee", "abc")).to.throw(/0\.\.10000/);
    });
  });

  describe("requirePubkey", () => {
    it("returns a PublicKey for valid base58", () => {
      expect(requirePubkey("admin", PK_A).toBase58()).to.equal(PK_A);
    });

    it("throws for garbage input", () => {
      expect(() => requirePubkey("admin", "not_a_key")).to.throw(
        /valid base58 pubkey/
      );
    });
  });

  describe("normalize", () => {
    it("maps camelCase, snake_case and flag aliases to canonical keys", () => {
      const out = normalize(
        {
          admin: PK_A,
          usdc_mint: PK_B,
          "treasury-wallet": PK_A,
          liquidityGuard: PK_B,
          facilitator_fee_bps: 1500,
        },
        "test"
      );
      expect(out.admin?.toBase58()).to.equal(PK_A);
      expect(out.usdcMint?.toBase58()).to.equal(PK_B);
      expect(out.treasuryWallet?.toBase58()).to.equal(PK_A);
      expect(out.liquidityGuard?.toBase58()).to.equal(PK_B);
      expect(out.facilitatorFeeBps).to.equal(1500);
    });

    it("accepts the `treasury` shorthand alias", () => {
      const out = normalize({ treasury: PK_A }, "test");
      expect(out.treasuryWallet?.toBase58()).to.equal(PK_A);
    });

    it("skips null / undefined values", () => {
      const out = normalize(
        { admin: null, usdcMint: undefined, facilitatorFeeBps: 10 },
        "test"
      );
      expect(out.admin).to.equal(undefined);
      expect(out.usdcMint).to.equal(undefined);
      expect(out.facilitatorFeeBps).to.equal(10);
    });

    it("throws on an unknown field", () => {
      expect(() => normalize({ bogus: 1 }, "test")).to.throw(/Unknown field/);
    });

    it("validates pubkey fields and fee fields it normalizes", () => {
      expect(() => normalize({ admin: "nope" }, "test")).to.throw(
        /valid base58 pubkey/
      );
      expect(() => normalize({ facilitatorFeeBps: 99999 }, "test")).to.throw(
        /0\.\.10000/
      );
    });
  });

  describe("readConfigFile", () => {
    it("parses JSON", () => {
      const f = tmpFile("c.json", JSON.stringify({ facilitatorFeeBps: 1500 }));
      expect(readConfigFile(f)).to.deep.equal({ facilitatorFeeBps: 1500 });
    });

    it("parses YAML", () => {
      const f = tmpFile("c.yaml", "facilitatorFeeBps: 1500\n");
      expect(readConfigFile(f)).to.deep.equal({ facilitatorFeeBps: 1500 });
    });

    it("produces identical normalized output from JSON and YAML", () => {
      const json = tmpFile(
        "c.json",
        JSON.stringify({ facilitator_fee_bps: 1500, treasuryWallet: PK_A })
      );
      const yaml = tmpFile(
        "c.yaml",
        `facilitator_fee_bps: 1500\ntreasuryWallet: "${PK_A}"\n`
      );
      const fromJson = normalize(readConfigFile(json), json);
      const fromYaml = normalize(readConfigFile(yaml), yaml);
      expect(fromJson.facilitatorFeeBps).to.equal(fromYaml.facilitatorFeeBps);
      expect(fromJson.treasuryWallet?.toBase58()).to.equal(
        fromYaml.treasuryWallet?.toBase58()
      );
    });

    it("throws on a missing file", () => {
      expect(() => readConfigFile("/no/such/file.yaml")).to.throw(/not found/);
    });

    it("throws on an unsupported extension", () => {
      const f = tmpFile("c.txt", "facilitatorFeeBps: 1");
      expect(() => readConfigFile(f)).to.throw(/must be \.json/);
    });

    it("throws when the top level is not an object", () => {
      const f = tmpFile("c.json", JSON.stringify([1, 2, 3]));
      expect(() => readConfigFile(f)).to.throw(/top-level object/);
    });
  });

  describe("parseArgv", () => {
    it("parses field flags into raw values", () => {
      const { raw, dryRun, help, configFile } = parseArgv([
        "--facilitator-fee-bps",
        "1500",
        "--admin",
        PK_A,
      ]);
      expect(raw["facilitator-fee-bps"]).to.equal("1500");
      expect(raw["admin"]).to.equal(PK_A);
      expect(dryRun).to.equal(false);
      expect(help).to.equal(false);
      expect(configFile).to.equal(undefined);
    });

    it("recognizes --config, --dry-run and --help", () => {
      const a = parseArgv(["--config", "x.yaml", "--dry-run"]);
      expect(a.configFile).to.equal("x.yaml");
      expect(a.dryRun).to.equal(true);
      expect(parseArgv(["--help"]).help).to.equal(true);
    });

    it("throws on a non-flag argument", () => {
      expect(() => parseArgv(["oops"])).to.throw(/must start with --/);
    });

    it("throws when a value-flag has no value", () => {
      expect(() => parseArgv(["--admin"])).to.throw(/requires a value/);
    });
  });

  describe("merge precedence (file then flags)", () => {
    it("lets CLI flags override file values", () => {
      const file = normalize({ facilitatorFeeBps: 1000, treasury: PK_A }, "f");
      const flags = normalize({ "facilitator-fee-bps": 2000 }, "flags");
      const merged: ConfigFields = { ...file, ...flags };
      expect(merged.facilitatorFeeBps).to.equal(2000); // flag wins
      expect(merged.treasuryWallet?.toBase58()).to.equal(PK_A); // file kept
    });
  });

  describe("computeChanges", () => {
    const current = {
      admin: new PublicKey(PK_A),
      usdcMint: new PublicKey(PK_A),
      treasuryWallet: new PublicKey(PK_A),
      liquidityGuard: new PublicKey(PK_A),
      facilitatorFeeBps: 1000,
    };

    it("skips fields whose value already matches on-chain", () => {
      const plan = computeChanges(current, {
        facilitatorFeeBps: 1000,
        usdcMint: new PublicKey(PK_A),
      });
      expect(Object.keys(plan.changes)).to.have.length(0);
      expect(plan.skipped).to.include("facilitatorFeeBps");
      expect(plan.skipped).to.include("usdcMint");
      expect(plan.rotatesAdmin).to.equal(false);
    });

    it("detects real changes and renders a diff line", () => {
      const plan = computeChanges(current, {
        facilitatorFeeBps: 2000,
        treasuryWallet: new PublicKey(PK_B),
      });
      expect(plan.changes.facilitatorFeeBps).to.equal(2000);
      expect(plan.changes.treasuryWallet?.toBase58()).to.equal(PK_B);
      expect(plan.lines.join("\n")).to.match(/treasuryWallet:.*->/);
      expect(plan.rotatesAdmin).to.equal(false);
    });

    it("flags admin rotation only when admin actually changes", () => {
      expect(
        computeChanges(current, { admin: new PublicKey(PK_A) }).rotatesAdmin
      ).to.equal(false); // same admin → no rotation
      expect(
        computeChanges(current, { admin: new PublicKey(PK_B) }).rotatesAdmin
      ).to.equal(true);
    });
  });

  describe("fmt", () => {
    it("formats pubkeys as base58 and numbers as strings", () => {
      expect(fmt(new PublicKey(PK_A))).to.equal(PK_A);
      expect(fmt(1500)).to.equal("1500");
    });
  });
});
