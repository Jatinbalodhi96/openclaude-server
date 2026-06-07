import './env-init.js';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as fs from 'fs';

// Import the SDK using standard package exports
import {
  listSessions,
  deleteSession,
  getSessionMessages,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  SDKSession,
  SDKMessage
} from '@gitlawb/openclaude/sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the protobuf schema
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

/**
 * gRPC server implementation for hosting OpenClaude.
 */
class OpenClaudeServer {
  /**
   * RPC: ListSessions
   */
  async listSessions(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const { dir, limit, offset } = call.request;
      const sessions = await listSessions({
        dir: dir || undefined,
        limit: limit || undefined,
        offset: offset || undefined
      });

      const responseSessions = sessions.map((s: any) => ({
        session_id: s.sessionId,
        summary: s.summary || '',
        last_modified: s.lastModified ? Number(s.lastModified) : 0,
        file_size: s.fileSize ? Number(s.fileSize) : 0,
        custom_title: s.customTitle || '',
        first_prompt: s.firstPrompt || '',
        git_branch: s.gitBranch || '',
        cwd: s.cwd || '',
        tag: s.tag || '',
        created_at: s.createdAt ? Number(s.createdAt) : 0
      }));

      callback(null, { sessions: responseSessions });
    } catch (err: any) {
      console.error('ListSessions error:', err);
      callback({
        code: grpc.status.INTERNAL,
        details: err.message || 'Failed to list sessions'
      });
    }
  }

  /**
   * RPC: DeleteSession
   */
  async deleteSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const { session_id, dir } = call.request;
      if (!session_id) {
        return callback({
          code: grpc.status.INVALID_ARGUMENT,
          details: 'session_id is required'
        });
      }
      await deleteSession(session_id, { dir: dir || undefined });
      callback(null, { success: true });
    } catch (err: any) {
      console.error('DeleteSession error:', err);
      callback({
        code: grpc.status.INTERNAL,
        details: err.message || 'Failed to delete session'
      });
    }
  }

  /**
   * RPC: GetSessionMessages
   */
  async getSessionMessages(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
    try {
      const { session_id, dir, limit, offset, include_system_messages } = call.request;
      if (!session_id) {
        return callback({
          code: grpc.status.INVALID_ARGUMENT,
          details: 'session_id is required'
        });
      }
      const messages = await getSessionMessages(session_id, {
        dir: dir || undefined,
        limit: limit || undefined,
        offset: offset || undefined,
        includeSystemMessages: include_system_messages
      });

      const responseMessages = messages.map((m: any) => ({
        role: m.role || '',
        content_json: JSON.stringify(m.content),
        timestamp: m.timestamp || '',
        uuid: m.uuid || ''
      }));

      callback(null, { messages: responseMessages });
    } catch (err: any) {
      console.error('GetSessionMessages error:', err);
      callback({
        code: grpc.status.INTERNAL,
        details: err.message || 'Failed to get session messages'
      });
    }
  }

  /**
   * RPC: SessionChat (Bidirectional Stream)
   */
  sessionChat(call: grpc.ServerWritableStream<any, any>) {
    let session: SDKSession | null = null;
    let abortController = new AbortController();
    let isTerminated = false;

    // Helper to terminate and clean up resources safely
    const cleanup = () => {
      if (isTerminated) return;
      isTerminated = true;
      console.log(`Cleaning up session ${session?.sessionId || 'unknown'}`);
      try {
        abortController.abort();
      } catch (err) {
        console.error('Error aborting session controller:', err);
      }
      try {
        if (session) {
          session.close();
        }
      } catch (err) {
        console.error('Error closing session:', err);
      }
    };

    call.on('close', () => {
      cleanup();
    });

    call.on('end', () => {
      cleanup();
    });

    call.on('error', (err) => {
      console.error('Call stream error:', err);
      cleanup();
    });

    call.on('data', async (request: any) => {
      try {
        if (request.start_session) {
          if (session) {
            return call.write({
              error: { message: 'Session already started for this stream' }
            });
          }

          const startConfig = request.start_session;
          const cwd = startConfig.cwd || process.cwd();
          const model = startConfig.model || undefined;
          const permissionMode = startConfig.permission_mode || 'default';
          const incomingSessionId = startConfig.session_id || undefined;
          const fork = startConfig.fork || false;
          const allowDangerouslySkipPermissions = startConfig.allow_dangerously_skip_permissions || false;
          const disallowedTools = startConfig.disallowed_tools || undefined;
          const extraEnv = startConfig.env || {};

          // Construct SDK options
          const options: any = {
            cwd,
            model,
            permissionMode,
            allowDangerouslySkipPermissions,
            abortController,
            disallowedTools,
            env: {
              ...process.env,
              ...extraEnv
            },
            onPermissionRequest: (permissionMsg: any) => {
              if (isTerminated) return;
              console.log(`Permission requested for tool ${permissionMsg.tool_name} in session ${permissionMsg.session_id}`);

              if (permissionMode === 'bypassPermissions' || permissionMode === 'fullAccess') {
                console.log(`Auto-allowing tool ${permissionMsg.tool_name} due to mode: ${permissionMode}`);
                if (session) {
                  session.respondToPermission(permissionMsg.tool_use_id, { behavior: 'allow' });
                  return;
                }
              }

              call.write({
                permission_request: {
                  request_id: permissionMsg.request_id,
                  tool_name: permissionMsg.tool_name,
                  tool_use_id: permissionMsg.tool_use_id,
                  input_json: JSON.stringify(permissionMsg.input),
                  uuid: permissionMsg.uuid
                }
              });
            }
          };

          if (incomingSessionId) {
            console.log(`Resuming session ${incomingSessionId} (fork: ${fork})`);
            session = await unstable_v2_resumeSession(incomingSessionId, options);
          } else {
            console.log(`Creating new session in CWD: ${cwd}`);
            session = unstable_v2_createSession(options);
          }

          call.write({
            session_started: {
              session_id: session!.sessionId
            }
          });
        } else if (request.user_prompt) {
          if (!session) {
            return call.write({
              error: { message: 'Session not started yet. Send start_session message first.' }
            });
          }

          const prompt = request.user_prompt.prompt.trim();
          console.log(`User prompt: ${prompt}`);

          // Intercept slash commands
          if (prompt.startsWith('/')) {
            const cmd = prompt.split(' ')[0].toLowerCase();
            if (cmd === '/help' || cmd === '/mcp' || cmd === '/agents' || cmd === '/skills') {
              let text = '';
              if (cmd === '/help') {
                text = `**OpenClaude gRPC Hosted Service Help**\n\n` +
                  `The following slash commands are intercepted and executed directly by the server:\n` +
                  `- \`/help\` : Displays this help message.\n` +
                  `- \`/mcp\` : Displays active Model Context Protocol (MCP) server statuses.\n` +
                  `- \`/agents\` or \`/skills\` : Displays available agents/skills registered in the session.\n` +
                  `- \`/exit\` : Closes the active stream connection.\n\n` +
                  `Otherwise, you can talk to the agent normally to read/edit files, run terminal commands, and perform searches in the target workspace.`;
              } else if (cmd === '/mcp') {
                text = `**Active Model Context Protocol (MCP) Servers**\n\nNo active MCP servers configured. Add servers via the start configuration.`;
              } else {
                text = `**Available Agents & Skills**\n\n` +
                  `- \`general-purpose\` : Standard coding assistant agent.\n` +
                  `- \`verification\` : Verification, compilation, and testing agent.\n` +
                  `- \`Plan\` : Detailed planning agent.\n` +
                  `- \`Explore\` : Workspace mapping and analysis agent.`;
              }

              call.write({
                agent_message: {
                  sdk_message_json: JSON.stringify({
                    type: 'assistant',
                    message: { role: 'assistant', content: [{ type: 'text', text }] },
                    uuid: Math.random().toString(),
                    session_id: session.sessionId
                  })
                }
              });
              call.write({
                finished: {
                  summary: `Command ${cmd} completed`,
                  is_error: false
                }
              });
              return;
            }
          }

          // sendMessage returns an AsyncIterable
          const iterator = session.sendMessage(prompt);
          for await (const msg of iterator) {
            if (isTerminated) break;

            call.write({
              agent_message: {
                sdk_message_json: JSON.stringify(msg)
              }
            });
          }
          call.write({
            finished: {
              summary: 'Prompt processing completed',
              is_error: false
            }
          });
        } else if (request.permission_response) {
          if (!session) {
            return call.write({
              error: { message: 'Session not started yet.' }
            });
          }
          const resp = request.permission_response;
          const toolUseId = resp.tool_use_id;
          const decision = resp.decision; // "allow" or "deny"
          const message = resp.message;

          console.log(`Client permission response for ${toolUseId}: ${decision}`);

          const permissionResult: any = decision === 'allow'
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: message || 'Permission denied by user' };

          session.respondToPermission(toolUseId, permissionResult);
        } else if (request.interrupt) {
          if (session) {
            console.log(`Interrupting session ${session.sessionId}`);
            session.interrupt();
          }
        }
      } catch (err: any) {
        console.error('SessionChat processing error:', err);
        call.write({
          error: { message: err.message || 'Error executing stream task' }
        });
      }
    });
  }
}

/**
 * Starts the gRPC Server
 */
function startServer() {
  const server = new grpc.Server();
  const serviceImpl = new OpenClaudeServer();
  server.addService(openclaudeProto.service, {
    ListSessions: serviceImpl.listSessions.bind(serviceImpl),
    DeleteSession: serviceImpl.deleteSession.bind(serviceImpl),
    GetSessionMessages: serviceImpl.getSessionMessages.bind(serviceImpl),
    SessionChat: serviceImpl.sessionChat.bind(serviceImpl)
  });
  const port = process.env.PORT || '50051';
  const address = `0.0.0.0:${port}`;

  server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
    if (err) {
      console.error('Failed to bind server:', err);
      process.exit(1);
    }
    console.log(`OpenClaude gRPC Service running at grpc://${address}`);
  });
}

startServer();
