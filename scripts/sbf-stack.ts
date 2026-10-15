/// <reference types="node" />
/**
 * SBF stack-frame guard for the settlement-engine program.
 *
 * Every SBF function gets a fixed 4 KiB stack frame. When a function needs
 * more, the LLVM SBF backend prints
 *
 *   Error: Function <mangled> Stack offset of N exceeded max offset of 4096
 *   by M bytes, please minimize large stack variables. Estimated function
 *   frame size: F bytes. Exceeding the maximum stack offset may cause
 *   undefined behavior during execution.
 *
 * …but `anchor build` / `cargo build-sbf` still finish successfully and emit a
 * `.so`. Shipping that binary means memory corruption at runtime, so this
 * script turns the diagnostic into a hard failure and reports how close each
 * instruction is to the limit.
 *
 * Usage:
 *
 *   # Fail (exit 1) if a captured build log contains a stack overflow
 *   anchor build 2>&1 | tee sbf-build.log
 *   yarn sbf-stack check sbf-build.log
 *
 *   # Per-instruction frame usage table (markdown), from the unstripped .so
 *   yarn sbf-stack report target/sbpf-solana-solana/release/settlement_engine.so
 *
 * Flags (check):
 *   --crate <name>     Cargo package that must appear as "Compiling <name>" in
 *                      the log (default settlement-engine) — guards against a
 *                      cached build that never re-ran LLVM codegen
 *
 * Flags (report):
 *   --warn-at <pct>    Emit a GitHub `::warning::` for frames >= pct% (default 90)
 *   --summary <file>   Also append the markdown table to <file>
 *                      (e.g. "$GITHUB_STEP_SUMMARY")
 *   --objdump <path>   llvm-objdump to use (default: $SBF_OBJDUMP, else the
 *                      newest ~/.cache/solana/<v>/platform-tools/llvm/bin/llvm-objdump)
 *   --all              Include every program function, not only Anchor
 *                      `try_accounts`, `*_handler` and dispatch functions
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Fixed SBF stack frame size (bytes). */
export const SBF_FRAME_SIZE = 4096;

/** Program crate name as it appears in symbols. */
export const PROGRAM_CRATE = "settlement_engine";

/** Cargo package name as it appears in "Compiling …" lines. */
export const PROGRAM_PACKAGE = "settlement-engine";

// ---------------------------------------------------------------------------
// Build-log diagnostics
// ---------------------------------------------------------------------------

export interface StackOverflow {
  /** Mangled symbol, as printed by LLVM. */
  symbol: string;
  /** Demangled symbol (without the trailing `::h<hash>`). */
  name: string;
  stackOffset: number;
  maxOffset: number;
  exceededBy: number;
  /** "Estimated function frame size", when LLVM prints it. */
  estimatedFrameSize?: number;
}

const OVERFLOW_RE =
  /Function (\S+) Stack offset of (\d+) exceeded max offset of (\d+) by (\d+) bytes[^\n]*/g;
const FRAME_SIZE_RE = /Estimated function frame size: (\d+) bytes/;

/** Extract every "Stack offset … exceeded" diagnostic from a build log. */
export function parseStackOverflows(log: string): StackOverflow[] {
  const out: StackOverflow[] = [];
  const seen: { [symbol: string]: boolean } = {};
  OVERFLOW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OVERFLOW_RE.exec(log)) !== null) {
    const symbol = m[1];
    if (seen[symbol]) continue; // LLVM may repeat the same diagnostic
    seen[symbol] = true;
    const frame = FRAME_SIZE_RE.exec(m[0]);
    out.push({
      symbol,
      name: demangle(symbol),
      stackOffset: parseInt(m[2], 10),
      maxOffset: parseInt(m[3], 10),
      exceededBy: parseInt(m[4], 10),
      estimatedFrameSize: frame ? parseInt(frame[1], 10) : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rust legacy symbol demangling (the SBF toolchain uses legacy mangling)
// ---------------------------------------------------------------------------

const ESCAPES: { [k: string]: string } = {
  SP: "@",
  BP: "*",
  RF: "&",
  LT: "<",
  GT: ">",
  LP: "(",
  RP: ")",
  C: ",",
};

function unescapeSegment(seg: string): string {
  let s = seg;
  if (s.indexOf("_$") === 0) s = s.slice(1);
  s = s.replace(/\$([A-Z]{1,2}|u[0-9a-f]{2,6})\$/g, (whole, code: string) => {
    if (ESCAPES[code] !== undefined) return ESCAPES[code];
    if (code.charAt(0) === "u") {
      return String.fromCharCode(parseInt(code.slice(1), 16));
    }
    return whole;
  });
  return s.replace(/\.\./g, "::");
}

/**
 * Demangle a Rust legacy symbol (`_ZN…E`) and drop the trailing hash segment.
 * Anything that is not a legacy Rust symbol is returned unchanged.
 */
export function demangle(symbol: string): string {
  const m = /^_?_ZN(.*)E$/.exec(symbol);
  if (!m) return symbol;
  const body = m[1];
  const parts: string[] = [];
  let i = 0;
  while (i < body.length) {
    let j = i;
    while (j < body.length && body.charAt(j) >= "0" && body.charAt(j) <= "9") {
      j++;
    }
    if (j === i) return symbol; // not a well-formed legacy symbol
    const len = parseInt(body.slice(i, j), 10);
    parts.push(body.slice(j, j + len));
    i = j + len;
  }
  const last = parts[parts.length - 1];
  if (last && /^h[0-9a-f]{16}$/.test(last)) parts.pop();
  return parts.map(unescapeSegment).join("::");
}

// ---------------------------------------------------------------------------
// Frame usage from disassembly
// ---------------------------------------------------------------------------

export interface FrameUsage {
  symbol: string;
  name: string;
  /** Deepest `[r10 - X]` offset the function touches (≈ frame bytes used). */
  bytes: number;
}

/**
 * Outgoing stack arguments (calls with more than 5 arguments) are written at
 * the very bottom of the caller's frame and passed via `r5 = r10`. Those slots
 * are not locals, so stores in this window are ignored for functions that set
 * up `mov64 r5, r10`; otherwise every dispatcher would read as ~100%.
 */
const OUTGOING_ARGS_WINDOW = 256;

const FUNC_RE = /^[0-9a-f]+ <(.+)>:\s*$/;
const MOV_R5_R10_RE = /\bmov64 r5, r10\b/;
// `stxdw [r10 - 0x18], r1` / `stdw [r10 - 0x8], 0` / `ldxdw r1, [r10 - 0x10]`
const FRAME_ACCESS_RE = /\b(st|ld)\w*(?: r\d+,)? \[r10 - 0x([0-9a-f]+)\]/g;

/**
 * Approximate per-function frame usage from `llvm-objdump -d` output: the
 * deepest frame-pointer offset touched. LLVM only prints exact frame sizes
 * when the limit is exceeded, so this is an estimate — the hard gate remains
 * the compiler diagnostic (see `parseStackOverflows`).
 */
export function measureFrames(disassembly: string): FrameUsage[] {
  const out: FrameUsage[] = [];
  let current: string | null = null;
  let r5IsFrame = false;
  let accesses: Array<{ store: boolean; offset: number }> = [];

  const flush = () => {
    if (current === null) return;
    let bytes = 0;
    for (const a of accesses) {
      if (
        r5IsFrame &&
        a.store &&
        a.offset > SBF_FRAME_SIZE - OUTGOING_ARGS_WINDOW
      ) {
        continue;
      }
      if (a.offset > bytes) bytes = a.offset;
    }
    out.push({ symbol: current, name: demangle(current), bytes });
  };

  for (const line of disassembly.split("\n")) {
    const f = FUNC_RE.exec(line);
    if (f) {
      flush();
      current = f[1];
      r5IsFrame = false;
      accesses = [];
      continue;
    }
    if (current === null) continue;
    if (MOV_R5_R10_RE.test(line)) r5IsFrame = true;
    FRAME_ACCESS_RE.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = FRAME_ACCESS_RE.exec(line)) !== null) {
      accesses.push({ store: a[1] === "st", offset: parseInt(a[2], 16) });
    }
  }
  flush();
  return out;
}

export type FunctionKind = "accounts" | "handler" | "dispatch" | "other";

export interface Classified {
  kind: FunctionKind;
  /** Accounts struct, handler fn, or instruction name. */
  label: string;
}

/** Classify a demangled program symbol; `null` for non-program code. */
export function classify(
  name: string,
  crate = PROGRAM_CRATE
): Classified | null {
  if (name.indexOf(crate + "::") === -1) return null;
  const accounts = new RegExp(
    "^<" +
      crate +
      "::(?:\\w+::)*(\\w+) as anchor_lang::Accounts<.*>>::try_accounts"
  ).exec(name);
  if (accounts) return { kind: "accounts", label: accounts[1] };
  const handler = /::(\w+_handler)(?:::|$)/.exec(name);
  if (handler) return { kind: "handler", label: handler[1] };
  const dispatch = new RegExp(
    "^" + crate + "::__private::__global::(\\w+)$"
  ).exec(name);
  if (dispatch) return { kind: "dispatch", label: dispatch[1] };
  return { kind: "other", label: name };
}

export interface ReportRow {
  kind: FunctionKind;
  label: string;
  bytes: number;
  percent: number;
}

/**
 * Aggregate frames per (kind, label), keeping the worst function (closures
 * generated for `init` constraints are folded into their `try_accounts`).
 */
export function buildReport(
  frames: FrameUsage[],
  opts: { all?: boolean; crate?: string } = {}
): ReportRow[] {
  const worst: { [key: string]: ReportRow } = {};
  for (const f of frames) {
    const c = classify(f.name, opts.crate);
    if (!c) continue;
    if (c.kind === "other" && !opts.all) continue;
    const key = c.kind + "|" + c.label;
    if (!worst[key] || worst[key].bytes < f.bytes) {
      worst[key] = {
        kind: c.kind,
        label: c.label,
        bytes: f.bytes,
        percent: Math.round((f.bytes * 100) / SBF_FRAME_SIZE),
      };
    }
  }
  return Object.keys(worst)
    .map((k) => worst[k])
    .sort((a, b) => b.bytes - a.bytes || (a.label < b.label ? -1 : 1));
}

const KIND_LABEL: { [k in FunctionKind]: string } = {
  accounts: "`try_accounts`",
  handler: "handler",
  dispatch: "dispatch",
  other: "other",
};

export function renderMarkdown(rows: ReportRow[], warnAt: number): string {
  const lines = [
    "### SBF stack frame usage (settlement-engine)",
    "",
    `Approximate deepest frame offset per function, out of ${SBF_FRAME_SIZE} bytes. ` +
      "The build fails only on the compiler's own overflow diagnostic; this table is the early warning.",
    "",
    "| Function | Kind | Bytes | % of 4 KiB |",
    "|---|---|---:|---:|",
  ];
  for (const r of rows) {
    const flag = r.percent >= warnAt ? " ⚠️" : "";
    lines.push(
      `| \`${r.label}\` | ${KIND_LABEL[r.kind]} | ${r.bytes} | ${
        r.percent
      }%${flag} |`
    );
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function compareVersions(a: string, b: string): number {
  const pa = a
    .replace(/^v/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const pb = b
    .replace(/^v/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function findObjdump(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SBF_OBJDUMP) return env.SBF_OBJDUMP;
  const cache = path.join(os.homedir(), ".cache", "solana");
  const versions = fs.existsSync(cache)
    ? fs
        .readdirSync(cache)
        .filter((v) =>
          fs.existsSync(
            path.join(cache, v, "platform-tools", "llvm", "bin", "llvm-objdump")
          )
        )
        .sort(compareVersions)
    : [];
  if (versions.length === 0) {
    throw new Error(
      "llvm-objdump not found: set SBF_OBJDUMP or run `anchor build` first " +
        "(platform-tools are installed under ~/.cache/solana)."
    );
  }
  const newest = versions[versions.length - 1];
  return path.join(
    cache,
    newest,
    "platform-tools",
    "llvm",
    "bin",
    "llvm-objdump"
  );
}

const isGitHubActions = (env: NodeJS.ProcessEnv = process.env) =>
  env.GITHUB_ACTIONS === "true";

/**
 * LLVM prints the stack diagnostic only while generating code. A build that
 * reused a cached artifact for the program crate would pass the gate without
 * checking anything, so `check` insists the crate was actually compiled.
 */
export function wasCrateCompiled(log: string, crate: string): boolean {
  const escaped = crate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^\\s*Compiling " + escaped + " v", "m").test(log);
}

function check(logPath: string, args: string[]): number {
  let crate = PROGRAM_PACKAGE;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--crate") crate = args[++i];
    else throw new Error(`Unknown flag: ${args[i]}`);
  }
  const log = fs.readFileSync(logPath, "utf8");
  if (log.trim().length === 0) {
    console.error(`${logPath} is empty — did the build run?`);
    return 2;
  }
  if (!wasCrateCompiled(log, crate)) {
    console.error(
      `${logPath} has no "Compiling ${crate}" line: the program was not ` +
        "recompiled (stale cache?), so LLVM had no chance to report stack " +
        "overflows. Touch the program sources or clean the crate and rebuild."
    );
    return 2;
  }
  const overflows = parseStackOverflows(log);
  if (overflows.length === 0) {
    console.log("✅ No SBF stack frame overflow in", logPath);
    return 0;
  }
  console.error(
    `❌ ${overflows.length} function(s) exceed the ${SBF_FRAME_SIZE}-byte SBF stack frame.` +
      ' The build "succeeded" but the binary has undefined behavior:\n'
  );
  for (const o of overflows) {
    const frame =
      o.estimatedFrameSize !== undefined
        ? `, estimated frame ${o.estimatedFrameSize} bytes`
        : "";
    const msg = `${o.name}: stack offset ${o.stackOffset} exceeds ${o.maxOffset} by ${o.exceededBy} bytes${frame}`;
    console.error("  - " + msg);
    if (isGitHubActions())
      console.log(`::error title=SBF stack overflow::${msg}`);
  }
  console.error(
    "\nFix: Box<Account<…>> large accounts, move rarely-used accounts out of the" +
      " Accounts struct, or split the instruction. See README › SBF stack guard."
  );
  return 1;
}

function report(soPath: string, args: string[]): number {
  let warnAt = 90;
  let objdump: string | undefined;
  let all = false;
  let summary: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--warn-at") warnAt = parseInt(args[++i], 10);
    else if (args[i] === "--objdump") objdump = args[++i];
    else if (args[i] === "--summary") summary = args[++i];
    else if (args[i] === "--all") all = true;
    else throw new Error(`Unknown flag: ${args[i]}`);
  }
  if (!fs.existsSync(soPath)) {
    throw new Error(`${soPath} not found — build the program first.`);
  }
  const res = spawnSync(
    objdump || findObjdump(),
    ["-d", "--no-show-raw-insn", soPath],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }
  );
  if (res.status !== 0) {
    throw new Error(`llvm-objdump failed: ${res.stderr || res.error}`);
  }
  const rows = buildReport(measureFrames(res.stdout), { all });
  if (rows.length === 0) {
    throw new Error(
      `No ${PROGRAM_CRATE} symbols in ${soPath} — use the unstripped ` +
        "target/sbpf-solana-solana/release/*.so, not target/deploy/*.so."
    );
  }
  const markdown = renderMarkdown(rows, warnAt);
  process.stdout.write(markdown);
  if (summary) fs.appendFileSync(summary, markdown);
  if (isGitHubActions()) {
    for (const r of rows) {
      if (r.percent >= warnAt) {
        console.log(
          `::warning title=SBF stack near limit::${r.label} (${r.kind}) uses ~${r.bytes}/${SBF_FRAME_SIZE} bytes (${r.percent}%)`
        );
      }
    }
  }
  return 0;
}

const HELP = `Usage:
  sbf-stack check <build.log> [--crate <cargo-package>]
  sbf-stack report <program.so> [--warn-at <pct>] [--objdump <path>] [--summary <file>] [--all]`;

export function main(argv: string[]): number {
  const [cmd, target, ...rest] = argv;
  if (cmd === "check" && target) return check(target, rest);
  if (cmd === "report" && target) return report(target, rest);
  console.error(HELP);
  return cmd === "--help" || cmd === "-h" ? 0 : 2;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
}
