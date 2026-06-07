import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROTO_PATH = path.resolve(__dirname, '../protos/openclaude.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const openclaudeProto = (protoDescriptor.openclaude as any).OpenClaudeService;

// Create gRPC client
const client = new openclaudeProto(
  'localhost:50051',
  grpc.credentials.createInsecure()
);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query: string): Promise<string> => {
  return new Promise((resolve) => rl.question(query, resolve));
};

/**
 * Lists available sessions from the server
 */
function listSessions(): Promise<any[]> {
  return new Promise((resolve, reject) => {
    client.listSessions({}, (err: any, response: any) => {
      if (err) return reject(err);
      resolve(response.sessions || []);
    });
  });
}

/**
 * Main client loop
 */
async function main() {
  console.log('--- Connecting to OpenClaude gRPC Service ---');

  try {
    const sessions = await listSessions();
    console.log('\nAvailable Sessions:');
    if (sessions.length === 0) {
      console.log('No existing sessions found.');
    } else {
      sessions.forEach((s, i) => {
        console.log(`[${i}] ID: ${s.session_id} | Summary: "${s.summary}" | CWD: ${s.cwd}`);
      });
    }

    const choice = await askQuestion('\nType a session index to resume, or press enter to start a new session: ');
    let sessionId: string | null = null;
    if (choice.trim() !== '') {
      const idx = parseInt(choice, 10);
      if (!isNaN(idx) && idx >= 0 && idx < sessions.length) {
        sessionId = sessions[idx].session_id;
      }
    }

    // Start bidirectional stream
    const chatStream = client.sessionChat();
    let currentResolver: ((decision: string) => void) | null = null;
    let turnInProgress = false;

    // Handle responses from server
    chatStream.on('data', async (response: any) => {
      if (response.session_started) {
        console.log(`\n[Server] Session initialized: ${response.session_started.session_id}`);
        promptUser(chatStream);
      } else if (response.agent_message) {
        const sdkMsg = JSON.parse(response.agent_message.sdk_message_json);
        handleAgentMessage(sdkMsg);
      } else if (response.permission_request) {
        const req = response.permission_request;
        console.log('\n==================================================');
        console.log(`⚠️  PERMISSION REQUESTED: ${req.tool_name}`);
        console.log('--------------------------------------------------');
        console.log('Input Parameters:');
        try {
          console.log(JSON.stringify(JSON.parse(req.input_json), null, 2));
        } catch {
          console.log(req.input_json);
        }
        console.log('==================================================');

        rl.pause(); // Pause standard prompt input
        const decisionInput = await askQuestion('Approve this tool call? (y/n/cancel): ');
        rl.resume();

        let decision = 'deny';
        let message = 'User denied permission';

        if (decisionInput.toLowerCase().startsWith('y')) {
          decision = 'allow';
          message = '';
        } else if (decisionInput.toLowerCase().startsWith('c')) {
          decision = 'deny';
          message = 'User cancelled the transaction';
        }

        // Send decision back to server
        chatStream.write({
          permission_response: {
            tool_use_id: req.tool_use_id,
            decision,
            message
          }
        });
      } else if (response.finished) {
        turnInProgress = false;
        console.log(`\n\n[Agent finished]: ${response.finished.summary}`);
        promptUser(chatStream);
      } else if (response.error) {
        console.error(`\n[Server Error]: ${response.error.message}`);
        turnInProgress = false;
        promptUser(chatStream);
      }
    });

    chatStream.on('error', (err: any) => {
      console.error('\n[Stream Error]:', err.message || err);
      process.exit(1);
    });

    chatStream.on('end', () => {
      console.log('\n[Stream Ended by Server]');
      process.exit(0);
    });

    // Initialize the session configurations
    chatStream.write({
      start_session: {
        cwd: process.cwd(),
        session_id: sessionId || undefined,
        permission_mode: 'default'
      }
    });

    async function promptUser(stream: any) {
      if (turnInProgress) return;
      const prompt = await askQuestion('\nYou: ');
      if (prompt.trim().toLowerCase() === '/exit' || prompt.trim().toLowerCase() === 'exit') {
        stream.end();
        rl.close();
        process.exit(0);
      }
      turnInProgress = true;
      stream.write({
        user_prompt: {
          prompt
        }
      });
    }

  } catch (err: any) {
    console.error('Initialization error:', err);
    rl.close();
    process.exit(1);
  }
}

let lastText = '';
/**
 * Processes incoming OpenClaude SDKMessage events
 */
function handleAgentMessage(msg: any) {
  // If it's assistant content, print it
  if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
    for (const item of msg.message.content) {
      if (item.type === 'text') {
        process.stdout.write(item.text);
      } else if (item.type === 'tool_use') {
        console.log(`\n[Using Tool]: ${item.name} (${JSON.stringify(item.input)})`);
      }
    }
  } else if (msg.type === 'system') {
    if (msg.subtype === 'local_command_output') {
      console.log(`\n[Command Output]:\n${msg.content}`);
    } else if (msg.subtype === 'status' && msg.status) {
      console.log(`\n[Status]: ${msg.status}`);
    }
  } else if (msg.type === 'tool_progress') {
    // Subtle progress indicator
    process.stdout.write('.');
  }
}

main();
