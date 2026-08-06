export const POOL_ADDRESS   = process.env.POOL_ADDRESS   ?? "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
export const POOL_ADDRESS_2 = process.env.POOL_ADDRESS_2 ?? "0x3fe04a59ebd38cf06080a6f60a98d124eb59392a";
export function getPoolAddress(poolNum) {
  return poolNum === 2 ? POOL_ADDRESS_2 : POOL_ADDRESS;
}
