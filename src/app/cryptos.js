export const cryptosSet1 = [
  { crypto: "bitcoin", symbol: "BTC", montant: 0.01095294, investi: 1000 },
  { crypto: "ethereum", symbol: "ETH", montant: 0.74730703, investi: 2000 },
  { crypto: "usd-coin", symbol: "USDC", montant: 2750, investi: 0 },
  { crypto: "chainlink", symbol: "LINK", montant: 89.10561383, investi: 1500 },
  { crypto: "aave", symbol: "AAVE", montant: 6.25493528, investi: 1000 },
  { crypto: "yearn-finance", symbol: "YFI", montant: 0.16498436, investi: 1000 },
  { crypto: "injective-protocol", symbol: "INJ", montant: 116.73430108, investi: 2000 },
  { crypto: "pendle", symbol: "PENDLE", montant: 222.90514024, investi: 1000 },
  { crypto: "render-token", symbol: "RNDR", montant: 226.08495259, investi: 1000 },
  { crypto: "blockstack", symbol: "STX", montant: 746.99357, investi: 500 },
  { crypto: "fetch-ai", symbol: "FET", montant: 1539.37313712, investi: 1500 },
  { crypto: "bittensor", symbol: "TAO", montant: 10.21288743, investi: 3000 },
  { crypto: "reserve-rights-token", symbol: "RSR", montant: 392530.6252, investi: 3000 },    // RSR
  { crypto: "syrup", symbol: "SYRUP", montant: 2356.16, investi: 1000 },           // SYRUP (vérifier nom exact)
  { crypto: "akash-network", symbol: "AKT", montant: 814.22656, investi: 1500 },     // AKT
  { crypto: "nervos-network", symbol: "CKB", montant: 182658.32731328, investi: 1000 },    // CKB
  { crypto: "gamercoin", symbol: "GHX", montant: 5282.63, investi: 500 },          // GHX (à vérifier)
  { crypto: "aerodrome-finance", symbol: "AERO", montant: 1247.21443, investi: 1000},
  { crypto: "kaspa", symbol: "KAS", montant: 11150.838, investi: 1000 },
  { crypto: "io", symbol: "IO", montant: 1479.14765937, investi: 1000 },
  { crypto: "alephium", symbol: "ALPH", montant: 3583.61221, investi: 1000 },
  { crypto: "coredaoorg", symbol: "CORE", montant: 1866.56067, investi: 1000 },
  { crypto: "ankr", symbol: "ANKR", montant: 29623.6593873, investi: 500 },
  { crypto: "qubic-network", symbol: "QUBIC", montant: 482537356.46745, investi: 1000 },
  { crypto: "nosana", symbol: "NOS", montant: 1841.28, investi: 1000 },
  { crypto: "trakxMemes", symbol: "TRAKX-MEMES", montant: 4.03, investi: 1000 },
  { crypto: "trakxGaming", symbol: "TRAKX-GAMING", montant: 13.27, investi: 500 },
  { crypto: "defit", symbol: "DEFIT", montant: 4500, investi: 0 },
  { crypto: "jito-governance-token", symbol: "JTO", montant: 520.46, investi: 1000 },
  { crypto: "ondo-finance", symbol: "ONDO", montant: 968.97792815, investi: 1000 },
];

export const cryptosSet2 = [
  { crypto: "bitcoin", symbol: "BTC", montant: 0.00187141, investi: 200 },
  { crypto: "ethereum", symbol: "ETH", montant: 0.04324785, investi: 100 },
];

export function getCryptos(param) {
  if (param === "set1") {
    return cryptosSet1;
  } else if (param === "set2") {
    return cryptosSet2;
  }
  return []; // default empty array if no match
}
