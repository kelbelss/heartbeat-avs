import 'dotenv/config';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import heartbeatAVSAbi from './heartbeatAVSAbi.json' assert { type: 'json' };
import OpenAI from 'openai';


const contractAddress = process.env.CONTRACT_ADDRESS!;
const rpcUrl = process.env.ANVIL_RPC_URL!;
const privateKey = process.env.PRIVATE_KEY!;

const account = privateKeyToAccount(`0x${privateKey}` as `0x${string}`);

const client = createWalletClient({
  account,
  chain: {
    id: 31337,
    name: 'anvil',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  },
  transport: http(),
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function generateStatusMessage(): Promise<string> {
  const chat = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      {
        role: 'system',
        content: 'You are a polite and concise status reporter for a blockchain operator. Keep messages short (max 20 words).',
      },
      {
        role: 'user',
        content: 'Generate a new system status update.',
      },
    ],
  });

  return chat.choices[0].message.content || 'All systems operational.';
}

async function pingHeartbeat() {
  const statusMessage = await generateStatusMessage();

  const tx = await client.writeContract({
    address: contractAddress as `0x${string}`,
    abi: heartbeatAVSAbi,
    functionName: 'ping',
    args: [statusMessage],
  });

  console.log(`[Ping] ${new Date().toISOString()} - "${statusMessage}" - Tx: ${tx}`);
}

// setInterval(pingHeartbeat, 30_000);
// pingHeartbeat();
