import contract from "../config/disklm-eval-contract.json" with { type: "json" };

if (contract.contractId !== "disklm-eval-v1") {
  throw new Error(
    `Unsupported DiskLM evaluation contract: ${contract.contractId}`,
  );
}

const deepFreeze = (value) => {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") deepFreeze(nested);
  }
  return Object.freeze(value);
};

export default deepFreeze(contract);
