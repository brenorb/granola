export interface StoredProof {
  amount: string;
  id: string;
  secret: string;
  C: string;
  dleq?: unknown;
}

export interface WalletPocket {
  mintUrl: string;
  unit: string;
  proofs: StoredProof[];
}

export interface WalletState {
  version: 1;
  revision: number;
  pockets: WalletPocket[];
}

export interface WalletBalanceView {
  unit: string;
  amount: string;
  mintCount: number;
  proofCount: number;
}

export interface WalletPocketView {
  mintUrl: string;
  unit: string;
  amount: string;
  proofCount: number;
  denominations: string[];
  keysetIds: string[];
}

export interface WalletView {
  revision: number;
  balances: WalletBalanceView[];
  pockets: WalletPocketView[];
}

export function createEmptyWallet(): WalletState {
  return { version: 1, revision: 0, pockets: [] };
}

export function normalizeMintUrl(mintUrl: string): string {
  const url = new URL(mintUrl.trim());
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("Mint URL must use HTTPS");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function asPositiveAmount(amount: string): bigint {
  if (!/^[1-9]\d*$/.test(amount)) {
    throw new Error("Proof amount must be a canonical positive integer string");
  }
  return BigInt(amount);
}

function validateProof(proof: StoredProof): void {
  asPositiveAmount(proof.amount);
  if (!proof.id || !proof.secret || !proof.C) {
    throw new Error("Proof is missing bearer-token fields");
  }
}

export function addProofs(
  state: WalletState,
  input: WalletPocket
): WalletState {
  const mintUrl = normalizeMintUrl(input.mintUrl);
  const unit = input.unit.trim().toLowerCase();
  if (!unit) {
    throw new Error("Cashu unit is required");
  }

  input.proofs.forEach(validateProof);
  const pocketIndex = state.pockets.findIndex(
    (pocket) => pocket.mintUrl === mintUrl && pocket.unit === unit
  );
  const currentProofs = pocketIndex >= 0
    ? state.pockets[pocketIndex]?.proofs ?? []
    : [];
  const seen = new Set(currentProofs.map((item) => item.secret));
  const additions = input.proofs.filter((item) => {
    if (seen.has(item.secret)) return false;
    seen.add(item.secret);
    return true;
  });

  if (additions.length === 0) return state;

  const nextPocket: WalletPocket = {
    mintUrl,
    unit,
    proofs: [...currentProofs, ...additions]
  };
  const pockets = [...state.pockets];
  if (pocketIndex >= 0) pockets[pocketIndex] = nextPocket;
  else pockets.push(nextPocket);

  return {
    version: 1,
    revision: state.revision + 1,
    pockets
  };
}

function sumProofs(proofs: StoredProof[]): string {
  return proofs
    .reduce((sum, proof) => sum + asPositiveAmount(proof.amount), 0n)
    .toString();
}

export function getWalletView(state: WalletState): WalletView {
  const pockets = state.pockets
    .map<WalletPocketView>((pocket) => ({
      mintUrl: pocket.mintUrl,
      unit: pocket.unit,
      amount: sumProofs(pocket.proofs),
      proofCount: pocket.proofs.length,
      denominations: pocket.proofs
        .map((proof) => proof.amount)
        .sort((a, b) => {
          const left = BigInt(a);
          const right = BigInt(b);
          return left < right ? -1 : left > right ? 1 : 0;
        }),
      keysetIds: [...new Set(pocket.proofs.map((proof) => proof.id))].sort()
    }))
    .sort((a, b) =>
      a.mintUrl.localeCompare(b.mintUrl) || a.unit.localeCompare(b.unit)
    );

  const grouped = new Map<
    string,
    Omit<WalletBalanceView, "amount"> & { amount: bigint; mints: Set<string> }
  >();
  for (const pocket of pockets) {
    const balance = grouped.get(pocket.unit) ?? {
      unit: pocket.unit,
      amount: 0n,
      mintCount: 0,
      proofCount: 0,
      mints: new Set<string>()
    };
    balance.amount += BigInt(pocket.amount);
    balance.proofCount += pocket.proofCount;
    balance.mints.add(pocket.mintUrl);
    balance.mintCount = balance.mints.size;
    grouped.set(pocket.unit, balance);
  }

  const balances = [...grouped.values()]
    .map(({ mints: _mints, amount, ...balance }) => ({
      ...balance,
      amount: amount.toString()
    }))
    .sort((a, b) => a.unit.localeCompare(b.unit));

  return { revision: state.revision, balances, pockets };
}
