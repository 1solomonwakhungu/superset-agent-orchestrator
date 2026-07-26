import contract from "../config/disklm-eval-contract.json" with { type: "json" };

if (contract.contractId !== "disklm-eval-v1") {
  throw new Error(
    `Unsupported DiskLM evaluation contract: ${contract.contractId}`,
  );
}

export default Object.freeze(contract);
