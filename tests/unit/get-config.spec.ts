/**
 * Unit tests for the pure logic behind scripts/get-config.ts
 * (scripts/config-fields.ts). No validator / provider needed — runs via
 * `yarn test:unit` and within the full `anchor test`.
 */
import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  ConfigAccount,
  feeBpsToPercent,
  formatConfig,
  parseGetArgs,
} from "../../scripts/config-fields";

const PK_A = "5gfPFweV3zJovznZqBra3rv5tWJ5EHVzQY1PqvNA4HGg";
const PK_B = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

describe("get-config / config-fields", () => {
  describe("feeBpsToPercent", () => {
    it("formats whole percentages without decimals", () => {
      expect(feeBpsToPercent(0)).to.equal("0%");
      expect(feeBpsToPercent(1000)).to.equal("10%");
      expect(feeBpsToPercent(10000)).to.equal("100%");
    });

    it("formats fractional percentages", () => {
      expect(feeBpsToPercent(1234)).to.equal("12.34%");
      expect(feeBpsToPercent(50)).to.equal("0.5%");
    });
  });

  describe("formatConfig", () => {
    const cfg: ConfigAccount = {
      admin: new PublicKey(PK_A),
      usdcMint: new PublicKey(PK_B),
      treasuryWallet: new PublicKey(PK_A),
      liquidityGuard: new PublicKey(PK_B),
      facilitatorFeeBps: 1500,
      bump: 254,
    };

    it("renders every field as a display line", () => {
      const text = formatConfig(cfg).join("\n");
      expect(text).to.contain(PK_A); // admin / treasury (base58)
      expect(text).to.contain(PK_B); // usdcMint / liquidityGuard (base58)
      expect(text).to.match(/facilitatorFeeBps:\s*1500 \(15%\)/);
      expect(text).to.match(/bump\s*:\s*254/);
    });

    it("returns one line per field (6 fields)", () => {
      expect(formatConfig(cfg)).to.have.length(6);
    });
  });

  describe("parseGetArgs", () => {
    it("defaults json and help to false", () => {
      expect(parseGetArgs([])).to.deep.equal({ json: false, help: false });
    });

    it("recognizes --json and --help", () => {
      expect(parseGetArgs(["--json"]).json).to.equal(true);
      expect(parseGetArgs(["--help"]).help).to.equal(true);
      expect(parseGetArgs(["--json", "--help"])).to.deep.equal({
        json: true,
        help: true,
      });
    });

    it("throws on an unknown flag", () => {
      expect(() => parseGetArgs(["--nope"])).to.throw(/Unknown flag/);
    });

    it("throws on a non-flag argument", () => {
      expect(() => parseGetArgs(["oops"])).to.throw(/must start with --/);
    });
  });
});
