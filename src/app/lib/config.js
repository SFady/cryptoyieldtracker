export const POOL_ADDRESS   = process.env.POOL_ADDRESS   ?? "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
export const POOL_ADDRESS_2 = process.env.POOL_ADDRESS_2 ?? "0x3fe04a59ebd38cf06080a6f60a98d124eb59392a";
export const NFPM_ADDRESS   = "0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53"; // Aerodrome Slipstream v2 NFPM (Base, immuable)
export function getPoolAddress(poolNum) {
  return poolNum === 2 ? POOL_ADDRESS_2 : POOL_ADDRESS;
}
