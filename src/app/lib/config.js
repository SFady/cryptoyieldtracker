export const POOL_ADDRESS   = process.env.POOL_ADDRESS   ?? "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
// Migration Aerodrome → Aero (22/10) : nouveau pool WETH/USDC du protocole fusionné, confirmé
// on-chain (token0=WETH, token1=USDC, factory=0x9cb22058...ad07a76). L'ancien pool Aerodrome legacy
// était 0x3fe04a59ebd38cf06080a6f60a98d124eb59392a.
export const POOL_ADDRESS_2 = process.env.POOL_ADDRESS_2 ?? "0x4A7af46bC8aBc00048c6c7920a1488DAF568366c";
// Nouveau NFPM du protocole fusionné (confirmé : nfpm.factory() pointe vers la factory ci-dessus).
// Ancien NFPM Aerodrome legacy : 0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53.
export const NFPM_ADDRESS   = "0x4857Db576eE0e45F10525EC59527BFD10bEec60B";
export function getPoolAddress(poolNum) {
  return poolNum === 2 ? POOL_ADDRESS_2 : POOL_ADDRESS;
}
