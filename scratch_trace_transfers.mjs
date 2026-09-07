const RPC = 'https://mainnet.base.org';
const WALLET = '0xd54866e9be1e72cf7ca422e13892565406957ad4';
const WALLET_PADDED = '0x000000000000000000000000' + WALLET.slice(2);
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TOKENS = {
  WETH: '0x4200000000000000000000000000000000000006',
  USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
};
const DECIMALS = { WETH: 18, USDC: 6 };

const FROM_BLOCK = 49506126;
const TO_BLOCK   = 49765326;
const CHUNK = 9999;

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

async function getLogsChunked(address, topics) {
  const all = [];
  for (let start = FROM_BLOCK; start <= TO_BLOCK; start += CHUNK + 1) {
    const end = Math.min(start + CHUNK, TO_BLOCK);
    const logs = await rpc('eth_getLogs', [{
      fromBlock: '0x' + start.toString(16),
      toBlock:   '0x' + end.toString(16),
      address, topics,
    }]);
    all.push(...logs);
  }
  return all;
}

for (const [name, addr] of Object.entries(TOKENS)) {
  const outLogs = await getLogsChunked(addr, [TRANSFER_TOPIC, WALLET_PADDED]);
  const inLogs  = await getLogsChunked(addr, [TRANSFER_TOPIC, null, WALLET_PADDED]);

  console.log(`\n=== ${name} — sorties (${outLogs.length}) ===`);
  for (const log of outLogs) {
    const amount = Number(BigInt(log.data)) / 10 ** DECIMALS[name];
    const to = '0x' + log.topics[2].slice(26);
    const block = await rpc('eth_getBlockByNumber', ['0x' + log.blockNumber.slice(2), false]).catch(() => null);
    const ts = block ? new Date(parseInt(block.timestamp, 16) * 1000).toISOString() : '?';
    console.log(`  ${ts} block=${parseInt(log.blockNumber,16)} amount=${amount.toFixed(6)} to=${to} tx=${log.transactionHash}`);
  }

  console.log(`\n=== ${name} — entrées (${inLogs.length}) ===`);
  for (const log of inLogs) {
    const amount = Number(BigInt(log.data)) / 10 ** DECIMALS[name];
    const from = '0x' + log.topics[1].slice(26);
    const block = await rpc('eth_getBlockByNumber', ['0x' + log.blockNumber.slice(2), false]).catch(() => null);
    const ts = block ? new Date(parseInt(block.timestamp, 16) * 1000).toISOString() : '?';
    console.log(`  ${ts} block=${parseInt(log.blockNumber,16)} amount=${amount.toFixed(6)} from=${from} tx=${log.transactionHash}`);
  }
}
