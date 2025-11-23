export const cryptosSet1 = [
  { crypto: "bitcoin", symbol: "BTC", montant: 0.01648839, investi: 1500 },
  { crypto: "ethereum", symbol: "ETH", montant: 0.62456994, investi: 2500 },
  { crypto: "usd-coin", symbol: "USDC", montant: 7048.153655, investi: 0 },
  { crypto: "chainlink", symbol: "LINK", montant: 89.10561383, investi: 1500 },
  { crypto: "aave", symbol: "AAVE", montant: 6.25493528, investi: 1000 },
  { crypto: "pendle", symbol: "PENDLE", montant: 222.90514024, investi: 1000 },
  { crypto: "blockstack", symbol: "STX", montant: 1351.485032, investi: 1000 },
  { crypto: "bittensor", symbol: "TAO", montant: 10.92417543, investi: 3000 },
  { crypto: "syrup", symbol: "SYRUP", montant: 2356.16, investi: 1000 },           // SYRUP (vérifier nom exact)
  { crypto: "akash-network", symbol: "AKT", montant: 814.22656, investi: 1500 },     // AKT
  { crypto: "nervos-network", symbol: "CKB", montant: 182658.32731328, investi: 1000 },    // CKB
  { crypto: "aerodrome-finance", symbol: "AERO", montant: 1247.21443, investi: 1000},
  { crypto: "kaspa", symbol: "KAS", montant: 14958.027, investi: 1000 },
  { crypto: "defit", symbol: "DEFIT", montant: 4500, investi: 0 },
  { crypto: "ondo-finance", symbol: "ONDO", montant: 968.97792815, investi: 1000 },
  { crypto: "solana", symbol: "SOL", montant: 5.04463884, investi: 1000 },
];

export const cryptosSet2 = [
  { crypto: "bitcoin", symbol: "BTC", montant: 0.00187141, investi: 116 },
  { crypto: "ethereum", symbol: "ETH", montant: 0.02414785, investi: 116 },
  { crypto: "bittensor", symbol: "TAO", montant: 0.3, investi: 116 },
];

export function getCryptos(param) {
  if (param === "set1") {
    return cryptosSet1;
  } else if (param === "set2") {
    return cryptosSet2;
  }
  return []; // default empty array if no match
}
