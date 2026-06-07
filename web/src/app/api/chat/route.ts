import { getClient } from '@/lib/grpcClient';
import { activeStreams } from '@/lib/activeStreams';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const prompt = searchParams.get('prompt') || '';
  const sessionId = searchParams.get('sessionId') || '';
  const cwd = searchParams.get('cwd') || process.cwd();
  const bypass = searchParams.get('bypass') === 'true';

  if (!prompt && !sessionId) {
    return new Response('prompt or sessionId query parameter is required', { status: 400 });
  }

  const connectionId = Math.random().toString(36).substring(2, 15);
  const client = getClient();
  const chatStream = client.SessionChat();

  activeStreams.set(connectionId, chatStream);

  const encoder = new TextEncoder();

  const readableStream = new ReadableStream({
    start(controller) {
      // 1. Send the connectionId back to the browser first
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: 'connection_id', connectionId })}\n\n`)
      );

      // 2. Listen to gRPC events and forward them
      chatStream.on('data', (response: any) => {
        // Log stream activity
        console.log(`[SSE Gateway] Forwarding data for connection ${connectionId}:`, Object.keys(response));

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(response)}\n\n`)
        );

        if (response.session_started && prompt) {
          // Once the session starts, submit the user prompt immediately
          console.log(`[SSE Gateway] Session started. Sending prompt: "${prompt}"`);
          chatStream.write({
            user_prompt: {
              prompt
            }
          });
        }

        if (response.finished) {
          console.log(`[SSE Gateway] Session finished for connection ${connectionId}`);
          cleanup();
          try {
            controller.close();
          } catch {}
        }
      });

      chatStream.on('error', (err: any) => {
        console.error(`[SSE Gateway] gRPC stream error for connection ${connectionId}:`, err);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: { message: err.message || 'Stream error occurred' } })}\n\n`)
        );
        cleanup();
        try {
          controller.close();
        } catch {}
      });

      // 3. Initiate session startup
      console.log(`[SSE Gateway] Initializing session. CWD: ${cwd}, SessionID: ${sessionId}, Bypass: ${bypass}`);
      chatStream.write({
        start_session: {
          cwd,
          session_id: sessionId || undefined,
          permission_mode: bypass ? 'bypassPermissions' : 'default',
          allow_dangerously_skip_permissions: bypass
        }
      });
    },
    cancel() {
      console.log(`[SSE Gateway] Browser aborted connection ${connectionId}`);
      cleanup();
    }
  });

  function cleanup() {
    if (activeStreams.has(connectionId)) {
      activeStreams.delete(connectionId);
      try {
        chatStream.end();
      } catch (err) {
        console.error('Error ending gRPC stream:', err);
      }
    }
  }

  return new Response(readableStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
