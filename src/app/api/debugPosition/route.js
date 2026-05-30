import { ethers } from "ethers";
import { neon }   from "@neondatabase/serverless";
import { POOL_ADDRESS as POOL } from "../../lib/config";

export const runtime = "nodejs";

const sql = neon(process.env.DATABASE_URL);

const NFPM    = "0x827922686190790b37229fd06084350E74485b72";
const VOTER   = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";

// EIP-1967 proxy storage slots
const IMPL_SLOT   = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ADMIN_SLOT  = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const RPC_URLS = [
  process.env.ALCHEMY_RPC_URL,
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
].filter(Boolean);

const NFPM_IFACE = new ethers.Interface([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
]);

const GAUGE_IFACE = new ethers.Interface([
  "function stakedValues(address depositor) view returns (uint256[])",
  "function depositor(uint256 tokenId) view returns (address)",
  "function stakedContains(address depositor, uint256 tokenId) view returns (bool)",
  "function withdraw(uint256 tokenId)",
  "function getReward(uint256 tokenId)",
]);

const VOTER_IFACE = new ethers.Interface([
  "function gauges(address pool) view returns (address)",
  "function isAlive(address gauge) view returns (bool)",
  "function factory() view returns (address)",
  "function gaugeFactory() view returns (address)",
]);

async function rpcFetch(method, params) {
  for (const url of RPC_URLS) {
    try {
      const res  = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(6000),
      });
      const json = await res.json();
      if (json.result !== undefined) return json.result;
    } catch (_) {}
  }
  return null;
}

async function ethCall(to, data, from = "0x0000000000000000000000000000000000000000") {
  for (const url of RPC_URLS) {
    try {
      const res  = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data, from }, "latest"] }),
        signal: AbortSignal.timeout(6000),
      });
      const json = await res.json();
      if (json.result && json.result !== "0x") return { result: json.result };
      if (json.error) return { error: json.error.message ?? JSON.stringify(json.error) };
      return { result: "0x" };
    } catch (_) {}
  }
  return { error: "all RPCs failed" };
}

async function tryCall(to, iface, fn, args = []) {
  try {
    const r = await ethCall(to, iface.encodeFunctionData(fn, args));
    if (r.error) return { ok: false, error: r.error };
    if (!r.result || r.result === "0x") return { ok: false, error: "empty result" };
    const decoded = iface.decodeFunctionResult(fn, r.result);
    return { ok: true, value: decoded.length === 1 ? decoded[0] : decoded };
  } catch (e) {
    return { ok: false, error: e.message ?? String(e) };
  }
}

// Tente un appel brut avec un sélecteur de fonction — retourne le revert reason si la fonction existe
async function probeSelector(to, selector, args = "", walletAddr) {
  const data = selector + args;
  const r    = await ethCall(to, data, walletAddr);
  if (r.result && r.result !== "0x") return { exists: true, result: r.result };
  if (r.error) {
    // Si l'erreur contient un message décodable → la fonction existe mais accès refusé
    const msg = r.error ?? "";
    if (msg.includes("execution reverted") || msg.includes("revert")) {
      // Essayer de décoder le revert reason
      try {
        const revertData = r.error.match(/0x[0-9a-f]+/i)?.[0];
        if (revertData && revertData.startsWith("0x08c379a0")) {
          const reason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + revertData.slice(10))[0];
          return { exists: true, revertReason: reason };
        }
      } catch (_) {}
      return { exists: "maybe", revertRaw: msg.slice(0, 200) };
    }
    return { exists: false, error: msg.slice(0, 100) };
  }
  return { exists: false };
}

export async function GET(req) {
  const params  = new URL(req.url).searchParams;
  const poolNum = parseInt(params.get("poolNum") ?? "2");

  const privateKey = poolNum === 3 ? process.env.PRIVATE_KEY_3 : process.env.PRIVATE_KEY;
  if (!privateKey) return Response.json({ error: `PRIVATE_KEY${poolNum === 3 ? "_3" : ""} manquant` }, { status: 500 });

  const walletAddr = new ethers.Wallet(privateKey).address;

  // tokenId — depuis l'URL (?tokenId=...) ou depuis la DB
  let tokenId = null;
  let tokenIdStr = null;
  const tokenIdParam = params.get("tokenId");
  if (tokenIdParam) {
    tokenIdStr = tokenIdParam;
    tokenId    = BigInt(tokenIdParam);
  } else {
    try {
      const rows = await sql`
        SELECT token_id FROM lp_events
        WHERE action1 = 'CREATE_OK' AND action2 IS NULL AND token_id IS NOT NULL
          AND COALESCE(pool_num, 2) = ${poolNum}
        ORDER BY id DESC LIMIT 1
      `;
      if (rows[0]?.token_id) {
        tokenId    = BigInt(rows[0].token_id);
        tokenIdStr = rows[0].token_id;
      }
    } catch (e) {
      return Response.json({ error: `DB: ${e.message}` }, { status: 500 });
    }
    if (!tokenId) return Response.json({ error: "Aucun tokenId en DB (CREATE_OK sans CLOSE_OK)" }, { status: 404 });
  }

  // Gauge depuis voter
  const gaugeResult = await tryCall(VOTER, VOTER_IFACE, "gauges", [POOL]);
  const gaugeAddr   = gaugeResult.ok ? gaugeResult.value : null;
  if (!gaugeAddr) return Response.json({ error: `Gauge introuvable: ${gaugeResult.error}` }, { status: 500 });

  // tokenId ABI-encodé (padded 32 bytes) pour les probes de sélecteur
  const tokenIdPadded = tokenId.toString(16).padStart(64, "0");
  const walletPadded  = walletAddr.slice(2).toLowerCase().padStart(64, "0");
  const nfpmPadded    = NFPM.slice(2).toLowerCase().padStart(64, "0");

  // Appels parallèles — état de base
  const [
    isAliveResult,
    ownerOfResult,
    getApprovedResult,
    stakedByWalletResult,
    stakedByNfpmResult,
    stakedContainsWalletResult,
    depositorResult,
  ] = await Promise.all([
    tryCall(VOTER,     VOTER_IFACE, "isAlive",       [gaugeAddr]),
    tryCall(NFPM,      NFPM_IFACE,  "ownerOf",        [tokenId]),
    tryCall(NFPM,      NFPM_IFACE,  "getApproved",    [tokenId]),
    tryCall(gaugeAddr, GAUGE_IFACE, "stakedValues",   [walletAddr]),
    tryCall(gaugeAddr, GAUGE_IFACE, "stakedValues",   [NFPM]),        // NFPM comme déposant ?
    tryCall(gaugeAddr, GAUGE_IFACE, "stakedContains", [walletAddr, tokenId]),
    tryCall(gaugeAddr, GAUGE_IFACE, "depositor",      [tokenId]),
  ]);

  // Vérifications proxy (parallèles)
  const [implSlot, beaconSlot, adminSlot, bytecode] = await Promise.all([
    rpcFetch("eth_getStorageAt", [gaugeAddr, IMPL_SLOT, "latest"]),
    rpcFetch("eth_getStorageAt", [gaugeAddr, BEACON_SLOT, "latest"]),
    rpcFetch("eth_getStorageAt", [gaugeAddr, ADMIN_SLOT, "latest"]),
    rpcFetch("eth_getCode",      [gaugeAddr, "latest"]),
  ]);

  const implAddr    = implSlot   && implSlot   !== "0x" + "0".repeat(64) ? "0x" + implSlot.slice(-40)   : null;
  const beaconAddr  = beaconSlot && beaconSlot !== "0x" + "0".repeat(64) ? "0x" + beaconSlot.slice(-40) : null;
  const adminAddr   = adminSlot  && adminSlot  !== "0x" + "0".repeat(64) ? "0x" + adminSlot.slice(-40)  : null;
  const isEip1167   = bytecode?.startsWith("0x363d3d373d3d3d363d73") ?? false;
  const cloneImpl   = isEip1167 ? "0x" + bytecode.slice(22, 62) : null;

  // owner() → 0x8da5cb5b
  // factory() → 0xc45a0155
  // team() → 0x85f2aef2 (Velodrome/Aerodrome specific)
  // emergencyCouncil() → 0x4bf5d1c5
  const [ownerProbe, factoryProbe, teamProbe, emergencyCouncilProbe] = await Promise.all([
    probeSelector(gaugeAddr, "0x8da5cb5b", "", walletAddr),
    probeSelector(gaugeAddr, "0xc45a0155", "", walletAddr),
    probeSelector(gaugeAddr, "0x85f2aef2", "", walletAddr),
    probeSelector(gaugeAddr, "0x4bf5d1c5", "", walletAddr),
  ]);

  // Simulation withdraw(tokenId) depuis walletAddr → donne le vrai revert reason
  const withdrawSimResult = await (async () => {
    const data = GAUGE_IFACE.encodeFunctionData("withdraw", [tokenId]);
    const r    = await ethCall(gaugeAddr, data, walletAddr);
    if (r.result && r.result !== "0x") return { ok: true };
    if (r.error) {
      const msg = r.error ?? "";
      // Essayer de décoder le revert reason standard (Error(string) = 0x08c379a0)
      try {
        const hex = msg.match(/0x[0-9a-fA-F]+/)?.[0] ?? "";
        if (hex.startsWith("0x08c379a0")) {
          const reason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + hex.slice(10))[0];
          return { reverts: true, reason };
        }
        // Custom error — retourner le selector brut (4 bytes)
        if (hex.length >= 10) {
          const selector = hex.slice(0, 10);
          // Vérifier selectors connus
          const known = {
            [ethers.id("NotAuthorized()").slice(0, 10)]: "NotAuthorized()",
            [ethers.id("NA()").slice(0, 10)]: "NA()",
          };
          return { reverts: true, customError: known[selector] ?? `unknown selector ${selector}`, rawHex: hex.slice(0, 18) };
        }
      } catch (_) {}
      return { reverts: true, rawError: msg.slice(0, 300) };
    }
    return { reverts: true, rawError: "empty revert (no data)" };
  })();

  // Simulation getReward(tokenId) depuis walletAddr
  const getRewardSimResult = await (async () => {
    const data = GAUGE_IFACE.encodeFunctionData("getReward", [tokenId]);
    const r    = await ethCall(gaugeAddr, data, walletAddr);
    if (r.result !== undefined && !r.error) return { ok: true };
    if (r.error) {
      const msg = r.error ?? "";
      try {
        const hex = msg.match(/0x[0-9a-fA-F]+/)?.[0] ?? "";
        if (hex.startsWith("0x08c379a0")) {
          const reason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + hex.slice(10))[0];
          return { reverts: true, reason };
        }
        if (hex.length >= 10) {
          const selector = hex.slice(0, 10);
          const known = {
            [ethers.id("NotAuthorized()").slice(0, 10)]: "NotAuthorized()",
          };
          return { reverts: true, customError: known[selector] ?? `unknown selector ${selector}` };
        }
      } catch (_) {}
      return { reverts: true, rawError: msg.slice(0, 200) };
    }
    return { ok: true };
  })();

  // Fonctions de rescue potentielles
  // emergencyWithdraw(uint256) → 0x853828b6 (Uniswap-style)
  // recoverERC721(address,uint256,address) → calculé
  // sweep(address,address,uint256) → 0xe2bbb158? non, variable
  // withdrawToken(address,uint256,address) → variable
  const [
    emergencyWithdrawProbe,
    rescueProbe,
    sweepProbe,
  ] = await Promise.all([
    // emergencyWithdraw(uint256)
    probeSelector(gaugeAddr, "0x853828b6", tokenIdPadded, walletAddr),
    // recoverERC721(address nft, uint256 tokenId, address to)
    probeSelector(gaugeAddr, "0x" + ethers.id("recoverERC721(address,uint256,address)").slice(2, 10),
      nfpmPadded + tokenIdPadded + walletPadded, walletAddr),
    // sweep(address token, uint256 tokenId, address to)
    probeSelector(gaugeAddr, "0x" + ethers.id("sweep(address,uint256,address)").slice(2, 10),
      nfpmPadded + tokenIdPadded + walletPadded, walletAddr),
  ]);

  // Lire l'adresse retournée par owner/factory si elle existe
  let gaugeOwner   = null;
  let gaugeFactory = null;
  if (ownerProbe.exists === true && ownerProbe.result) {
    try { gaugeOwner = "0x" + ownerProbe.result.slice(-40); } catch (_) {}
  }
  if (factoryProbe.exists === true && factoryProbe.result) {
    try { gaugeFactory = "0x" + factoryProbe.result.slice(-40); } catch (_) {}
  }

  return Response.json({
    poolNum,
    walletAddr,
    tokenId: tokenIdStr,
    gauge:   gaugeAddr,

    // État NFT
    nft: {
      owner:    ownerOfResult.ok    ? ownerOfResult.value    : `ERROR: ${ownerOfResult.error}`,
      approved: getApprovedResult.ok ? getApprovedResult.value : `ERROR: ${getApprovedResult.error}`,
    },

    // État gauge
    gaugeState: {
      isAlive:              isAliveResult.ok ? isAliveResult.value : `ERROR: ${isAliveResult.error}`,
      stakedByWallet:       stakedByWalletResult.ok  ? stakedByWalletResult.value.map(String)  : `ERROR: ${stakedByWalletResult.error}`,
      stakedByNFPM:         stakedByNfpmResult.ok    ? stakedByNfpmResult.value.map(String)    : `ERROR: ${stakedByNfpmResult.error}`,
      stakedContainsWallet: stakedContainsWalletResult.ok ? stakedContainsWalletResult.value : `ERROR: ${stakedContainsWalletResult.error}`,
      depositor:            depositorResult.ok ? depositorResult.value : `ERROR: ${depositorResult.error}`,
    },

    // Proxy / upgradeabilité
    proxy: {
      isEip1167Clone:    isEip1167,
      cloneImplementation: cloneImpl,
      eip1967Implementation: implAddr,
      eip1967Beacon:     beaconAddr,
      eip1967Admin:      adminAddr,
      isUpgradeable:     !!(implAddr || beaconAddr),
    },

    // Admin / propriétaire du gauge
    admin: {
      owner:           gaugeOwner,
      factory:         gaugeFactory,
      ownerExists:     ownerProbe.exists,
      factoryExists:   factoryProbe.exists,
      teamExists:      teamProbe.exists,
      emergencyCouncilExists: emergencyCouncilProbe.exists,
    },

    // Simulation des appels withdraw/getReward (eth_call — aucune tx envoyée)
    simulation: {
      withdraw:   withdrawSimResult,
      getReward:  getRewardSimResult,
    },

    // Fonctions de rescue potentielles
    rescueFunctions: {
      emergencyWithdraw: emergencyWithdrawProbe,
      recoverERC721:     rescueProbe,
      sweep:             sweepProbe,
    },
  });
}
