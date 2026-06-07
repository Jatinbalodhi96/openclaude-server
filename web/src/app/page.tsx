'use client';

import React, { useState, useEffect, useRef } from 'react';

type Session = {
  session_id: string;
  summary: string;
  cwd: string;
  last_modified: number;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  toolUse?: {
    name: string;
    input: string;
  };
  permissionRequest?: {
    requestId: string;
    toolName: string;
    toolUseId: string;
    inputJson: string;
  };
  isFinished?: boolean;
};

export default function Home() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [cwd, setCwd] = useState('');
  const [bypassPermissions, setBypassPermissions] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sseSourceRef = useRef<EventSource | null>(null);

  // Auto-scroll chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isThinking]);

  // Load sessions on mount
  useEffect(() => {
    fetchSessions();
    // Default CWD path estimation
    setCwd('/Users/jatinbalodhi/Developer/work/openclaude-grpc');
  }, []);

  const fetchSessions = async () => {
    try {
      const resp = await fetch('/api/sessions');
      const data = await resp.json();
      if (data.sessions) {
        setSessions(data.sessions);
      }
    } catch (err) {
      console.error('Error fetching sessions:', err);
    }
  };

  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this session?')) return;
    try {
      await fetch(`/api/sessions?sessionId=${id}`, { method: 'DELETE' });
      if (currentSessionId === id) {
        startNewSession();
      }
      fetchSessions();
    } catch (err) {
      console.error('Error deleting session:', err);
    }
  };

  const startNewSession = () => {
    if (sseSourceRef.current) {
      sseSourceRef.current.close();
    }
    setCurrentSessionId(null);
    setMessages([]);
    setIsThinking(false);
    setConnectionId(null);
  };

  const selectSession = async (id: string) => {
    if (sseSourceRef.current) {
      sseSourceRef.current.close();
    }
    setCurrentSessionId(id);
    setMessages([]);
    setIsThinking(true);

    try {
      const resp = await fetch(`/api/sessions/messages?sessionId=${id}`);
      const data = await resp.json();
      if (data.messages && Array.isArray(data.messages)) {
        const mapped = data.messages.map((m: any) => {
          let text = '';
          try {
            const content = JSON.parse(m.content_json);
            if (typeof content === 'string') {
              text = content;
            } else if (Array.isArray(content)) {
              text = content.map((c: any) => c.text || '').join('');
            } else if (content && typeof content === 'object') {
              text = content.text || JSON.stringify(content);
            }
          } catch {
            text = m.content_json || '';
          }

          return {
            id: m.uuid || Math.random().toString(),
            role: m.role as any,
            text: text
          };
        });
        setMessages(mapped);
      } else {
        setMessages([]);
      }
      setIsThinking(false);
    } catch (err) {
      console.error('Failed to load session history:', err);
      setMessages([]);
      setIsThinking(false);
    }
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() || isThinking) return;

    const userPrompt = inputText.trim();
    setInputText('');

    // Add user message to UI
    const userMsg: ChatMessage = {
      id: Math.random().toString(),
      role: 'user',
      text: userPrompt
    };
    setMessages(prev => [...prev, userMsg]);
    setIsThinking(true);

    // Close any prior EventSource connection
    if (sseSourceRef.current) {
      sseSourceRef.current.close();
    }

    const queryParams = new URLSearchParams({
      prompt: userPrompt,
      sessionId: currentSessionId || '',
      cwd,
      bypass: String(bypassPermissions)
    });

    // Setup Server-Sent Events stream
    const sse = new EventSource(`/api/chat?${queryParams.toString()}`);
    sseSourceRef.current = sse;

    let assistantMsgId = Math.random().toString();
    let assistantTextAccumulated = '';

    sse.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // 1. Connection ID registration
        if (data.type === 'connection_id') {
          setConnectionId(data.connectionId);
          return;
        }

        // 2. Session Started Event
        if (data.session_started) {
          const sId = data.session_started.session_id;
          setCurrentSessionId(sId);
          fetchSessions();
          return;
        }

        // 3. Agent streaming messages
        if (data.agent_message) {
          const sdkMsg = JSON.parse(data.agent_message.sdk_message_json);
          
          if (sdkMsg.type === 'assistant' && sdkMsg.message && Array.isArray(sdkMsg.message.content)) {
            for (const item of sdkMsg.message.content) {
              if (item.type === 'text') {
                assistantTextAccumulated += item.text;
                
                setMessages(prev => {
                  const filtered = prev.filter(m => m.id !== assistantMsgId);
                  return [
                    ...filtered,
                    {
                      id: assistantMsgId,
                      role: 'assistant',
                      text: assistantTextAccumulated
                    }
                  ];
                });
              } else if (item.type === 'tool_use') {
                // Render tool call notification
                setMessages(prev => [
                  ...prev,
                  {
                    id: Math.random().toString(),
                    role: 'system',
                    text: `🔧 Agent wants to use tool: ${item.name}`,
                    toolUse: {
                      name: item.name,
                      input: JSON.stringify(item.input, null, 2)
                    }
                  }
                ]);
              }
            }
          } else if (sdkMsg.type === 'system' && sdkMsg.subtype === 'local_command_output') {
            setMessages(prev => [
              ...prev,
              {
                id: Math.random().toString(),
                role: 'system',
                text: `💻 Terminal command returned:\n${sdkMsg.content}`
              }
            ]);
          }
        }

        // 4. Interactive Permission Request Card
        if (data.permission_request) {
          const req = data.permission_request;
          setMessages(prev => [
            ...prev,
            {
              id: Math.random().toString(),
              role: 'system',
              text: `⚠️ Approval required: ${req.tool_name}`,
              permissionRequest: {
                requestId: req.request_id,
                toolName: req.tool_name,
                toolUseId: req.tool_use_id,
                inputJson: req.input_json
              }
            }
          ]);
          setIsThinking(false); // Pause spinner so user knows they need to take action
        }

        // 5. Completion Event
        if (data.finished) {
          setIsThinking(false);
          sse.close();
          fetchSessions();
        }

        // 6. Error handling
        if (data.error) {
          setMessages(prev => [
            ...prev,
            {
              id: Math.random().toString(),
              role: 'system',
              text: `❌ Error: ${data.error.message}`
            }
          ]);
          setIsThinking(false);
          sse.close();
        }
      } catch (err) {
        console.error('Error parsing SSE event data:', err);
      }
    };

    sse.onerror = (err) => {
      console.error('EventSource connection error:', err);
      setIsThinking(false);
      sse.close();
    };
  };

  const handlePermission = async (
    permReq: { requestId: string; toolName: string; toolUseId: string; inputJson: string },
    decision: 'allow' | 'deny',
    msgIndex: number
  ) => {
    if (!connectionId) return;

    // Remove buttons from the specific card
    setMessages(prev => {
      const updated = [...prev];
      updated[msgIndex] = {
        ...updated[msgIndex],
        text: `✅ Permission ${decision === 'allow' ? 'Approved' : 'Denied'}: ${permReq.toolName}`,
        permissionRequest: undefined // Clears payload to remove buttons
      };
      return updated;
    });

    setIsThinking(true);

    try {
      await fetch('/api/permission-response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId,
          toolUseId: permReq.toolUseId,
          decision,
          message: decision === 'allow' ? '' : 'User denied this execution card'
        })
      });
    } catch (err) {
      console.error('Failed to submit permission decision:', err);
      setIsThinking(false);
    }
  };

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      
      {/* 1. SIDEBAR */}
      <aside 
        className="glass"
        style={{
          width: isSidebarOpen ? '320px' : '0px',
          height: '100%',
          borderRight: '1px solid var(--border-color)',
          display: 'flex',
          flexDirection: 'column',
          transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          overflow: 'hidden',
          zIndex: 10,
          borderRadius: '0'
        }}
      >
        {/* Header */}
        <div style={{ padding: '24px 20px', borderBottom: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 10px var(--accent)' }}></div>
            <h1 style={{ fontSize: '1.25rem', fontWeight: 600, letterSpacing: '-0.5px' }}>OpenClaude gRPC</h1>
          </div>
        </div>

        {/* Configurations */}
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px', borderBottom: '1px solid var(--border-color)' }}>
          <button 
            onClick={startNewSession}
            style={{
              padding: '12px',
              borderRadius: '8px',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              fontWeight: 500,
              cursor: 'pointer',
              boxShadow: '0 4px 12px rgba(139, 92, 246, 0.25)',
              transition: 'all 0.2s'
            }}
            onMouseOver={(e) => (e.currentTarget.style.background = 'var(--accent-light)')}
            onMouseOut={(e) => (e.currentTarget.style.background = 'var(--accent)')}
          >
            + New Session
          </button>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 500 }}>WORKSPACE PATH (CWD)</label>
            <input 
              type="text" 
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid var(--border-color)',
                padding: '8px 12px',
                borderRadius: '6px',
                color: '#fff',
                fontSize: '0.85rem',
                outline: 'none'
              }}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' }}>
            <input 
              type="checkbox" 
              id="bypass"
              checked={bypassPermissions}
              onChange={(e) => setBypassPermissions(e.target.checked)}
              style={{ cursor: 'pointer', width: '16px', height: '16px', accentColor: 'var(--accent)' }}
            />
            <label htmlFor="bypass" style={{ fontSize: '0.85rem', cursor: 'pointer', fontWeight: 500, userSelect: 'none' }}>
              Bypass Permission Prompts
            </label>
          </div>
        </div>

        {/* Sessions List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
          <h3 style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, letterSpacing: '0.5px', marginBottom: '12px', textTransform: 'uppercase' }}>
            Recent Sessions
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {sessions.map((s) => (
              <div 
                key={s.session_id}
                onClick={() => selectSession(s.session_id)}
                style={{
                  padding: '12px',
                  borderRadius: '8px',
                  background: currentSessionId === s.session_id ? 'rgba(139, 92, 246, 0.15)' : 'rgba(255,255,255,0.02)',
                  border: currentSessionId === s.session_id ? '1px solid var(--accent)' : '1px solid transparent',
                  cursor: 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  transition: 'all 0.2s'
                }}
              >
                <div style={{ flex: 1, minWidth: '0', paddingRight: '8px' }}>
                  <p style={{ fontSize: '0.85rem', fontWeight: 500, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.summary || 'Untiled Conversation'}
                  </p>
                  <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.session_id.substring(0, 8)} • {s.cwd}
                  </p>
                </div>
                <button 
                  onClick={(e) => deleteSession(s.session_id, e)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontSize: '1rem',
                    padding: '4px'
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.color = 'var(--red)')}
                  onMouseOut={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* Toggle Sidebar Button */}
      <button 
        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
        style={{
          position: 'absolute',
          left: isSidebarOpen ? '300px' : '10px',
          top: '20px',
          zIndex: 20,
          background: 'rgba(30, 41, 59, 0.8)',
          border: '1px solid var(--border-color)',
          color: '#fff',
          width: '28px',
          height: '28px',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
        }}
      >
        {isSidebarOpen ? '◀' : '▶'}
      </button>

      {/* 2. CHAT SPACE */}
      <main style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        
        {/* Header bar */}
        <header style={{ height: '64px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', padding: '0 60px', background: 'rgba(10, 11, 16, 0.3)', backdropFilter: 'blur(8px)' }}>
          <div>
            <h2 style={{ fontSize: '0.95rem', fontWeight: 600 }}>
              {currentSessionId ? `Session: ${currentSessionId.substring(0, 18)}...` : 'New Chat Session'}
            </h2>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
              Target Folder: <span style={{ fontFamily: 'monospace', background: 'rgba(255,255,255,0.05)', padding: '2px 6px', borderRadius: '4px' }}>{cwd}</span>
            </p>
          </div>
        </header>

        {/* Message Area */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '30px 60px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {messages.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '16px', opacity: 0.8 }}>
              <div style={{ fontSize: '3rem' }}>🤖</div>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 500 }}>Ask OpenClaude to Code Anything</h2>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', textAlign: 'center', maxWidth: '400px' }}>
                You can write text prompts to generate code, search files, read logs, or execute scripts.
              </p>
            </div>
          )}

          {messages.map((m, index) => {
            if (m.role === 'user') {
              return (
                <div key={m.id} style={{ display: 'flex', justifyContent: 'flex-end', animation: 'slideIn 0.2s ease-out' }}>
                  <div style={{ maxWidth: '70%', background: 'var(--accent)', color: '#fff', padding: '14px 20px', borderRadius: '18px 18px 2px 18px', boxShadow: '0 4px 16px rgba(139,92,246,0.15)' }}>
                    <p style={{ fontSize: '0.95rem', lineHeight: '1.5', whiteSpace: 'pre-wrap' }}>{m.text}</p>
                  </div>
                </div>
              );
            }

            if (m.role === 'assistant') {
              return (
                <div key={m.id} style={{ display: 'flex', justifyContent: 'flex-start', animation: 'slideIn 0.2s ease-out' }}>
                  <div 
                    className="glass"
                    style={{ maxWidth: '80%', padding: '16px 22px', borderRadius: '18px 18px 18px 2px' }}
                  >
                    <p style={{ fontSize: '0.95rem', lineHeight: '1.6', color: '#e5e7eb', whiteSpace: 'pre-wrap' }}>
                      {m.text || <span style={{ opacity: 0.5, fontStyle: 'italic' }}>Thinking...</span>}
                    </p>
                  </div>
                </div>
              );
            }

            // System notifications / Tool uses / Permission Prompts
            return (
              <div key={m.id} style={{ display: 'flex', justifyContent: 'center', animation: 'slideIn 0.2s ease-out' }}>
                <div 
                  className="glass"
                  style={{
                    width: '100%',
                    maxWidth: '600px',
                    padding: '16px 20px',
                    borderColor: m.permissionRequest ? 'rgba(239, 68, 68, 0.3)' : 'rgba(255,255,255,0.06)',
                    background: m.permissionRequest ? 'rgba(239, 68, 68, 0.03)' : 'rgba(255,255,255,0.01)',
                  }}
                >
                  <p style={{ fontSize: '0.85rem', fontWeight: 500, color: m.permissionRequest ? 'var(--red)' : 'var(--text-secondary)' }}>
                    {m.text}
                  </p>

                  {/* Tool inputs box */}
                  {m.toolUse && (
                    <pre style={{
                      marginTop: '10px',
                      background: 'rgba(0,0,0,0.2)',
                      padding: '10px',
                      borderRadius: '6px',
                      fontSize: '0.75rem',
                      fontFamily: 'var(--font-mono)',
                      overflowX: 'auto',
                      border: '1px solid rgba(255,255,255,0.03)'
                    }}>{m.toolUse.input}</pre>
                  )}

                  {/* Permission Prompt Card buttons */}
                  {m.permissionRequest && (
                    <div style={{ marginTop: '14px' }}>
                      <pre style={{
                        background: 'rgba(0,0,0,0.3)',
                        padding: '12px',
                        borderRadius: '6px',
                        fontSize: '0.75rem',
                        fontFamily: 'var(--font-mono)',
                        overflowX: 'auto',
                        border: '1px solid rgba(255,255,255,0.04)',
                        marginBottom: '14px'
                      }}>{JSON.stringify(JSON.parse(m.permissionRequest.inputJson), null, 2)}</pre>
                      
                      <div style={{ display: 'flex', gap: '10px' }}>
                        <button
                          onClick={() => handlePermission(m.permissionRequest!, 'allow', index)}
                          style={{
                            flex: 1,
                            padding: '10px',
                            background: 'var(--green)',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '6px',
                            fontWeight: 600,
                            cursor: 'pointer',
                            fontSize: '0.85rem',
                            boxShadow: '0 4px 10px var(--green-glow)',
                            transition: 'all 0.2s'
                          }}
                          onMouseOver={(e) => (e.currentTarget.style.opacity = '0.9')}
                          onMouseOut={(e) => (e.currentTarget.style.opacity = '1')}
                        >
                          Approve Execution
                        </button>
                        <button
                          onClick={() => handlePermission(m.permissionRequest!, 'deny', index)}
                          style={{
                            padding: '10px 16px',
                            background: 'rgba(239,68,68,0.1)',
                            color: 'var(--red)',
                            border: '1px solid var(--red)',
                            borderRadius: '6px',
                            fontWeight: 600,
                            cursor: 'pointer',
                            fontSize: '0.85rem',
                            transition: 'all 0.2s'
                          }}
                          onMouseOver={(e) => (e.currentTarget.style.background = 'rgba(239,68,68,0.2)')}
                          onMouseOut={(e) => (e.currentTarget.style.background = 'rgba(239,68,68,0.1)')}
                        >
                          Deny
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Thinking dot indicator */}
          {isThinking && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', paddingLeft: '10px', alignItems: 'center', gap: '4px' }}>
              {[0, 1, 2].map((i) => (
                <div 
                  key={i} 
                  style={{
                    width: '8px', 
                    height: '8px', 
                    borderRadius: '50%', 
                    background: 'var(--accent)',
                    animation: `dotPulse 1.2s infinite ease-in-out both`,
                    animationDelay: `${i * 0.2}s`
                  }}
                ></div>
              ))}
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div style={{ padding: '24px 60px 40px 60px', background: 'linear-gradient(to top, var(--bg-dark) 80%, transparent)' }}>
          <form onSubmit={handleSend} style={{ display: 'flex', gap: '12px' }}>
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Ask Claude to code or run commands..."
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              style={{
                flex: 1,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid var(--border-color)',
                borderRadius: '12px',
                padding: '16px 20px',
                color: '#fff',
                fontSize: '0.95rem',
                outline: 'none',
                resize: 'none',
                height: '56px',
                lineHeight: '1.4',
                fontFamily: 'var(--font-sans)',
                transition: 'border-color 0.2s'
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-color)')}
            />
            <button
              type="submit"
              disabled={isThinking || !inputText.trim()}
              style={{
                width: '56px',
                height: '56px',
                borderRadius: '12px',
                background: isThinking || !inputText.trim() ? 'rgba(255,255,255,0.05)' : 'var(--accent)',
                color: isThinking || !inputText.trim() ? 'var(--text-secondary)' : '#fff',
                border: 'none',
                cursor: isThinking || !inputText.trim() ? 'not-allowed' : 'pointer',
                fontSize: '1.25rem',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: isThinking || !inputText.trim() ? 'none' : '0 4px 14px var(--accent-glow)',
                transition: 'all 0.2s'
              }}
            >
              ➔
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
