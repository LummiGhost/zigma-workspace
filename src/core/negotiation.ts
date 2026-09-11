import { CONTRACT_VERSION, ZigmaError } from "../types/index.js";

/**
 * Managed-mode negotiation: consumers must prove the provider supports the
 * full managed Run/Job lifecycle before activating it. Partial activation
 * (e.g. prepare-run present but publish missing) would strand a run halfway,
 * so the check is fail-closed: any gap throws.
 */

export const EXPECTED_PROVIDER = "zigma-workspace";

export const MANAGED_REQUIRED_CAPABILITIES = [
  "workspace-prepare-run-v1",
  "workspace-prepare-job-v1",
  "workspace-commit-v1",
  "workspace-integrate-v1",
  "workspace-publish-v1",
  "workspace-strict-cleanup-v1",
  "workspace-reconcile-v1",
  "workspace-heartbeat-v1",
  "workspace-cleanup-v1",
] as const;

export interface ProviderContractInfo {
  provider: string;
  package_version: string;
  contract_version: number | string;
  capabilities: string[];
  managed_supported?: boolean;
  managed_required_capabilities?: string[];
}

export interface NegotiationResult {
  supported: true;
  provider: string;
  contractVersion: number;
  capabilities: string[];
  requiredCapabilities: string[];
}

export function validateProviderContract(
  info: ProviderContractInfo,
  required: readonly string[] = MANAGED_REQUIRED_CAPABILITIES,
): NegotiationResult {
  if (info.provider !== EXPECTED_PROVIDER) {
    throw new ZigmaError(
      "PROVIDER_MISMATCH",
      `Provider "${info.provider}" is not "${EXPECTED_PROVIDER}"`,
      { provider: info.provider, expected: EXPECTED_PROVIDER },
    );
  }

  const version = info.contract_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version !== CONTRACT_VERSION) {
    throw new ZigmaError(
      "CONTRACT_VERSION_UNSUPPORTED",
      `Unsupported contract version "${String(info.contract_version)}"; expected ${CONTRACT_VERSION}`,
      { contract_version: info.contract_version, expected: CONTRACT_VERSION },
    );
  }

  // A provider that explicitly reports managed mode unsupported fails closed
  // even if its capability list happens to look complete.
  if (info.managed_supported === false) {
    throw new ZigmaError(
      "MANAGED_CAPABILITIES_MISSING",
      "Provider reports managed mode unsupported",
      { managed_supported: false, required_capabilities: [...required] },
    );
  }

  // A malformed contract (missing/foreign capability list) must fail closed
  // with a typed error, not a raw TypeError, so in-process consumers get the
  // same taxonomy as CLI routing.
  const caps = new Set(Array.isArray(info.capabilities) ? info.capabilities : []);
  const missing = required.filter((c) => !caps.has(c));
  if (missing.length > 0) {
    throw new ZigmaError(
      "MANAGED_CAPABILITIES_MISSING",
      `Provider lacks required capabilities: ${missing.join(", ")}`,
      { missing_capabilities: missing, required_capabilities: [...required] },
    );
  }

  return {
    supported: true,
    provider: info.provider,
    contractVersion: version,
    capabilities: [...info.capabilities],
    requiredCapabilities: [...required],
  };
}
