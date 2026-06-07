import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'url';
import * as path from 'path';

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

const client = new openclaudeProto(
  'localhost:50051',
  grpc.credentials.createInsecure()
);

async function runTest() {
  console.log('Starting gRPC bypass permissions test...');
  const chatStream = client.sessionChat();

  chatStream.on('data', (response: any) => {
    console.log('Raw Response:', JSON.stringify(response, null, 2));
    if (response.session_started) {
      console.log(`[Client] Session started: ${response.session_started.session_id}`);
      // Send user prompt after session starts
      console.log('[Client] Sending prompt: "get list of all files in current directory."');
      chatStream.write({
        user_prompt: {
          prompt: 'get list of all files in current directory.'
        }
      });
    } else if (response.agent_message) {
      const msg = JSON.parse(response.agent_message.sdk_message_json);
      handleAgentMessage(msg);
    } else if (response.permission_request) {
      console.log(`\n❌ ERROR: Received permission request for tool ${response.permission_request.tool_name} (it should have been auto-accepted by the server)`);
      chatStream.end();
      process.exit(1);
    } else if (response.finished) {
      console.log(`\n\n[Client] Finished: ${response.finished.summary}`);
      chatStream.end();
      process.exit(0);
    } else if (response.error) {
      console.error(`\n[Client Error]: ${response.error.message}`);
      chatStream.end();
      process.exit(1);
    }
  });

  chatStream.on('error', (err: any) => {
    console.error('Stream error:', err.message || err);
    process.exit(1);
  });

  // Start session with bypass permissions
  chatStream.write({
    start_session: {
      cwd: '/Users/jatinbalodhi/Developer/work/openclaude-grpc',
      permission_mode: 'bypassPermissions',
      allow_dangerously_skip_permissions: true
    }
  });
}

function handleAgentMessage(msg: any) {
  if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
    for (const item of msg.message.content) {
      if (item.type === 'text') {
        process.stdout.write(item.text);
      } else if (item.type === 'tool_use') {
        console.log(`\n[Agent Tool Use]: ${item.name} (${JSON.stringify(item.input)})`);
      }
    }
  } else if (msg.type === 'system' && msg.subtype === 'local_command_output') {
    console.log(`\n[Command Output]:\n${msg.content}`);
  } else if (msg.type === 'tool_progress') {
    process.stdout.write('.');
  }
}

runTest();
