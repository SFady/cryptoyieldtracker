import { ethers } from "ethers";
import { scryptSync, createDecipheriv } from "crypto";

export const runtime     = "nodejs";
export const maxDuration = 60;

function decryptKey(passphrase) {
  const enc  = process.env.PRIVATE_KEY_ENC;
  const iv   = process.env.PRIVATE_KEY_IV;
  const salt = process.env.PRIVATE_KEY_SALT;
  if (!enc || !iv || !salt) throw new Error("PRIVATE_KEY_ENC / IV / SALT manquants dans .env.local");
  const key      = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv("aes-256-cbc", key, Buffer.from(iv, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(enc, "hex")),
    decipher.final(),
  ]).toString();
}

const NFPM  = "0x827922686190790b37229fd06084350E74485b72";
const WETH  = "0x4200000000000000000000000000000000000006";
const USDC  = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const POOL  = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
const VOTER = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";

const RPC_URLS = [
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
];

const ERC20_IFACE = new ethers.Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const NFPM_IFACE = new ethers.Interface([
  "function mint((address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline, uint160 sqrtPriceX96) params) returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function approve(address to, uint256 tokenId)",
]);

const GAUGE_IFACE = new ethers.Interface([
  "function deposit(uint256 tokenId)",
]);

const VOTER_IFACE = new ethers.Interface([
  "function gauges(address pool) view returns (address)",
]);

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function priceToTick(price) {
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

function roundTick(tick, spacing) {
  return Math.round(tick / spacing) * spacing;
}

async function pickRpc() {
  for (const url of RPC_URLS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(3000),
      });
      const j = await r.json();
      if (j.result) return url;
    } catch {}
  }
  return RPC_URLS[0];
}

export async function POST(req) {
  const { amountUSDC, minPrice, maxPrice, currentPrice, passphrase } = await req.json();
  if (!amountUSDC || !minPrice || !maxPrice || !currentPrice)
    return Response.json({ error: "Paramètres manquants" }, { status: 400 });
  if (!passphrase)
    return Response.json({ error: "Passphrase requise" }, { status: 400 });

  try {
    const privateKey = decryptKey(passphrase);

    const rpcUrl   = await pickRpc();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(privateKey, provider);

    // 1. tickSpacing du pool
    const tsRaw = await provider.call({ to: POOL, data: "0xd0c93a7c" });
    const tickSpacing = Number(ethers.toBigInt(tsRaw));

    // 2. Ticks arrondis
    const tickLower = roundTick(priceToTick(minPrice),    tickSpacing);
    const tickUpper = roundTick(priceToTick(maxPrice),    tickSpacing);

    // 3. Adresse du gauge via Voter
    const gaugeResult = await provider.call({
      to: VOTER,
      data: VOTER_IFACE.encodeFunctionData("gauges", [POOL]),
    });
    const [gaugeAddr] = ethers.AbiCoder.defaultAbiCoder().decode(["address"], gaugeResult);
    if (!gaugeAddr || gaugeAddr === ethers.ZeroAddress)
      return Response.json({ error: "Gauge introuvable pour ce pool" }, { status: 500 });

    // 4. Montants (USDC exact + WETH calculé avec buffer 5%)
    const usdcAmount = ethers.parseUnits(String(amountUSDC), 6);
    const wethAmount = ethers.parseEther(String((amountUSDC / currentPrice) * 1.05));
    const MAX_UINT   = ethers.MaxUint256;

    // 5. Approve WETH → NFPM
    const tx1 = await wallet.sendTransaction({
      to: WETH,
      data: ERC20_IFACE.encodeFunctionData("approve", [NFPM, MAX_UINT]),
    });
    await tx1.wait();

    // 6. Approve USDC → NFPM
    const tx2 = await wallet.sendTransaction({
      to: USDC,
      data: ERC20_IFACE.encodeFunctionData("approve", [NFPM, MAX_UINT]),
    });
    await tx2.wait();

    // 7. Mint position
    const deadline  = Math.floor(Date.now() / 1000) + 300;
    const mintTx = await wallet.sendTransaction({
      to: NFPM,
      data: NFPM_IFACE.encodeFunctionData("mint", [{
        token0:          WETH,
        token1:          USDC,
        tickSpacing,
        tickLower,
        tickUpper,
        amount0Desired:  wethAmount,
        amount1Desired:  usdcAmount,
        amount0Min:      0n,
        amount1Min:      0n,
        recipient:       wallet.address,
        deadline,
        sqrtPriceX96:    0n,
      }]),
    });
    const mintReceipt = await mintTx.wait();

    // 8. Extraire le tokenId depuis l'événement Transfer(0x0 → wallet)
    const transferLog = mintReceipt.logs.find(l =>
      l.address.toLowerCase() === NFPM.toLowerCase() &&
      l.topics[0] === TRANSFER_TOPIC &&
      l.topics[1] === "0x0000000000000000000000000000000000000000000000000000000000000000"
    );
    if (!transferLog) return Response.json({ error: "tokenId introuvable dans le reçu du mint" }, { status: 500 });
    const tokenId = ethers.toBigInt(transferLog.topics[3]);

    // 9. Approve NFT → Gauge
    const tx4 = await wallet.sendTransaction({
      to: NFPM,
      data: NFPM_IFACE.encodeFunctionData("approve", [gaugeAddr, tokenId]),
    });
    await tx4.wait();

    // 10. Dépôt dans le gauge
    const tx5 = await wallet.sendTransaction({
      to: gaugeAddr,
      data: GAUGE_IFACE.encodeFunctionData("deposit", [tokenId]),
    });
    await tx5.wait();

    return Response.json({
      message: `Position #${tokenId} créée et stakée — range $${minPrice}→$${maxPrice}`,
      tokenId: tokenId.toString(),
      txMint:  mintTx.hash,
      txGauge: tx5.hash,
    });

  } catch (e) {
    return Response.json({ error: e.shortMessage ?? e.message }, { status: 500 });
  }
}
