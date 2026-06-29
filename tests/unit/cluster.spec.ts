/**
 * Unit tests for scripts/cluster.ts (resolveClusterUrl). Pure — no validator.
 */
import { expect } from "chai";
import {
  CLUSTER_ALIASES,
  DEFAULT_CLUSTER,
  resolveClusterUrl,
} from "../../scripts/cluster";

const DEVNET = CLUSTER_ALIASES[DEFAULT_CLUSTER];

describe("cluster / resolveClusterUrl", () => {
  it("defaults to devnet when unset, empty, or whitespace", () => {
    expect(resolveClusterUrl(undefined)).to.equal(DEVNET);
    expect(resolveClusterUrl("")).to.equal(DEVNET);
    expect(resolveClusterUrl("   ")).to.equal(DEVNET);
    expect(DEVNET).to.equal("https://api.devnet.solana.com");
  });

  it("expands known aliases (case-insensitive, trimmed)", () => {
    expect(resolveClusterUrl("devnet")).to.equal(
      "https://api.devnet.solana.com"
    );
    expect(resolveClusterUrl("testnet")).to.equal(
      "https://api.testnet.solana.com"
    );
    expect(resolveClusterUrl("mainnet")).to.equal(
      "https://api.mainnet-beta.solana.com"
    );
    expect(resolveClusterUrl("mainnet-beta")).to.equal(
      "https://api.mainnet-beta.solana.com"
    );
    expect(resolveClusterUrl("localnet")).to.equal("http://127.0.0.1:8899");
    expect(resolveClusterUrl("localhost")).to.equal("http://127.0.0.1:8899");
    expect(resolveClusterUrl("  DevNet ")).to.equal(
      "https://api.devnet.solana.com"
    );
  });

  it("passes full URLs through unchanged", () => {
    const url = "https://my.custom.rpc:8899";
    expect(resolveClusterUrl(url)).to.equal(url);
    expect(resolveClusterUrl("http://localhost:8899")).to.equal(
      "http://localhost:8899"
    );
  });

  it("passes unknown non-alias strings through unchanged", () => {
    expect(resolveClusterUrl("some-unknown-cluster")).to.equal(
      "some-unknown-cluster"
    );
  });
});
