import { ethers } from "ethers";

export const runtime = "nodejs";

const ARBITRUM_RPCS = [
  "https://arb1.arbitrum.io/rpc",
  "https://arbitrum.drpc.org",
  "https://arbitrum-one.publicnode.com",
].filter(Boolean);

const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ERC20_ABI = ["function balanceOf(address) view returns(uint256)"];

export async function GET() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) return Response.json({ error: "PRIVATE_KEY manquant" }, { status: 500 });

  let address;
  try {
    address = new ethers.Wallet(privateKey.trim()).address;
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }

  for (const url of ARBITRUM_RPCS) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      const usdc     = new ethers.Contract(USDC_ARB, ERC20_ABI, provider);
      const balance  = await usdc.balanceOf(address);
      return Response.json({ balance: (Number(balance) / 1e6).toFixed(2), address });
    } catch (_) {}
  }

  return Response.json({ error: "RPCs Arbitrum indisponibles" }, { status: 503 });
}
