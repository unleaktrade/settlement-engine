/**
 * Unit tests for scripts/sbf-stack.ts (SBF stack-frame guard). Pure string
 * processing — no validator, no toolchain — runs via `yarn test:unit`.
 */
import { expect } from "chai";
import {
  buildReport,
  classify,
  demangle,
  main,
  measureFrames,
  parseStackOverflows,
  renderMarkdown,
  wasCrateCompiled,
} from "../../scripts/sbf-stack";

// Verbatim diagnostic produced by platform-tools v1.48 when one extra
// unboxed account was added to CompleteSettlement.
const COMPLETE_SETTLEMENT_SYMBOL =
  "_ZN223_$LT$settlement_engine..instructions..settlement..complete_settlement..CompleteSettlement$u20$as$u20$anchor_lang..Accounts$LT$settlement_engine..instructions..settlement..complete_settlement..CompleteSettlementBumps$GT$$GT$12try_accounts17h2641a1006af111b4E";
const OVERFLOW_LINE =
  `Error: Function ${COMPLETE_SETTLEMENT_SYMBOL} Stack offset of 4104 exceeded max offset of 4096 by 8 bytes, ` +
  "please minimize large stack variables. Estimated function frame size: 4288 bytes. " +
  "Exceeding the maximum stack offset may cause undefined behavior during execution.";

describe("sbf-stack", () => {
  describe("demangle", () => {
    it("demangles legacy Rust symbols and drops the hash", () => {
      expect(demangle(COMPLETE_SETTLEMENT_SYMBOL)).to.equal(
        "<settlement_engine::instructions::settlement::complete_settlement::CompleteSettlement" +
          " as anchor_lang::Accounts<settlement_engine::instructions::settlement::complete_settlement::CompleteSettlementBumps>>::try_accounts"
      );
    });

    it("handles plain paths", () => {
      expect(
        demangle(
          "_ZN17settlement_engine9__private8__global19complete_settlement17h0123456789abcdefE"
        )
      ).to.equal("settlement_engine::__private::__global::complete_settlement");
    });

    it("leaves non-Rust symbols untouched", () => {
      expect(demangle("entrypoint")).to.equal("entrypoint");
      expect(demangle("_ZNbogusE")).to.equal("_ZNbogusE");
    });
  });

  describe("parseStackOverflows", () => {
    it("returns nothing for a clean build log", () => {
      const log =
        "   Compiling settlement-engine v1.0.0\n    Finished `release` profile [optimized] target(s) in 16.99s\n";
      expect(parseStackOverflows(log)).to.deep.equal([]);
    });

    it("extracts the overflowing function, offsets and frame size", () => {
      const log = `   Compiling settlement-engine v1.0.0\n${OVERFLOW_LINE}\n\n    Finished \`release\` profile`;
      const [o, ...rest] = parseStackOverflows(log);
      expect(rest).to.have.length(0);
      expect(o.symbol).to.equal(COMPLETE_SETTLEMENT_SYMBOL);
      expect(o.name).to.contain("CompleteSettlement as anchor_lang::Accounts");
      expect(o.stackOffset).to.equal(4104);
      expect(o.maxOffset).to.equal(4096);
      expect(o.exceededBy).to.equal(8);
      expect(o.estimatedFrameSize).to.equal(4288);
    });

    it("de-duplicates repeated diagnostics for the same symbol", () => {
      const log = [OVERFLOW_LINE, OVERFLOW_LINE].join("\n");
      expect(parseStackOverflows(log)).to.have.length(1);
    });

    it("tolerates a diagnostic without the frame-size estimate", () => {
      const log =
        "Error: Function _ZN3foo3bar17h0123456789abcdefE Stack offset of 4200 exceeded max offset of 4096 by 104 bytes, please minimize large stack variables";
      const [o] = parseStackOverflows(log);
      expect(o.name).to.equal("foo::bar");
      expect(o.estimatedFrameSize).to.equal(undefined);
    });
  });

  describe("wasCrateCompiled", () => {
    it("detects that the program crate was (re)compiled", () => {
      const log =
        "   Compiling anchor-lang v0.32.1\n   Compiling settlement-engine v1.0.0 (/repo/programs/settlement-engine)\n";
      expect(wasCrateCompiled(log, "settlement-engine")).to.equal(true);
    });

    it("rejects a log where only dependencies or nothing were compiled", () => {
      expect(
        wasCrateCompiled(
          "    Finished `release` profile [optimized] target(s) in 0.40s\n",
          "settlement-engine"
        )
      ).to.equal(false);
      expect(
        wasCrateCompiled(
          "   Compiling settlement-engine-cli v0.1.0\n",
          "settlement-engine"
        )
      ).to.equal(false);
    });
  });

  describe("measureFrames", () => {
    const disassembly = [
      "0000000000000120 <_ZN3foo5small17h0123456789abcdefE>:",
      "     120:      \tstxdw [r10 - 0x10], r1",
      "     128:      \tldxdw r2, [r10 - 0x18]",
      "     130:      \texit",
      "",
      "0000000000000200 <_ZN3foo4wide17h0123456789abcdefE>:",
      "     200:      \tstxdw [r10 - 0x200], r1",
      "     208:      \tstdw [r10 - 0x8], 0",
      "     210:      \texit",
      "",
      // >5 args: the outgoing-args block at the frame bottom must be ignored
      "0000000000000300 <_ZN3foo10dispatcher17h0123456789abcdefE>:",
      "     300:      \tstxdw [r10 - 0x100], r1",
      "     308:      \tstxdw [r10 - 0x1000], r2",
      "     310:      \tstxdw [r10 - 0xff8], r3",
      "     318:      \tmov64 r5, r10",
      "     320:      \tcall 0x10",
      "",
      // without `mov64 r5, r10` deep stores are genuine locals
      "0000000000000400 <_ZN3foo4deep17h0123456789abcdefE>:",
      "     400:      \tstxdw [r10 - 0xff8], r1",
    ].join("\n");

    it("reports the deepest frame offset per function", () => {
      const byName: { [n: string]: number } = {};
      for (const f of measureFrames(disassembly)) byName[f.name] = f.bytes;
      expect(byName["foo::small"]).to.equal(0x18);
      expect(byName["foo::wide"]).to.equal(0x200);
      expect(byName["foo::dispatcher"]).to.equal(0x100);
      expect(byName["foo::deep"]).to.equal(0xff8);
    });
  });

  describe("classify / buildReport", () => {
    it("recognises try_accounts, handlers and dispatchers", () => {
      expect(classify(demangle(COMPLETE_SETTLEMENT_SYMBOL))).to.deep.equal({
        kind: "accounts",
        label: "CompleteSettlement",
      });
      expect(
        classify(
          "settlement_engine::instructions::settlement::complete_settlement::complete_settlement_handler"
        )
      ).to.deep.equal({
        kind: "handler",
        label: "complete_settlement_handler",
      });
      expect(
        classify("settlement_engine::__private::__global::open_rfq")
      ).to.deep.equal({ kind: "dispatch", label: "open_rfq" });
      expect(classify("anchor_spl::token::transfer")).to.equal(null);
    });

    it("keeps the worst function per label (init closures fold into try_accounts)", () => {
      const accounts =
        "<settlement_engine::instructions::rfq::init_rfq::InitRfq as anchor_lang::Accounts<settlement_engine::instructions::rfq::init_rfq::InitRfqBumps>>::try_accounts";
      const rows = buildReport([
        { symbol: "a", name: accounts, bytes: 3664 },
        { symbol: "b", name: accounts + "::{{closure}}", bytes: 1504 },
        {
          symbol: "c",
          name: "settlement_engine::state::rfq::Rfq::funding_deadline",
          bytes: 64,
        },
      ]);
      expect(rows).to.deep.equal([
        { kind: "accounts", label: "InitRfq", bytes: 3664, percent: 89 },
      ]);
    });

    it("renders a markdown table and flags rows above the threshold", () => {
      const md = renderMarkdown(
        [
          {
            kind: "accounts",
            label: "CompleteSettlement",
            bytes: 3720,
            percent: 91,
          },
          {
            kind: "handler",
            label: "open_rfq_handler",
            bytes: 824,
            percent: 20,
          },
        ],
        90
      );
      expect(md).to.contain(
        "| `CompleteSettlement` | `try_accounts` | 3720 | 91% ⚠️ |"
      );
      expect(md).to.contain("| `open_rfq_handler` | handler | 824 | 20% |");
    });
  });

  describe("main", () => {
    it("prints usage and exits 2 on bad arguments", () => {
      const err = console.error;
      console.error = () => undefined;
      try {
        expect(main([])).to.equal(2);
        expect(main(["--help"])).to.equal(0);
      } finally {
        console.error = err;
      }
    });
  });
});
