import { createPublicClient, http, type Abi } from 'viem';
import { sepolia } from 'viem/chains';
import abiJson from './heartbeatAVSAbi.json' assert { type: 'json' };
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const abi = abiJson as Abi;

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS as `0x${string}`;
const ANVIL_RPC_URL = process.env.ANVIL_RPC_URL!;
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID!;
const OPERATOR_ADDRESS = process.env.OPERATOR_ADDRESS as `0x${string}`;
const PING_INTERVAL = 30; // seconds

const client = createPublicClient({
  chain: sepolia,
  transport: http(ANVIL_RPC_URL),
});

console.log("Using operator address:", OPERATOR_ADDRESS);

async function getLastPing(): Promise<bigint> {
  return await client.readContract({
    address: CONTRACT_ADDRESS,
    abi,
    functionName: 'getLastPing',
    args: [OPERATOR_ADDRESS],
  }) as bigint;
}

async function sendTelegramAlert(message: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
    }),
  });
}

async function checkPing() {
  try {
    const lastPing = await getLastPing();
    const block = await client.getBlock();
    const now = Number(block.timestamp);

    const secondsSinceLastPing = now - Number(lastPing);

    if (secondsSinceLastPing > PING_INTERVAL + 5) {
      console.log(`Missed ping! It's been ${secondsSinceLastPing}s`);
      await sendTelegramAlert(`⚠️ Operator missed ping! Last ping was ${secondsSinceLastPing}s ago.`);
    } else {
      console.log(`✅ Ping OK. Last ping was ${secondsSinceLastPing}s ago.`);
    }
  } catch (err) {
    console.error('Error checking ping:', err);
  }
}

setInterval(checkPing, 20_000); // check every 10 seconds
