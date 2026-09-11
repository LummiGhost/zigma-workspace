import { afterEach, describe, expect, it } from "vitest";
import { ZigmaError } from "../../src/types/index.js";
import {
  MANAGED_REQUIRED_CAPABILITIES,
  validateProviderContract,
} from "../../src/core/negotiation.js";
import {
  cleanupTempDirs,
  ensureBuiltDist,
  expectOk,
  invokeCli,
  parseEnvelope,
} from "./helpers.js";

const FULL_INFO = {
  provider: "zigma-workspace",
  package_version: "0.1.5",
  contract_version: 1,
  capabilities: [...MANAGED_REQUIRED_CAPABILITIES],
  managed_supported: true,
  managed_required_capabilities: [...MANAGED_REQUIRED_CAPABILITIES],
};

function expectCode(fn: () => unknown, code: string): ZigmaError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ZigmaError);
    expect((err as ZigmaError).code).toBe(code);
    return err as ZigmaError;
  }
  throw new Error(`expected ZigmaError ${code}`);
}

afterEach(() => cleanupTempDirs());

describe("validateProviderContract (production module)", () => {
  it("accepts a complete managed provider contract", () => {
    const result = validateProviderContract(FULL_INFO);
    expect(result).toMatchObject({ supported: true, provider: "zigma-workspace", contractVersion: 1 });
    expect(result.capabilities).toContain("workspace-prepare-run-v1");
  });

  it("rejects a foreign provider", () => {
    const err = expectCode(
      () => validateProviderContract({ ...FULL_INFO, provider: "other-provider" }),
      "PROVIDER_MISMATCH",
    );
    expect(err.details?.expected).toBe("zigma-workspace");
  });

  it("rejects an unsupported contract version, including unknown majors", () => {
    expectCode(
      () => validateProviderContract({ ...FULL_INFO, contract_version: 2 }),
      "CONTRACT_VERSION_UNSUPPORTED",
    );
    expectCode(
      () => validateProviderContract({ ...FULL_INFO, contract_version: "1" }),
      "CONTRACT_VERSION_UNSUPPORTED",
    );
    expectCode(
      () => validateProviderContract({ ...FULL_INFO, contract_version: "not-a-number" }),
      "CONTRACT_VERSION_UNSUPPORTED",
    );
  });

  it("fails closed on any missing managed capability", () => {
    for (const missing of MANAGED_REQUIRED_CAPABILITIES) {
      const err = expectCode(
        () =>
          validateProviderContract({
            ...FULL_INFO,
            capabilities: FULL_INFO.capabilities.filter((c) => c !== missing),
          }),
        "MANAGED_CAPABILITIES_MISSING",
      );
      expect(err.details?.missing_capabilities).toEqual([missing]);
    }
  });

  it("fails closed when the provider explicitly reports managed unsupported", () => {
    const err = expectCode(
      () => validateProviderContract({ ...FULL_INFO, managed_supported: false }),
      "MANAGED_CAPABILITIES_MISSING",
    );
    expect(err.details?.managed_supported).toBe(false);
  });

  it("does not reject contracts that omit the optional managed fields when capabilities are complete", () => {
    const { managed_supported: _s, managed_required_capabilities: _r, ...withoutOptional } = FULL_INFO;
    expect(validateProviderContract(withoutOptional).supported).toBe(true);
  });
});

describe("contract-info and negotiate over the built CLI", () => {
  it("advertises the managed contract and negotiate accepts it", async () => {
    await ensureBuiltDist();

    const info = expectOk(invokeCli(["contract-info", "--json"]));
    expect(info.data).toMatchObject({
      provider: "zigma-workspace",
      contract_version: 1,
      managed_supported: true,
    });
    expect(info.data?.capabilities).toEqual(expect.arrayContaining([...MANAGED_REQUIRED_CAPABILITIES]));
    expect(info.data?.managed_required_capabilities).toEqual([...MANAGED_REQUIRED_CAPABILITIES]);

    const neg = expectOk(invokeCli(["negotiate", "--json"]));
    expect(neg.data).toMatchObject({
      role: "managed",
      supported: true,
      contract_version: 1,
      provider: "zigma-workspace",
    });
    expect(neg.data?.required_capabilities).toEqual([...MANAGED_REQUIRED_CAPABILITIES]);

    // contract-info and negotiate must not require a state directory.
    const noState = expectOk(invokeCli(["contract-info", "--state-dir", "Z:\\does-not-exist", "--json"]));
    expect(noState.data?.provider).toBe("zigma-workspace");
  });

  it("negotiate rejects unknown roles with a structured error envelope", async () => {
    await ensureBuiltDist();
    const r = invokeCli(["negotiate", "--role", "bogus", "--json"]);
    expect(r.status).toBe(1);
    const envelope = parseEnvelope(r.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("INVALID_INPUT");
  });
});
