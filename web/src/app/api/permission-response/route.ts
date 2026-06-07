import { NextResponse } from 'next/server';
import { activeStreams } from '@/lib/activeStreams';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { connectionId, toolUseId, decision, message } = body;

    if (!connectionId || !toolUseId || !decision) {
      return NextResponse.json(
        { error: 'connectionId, toolUseId, and decision are required' },
        { status: 400 }
      );
    }

    const chatStream = activeStreams.get(connectionId);
    if (!chatStream) {
      console.warn(`[Permission Gateway] No active stream found for connection ${connectionId}`);
      return NextResponse.json(
        { error: 'No active stream connection found. It may have expired or closed.' },
        { status: 404 }
      );
    }

    console.log(`[Permission Gateway] Writing permission response to connection ${connectionId}:`, {
      toolUseId,
      decision,
      message
    });

    // Write permission response to the gRPC bidi stream
    chatStream.write({
      permission_response: {
        tool_use_id: toolUseId,
        decision,
        message: message || ''
      }
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Error posting permission response:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to submit permission response' },
      { status: 500 }
    );
  }
}
