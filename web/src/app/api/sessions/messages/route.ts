import { NextResponse } from 'next/server';
import { getClient } from '@/lib/grpcClient';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    const dir = searchParams.get('dir') || '';
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    if (!sessionId) {
      return NextResponse.json(
        { error: 'sessionId query parameter is required' },
        { status: 400 }
      );
    }

    const client = getClient();
    const response: any = await new Promise((resolve, reject) => {
      client.GetSessionMessages(
        { session_id: sessionId, dir, limit, offset, include_system_messages: false },
        (err: any, resp: any) => {
          if (err) return reject(err);
          resolve(resp);
        }
      );
    });

    return NextResponse.json({ messages: response.messages || [] });
  } catch (err: any) {
    console.error('GetSessionMessages error in API route:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to retrieve session messages' },
      { status: 500 }
    );
  }
}
