import { NextResponse } from 'next/server';
import { getClient } from '@/lib/grpcClient';

/**
 * GET: Lists all sessions
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const dir = searchParams.get('dir') || '';
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    const client = getClient();
    const response: any = await new Promise((resolve, reject) => {
      client.ListSessions({ dir, limit, offset }, (err: any, resp: any) => {
        if (err) return reject(err);
        resolve(resp);
      });
    });

    return NextResponse.json({ sessions: response.sessions || [] });
  } catch (err: any) {
    console.error('ListSessions error in API route:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to list sessions' },
      { status: 500 }
    );
  }
}

/**
 * DELETE: Deletes a session by sessionId
 */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    const dir = searchParams.get('dir') || '';

    if (!sessionId) {
      return NextResponse.json(
        { error: 'sessionId query parameter is required' },
        { status: 400 }
      );
    }

    const client = getClient();
    await new Promise((resolve, reject) => {
      client.DeleteSession({ session_id: sessionId, dir }, (err: any, resp: any) => {
        if (err) return reject(err);
        resolve(resp);
      });
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('DeleteSession error in API route:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to delete session' },
      { status: 500 }
    );
  }
}
