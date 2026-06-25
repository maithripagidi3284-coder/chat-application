import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import socket from '../socket';
import axios from 'axios';

interface Reaction { emoji: string; username: string; }

interface Message {
  id:         number;
  username:   string;
  message:    string;
  time:       string;
  is_edited:  boolean;
  is_deleted: boolean;
  reactions:  Reaction[];
}

const EMOJIS = ['👍','❤️','😂','😮','😢','🔥','👏','🎉'];
const API    = 'http://localhost:3000';

export default function Chat() {
  const { room }        = useParams<{ room: string }>();
  const { user, token } = useAuth();
  const navigate        = useNavigate();

  const [messages, setMessages]         = useState<Message[]>([]);
  const [input, setInput]               = useState('');
  const [typing, setTyping]             = useState('');
  const [onlineUsers, setOnlineUsers]   = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen]   = useState(false);
  const [editingId, setEditingId]       = useState<number | null>(null);
  const [editText, setEditText]         = useState('');
  const [page, setPage]                 = useState(1);
  const [hasMore, setHasMore]           = useState(false);
  const [loadingMore, setLoadingMore]   = useState(false);
  const [pickerFor, setPickerFor]       = useState<number | null>(null);

  const bottomRef     = useRef<HTMLDivElement>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadMessages = async (p = 1, prepend = false) => {
    try {
      const res = await axios.get(`${API}/api/messages/${room}?page=${p}&limit=30`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const { messages: msgs, total, limit } = res.data;
      const mapped: Message[] = msgs.map((m: any) => ({
        id:         m.id,
        username:   m.username,
        message:    m.content,
        time:       new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        is_edited:  m.is_edited,
        is_deleted: m.is_deleted,
        reactions:  m.reactions || [],
      }));
      setHasMore(p * limit < total);
      if (prepend) setMessages(prev => [...mapped, ...prev]);
      else setMessages(mapped);
    } catch {}
  };

  useEffect(() => {
    socket.auth = { token };
    socket.connect();
    socket.emit('join_room', room);
    loadMessages(1);

    socket.on('receive_message',  (msg: Message) => setMessages(prev => [...prev, { ...msg, reactions: [] }]));
    socket.on('user_typing',      (u: string)    => { setTyping(`${u} is typing`); setTimeout(() => setTyping(''), 2000); });
    socket.on('user_joined',      ({ onlineUsers }) => setOnlineUsers(Object.values(onlineUsers)));
    socket.on('user_left',        ({ onlineUsers }) => setOnlineUsers(Object.values(onlineUsers)));

    socket.on('message_edited', ({ id, content }: { id: number; content: string }) => {
      setMessages(prev => prev.map(m => m.id === id ? { ...m, message: content, is_edited: true } : m));
    });
    socket.on('message_deleted', ({ id }: { id: string }) => {
      setMessages(prev => prev.map(m => m.id === Number(id) ? { ...m, is_deleted: true } : m));
    });
    socket.on('reactions_updated', ({ messageId, reactions }: { messageId: number; reactions: Reaction[] }) => {
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, reactions } : m));
    });

    return () => {
      ['receive_message','user_typing','user_joined','user_left','message_edited','message_deleted','reactions_updated']
        .forEach(e => socket.off(e));
      socket.disconnect();
    };
  }, [room]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // Close emoji picker on outside click
  useEffect(() => {
    const handler = () => setPickerFor(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  const sendMessage = () => {
    if (!input.trim()) return;
    socket.emit('send_message', { room, message: input });
    setInput('');
  };

  const handleTyping = () => {
    socket.emit('typing');
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => { typingTimeout.current = null; }, 1500);
  };

  const handleDelete = async (id: number) => {
    await axios.delete(`${API}/api/messages/${id}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  };

  const handleEdit = async (id: number) => {
    if (!editText.trim()) return;
    await axios.put(`${API}/api/messages/${id}`, { content: editText }, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    setEditingId(null); setEditText('');
  };

  const handleReact = async (messageId: number, emoji: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await axios.post(`${API}/api/messages/${messageId}/react`, { emoji }, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    setPickerFor(null);
  };

  const loadMore = async () => {
    setLoadingMore(true);
    const next = page + 1;
    await loadMessages(next, true);
    setPage(next);
    setLoadingMore(false);
  };

  // Group reactions: { emoji -> [usernames] }
  const groupReactions = (reactions: Reaction[]) => {
    const map: Record<string, string[]> = {};
    reactions.forEach(r => { if (!map[r.emoji]) map[r.emoji] = []; map[r.emoji].push(r.username); });
    return map;
  };

  const getAvatarColor = (u: string) => {
    const colors = ['#6c63ff','#f64f59','#43c6ac','#f7971e','#12c2e9','#c471ed'];
    return colors[u.charCodeAt(0) % colors.length];
  };

  const isMine = (u: string) => u === user?.username;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }

        .chat-root { display:flex; height:100dvh; font-family:'Inter',sans-serif; background:#f5f6fa; overflow:hidden; }

        /* Sidebar */
        .sidebar { width:240px; background:#1a1b2e; color:#fff; display:flex; flex-direction:column; padding:1.25rem 1rem; gap:0.5rem; flex-shrink:0; transition:transform 0.3s ease; }
        .sidebar-logo { font-size:1.15rem; font-weight:600; margin-bottom:0.75rem; }
        .back-btn { display:flex; align-items:center; gap:0.4rem; background:rgba(108,99,255,0.2); color:#a89ff7; border:1px solid rgba(108,99,255,0.3); border-radius:8px; padding:0.5rem 0.75rem; font-size:0.85rem; cursor:pointer; transition:background 0.2s; width:100%; }
        .back-btn:hover { background:rgba(108,99,255,0.35); }
        .room-name { font-size:1rem; font-weight:600; margin:1rem 0 0.25rem; padding:0.5rem 0.75rem; background:rgba(255,255,255,0.06); border-radius:8px; }
        .section-label { font-size:0.7rem; font-weight:600; text-transform:uppercase; letter-spacing:0.08em; color:#6b7280; margin:0.75rem 0 0.4rem 0.25rem; }
        .online-user { display:flex; align-items:center; gap:0.5rem; font-size:0.875rem; padding:0.35rem 0.5rem; border-radius:6px; color:#d1d5db; }
        .online-dot { width:8px; height:8px; border-radius:50%; background:#22c55e; flex-shrink:0; box-shadow:0 0 6px #22c55e88; }

        /* Chat area */
        .chat-area { flex:1; display:flex; flex-direction:column; min-width:0; background:#fff; }
        .mobile-header { display:none; align-items:center; gap:0.75rem; padding:0.75rem 1rem; background:#1a1b2e; color:#fff; }
        .hamburger { background:none; border:none; color:#fff; font-size:1.25rem; cursor:pointer; }
        .mobile-room-name { font-weight:600; font-size:1rem; }

        .load-more-btn { display:block; margin:0.5rem auto 1rem; background:none; border:1.5px solid #e5e7eb; border-radius:20px; padding:0.4rem 1.2rem; font-size:0.8rem; color:#6b7280; cursor:pointer; transition:border-color 0.2s,color 0.2s; }
        .load-more-btn:hover { border-color:#6c63ff; color:#6c63ff; }

        .messages-list { flex:1; overflow-y:auto; padding:1.25rem 1rem; display:flex; flex-direction:column; gap:0.75rem; }
        .messages-list::-webkit-scrollbar { width:4px; }
        .messages-list::-webkit-scrollbar-thumb { background:#e5e7eb; border-radius:2px; }
        .empty-state { text-align:center; color:#9ca3af; font-size:0.9rem; margin:auto; padding:2rem; }

        /* Message row */
        .msg-row { display:flex; align-items:flex-end; gap:0.5rem; animation:fadeSlideIn 0.2s ease both; position:relative; }
        .msg-row.mine { flex-direction:row-reverse; }
        @keyframes fadeSlideIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }

        .avatar { width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:0.75rem; font-weight:700; color:#fff; flex-shrink:0; }

        /* Bubble wrapper — holds bubble + reactions below */
        .bubble-wrap { display:flex; flex-direction:column; max-width:min(60%,380px); gap:0.3rem; }
        .msg-row.mine .bubble-wrap { align-items:flex-end; }

        .bubble { width:100%; padding:0.55rem 0.9rem 0.45rem; border-radius:16px; word-break:break-word; }
        .bubble.mine   { background:#6c63ff; color:#fff; border-bottom-right-radius:4px; }
        .bubble.theirs { background:#f3f4f6; color:#111827; border-bottom-left-radius:4px; }
        .bubble.deleted { background:#f3f4f6 !important; color:#9ca3af !important; font-style:italic; }

        .bubble-username { font-size:0.7rem; font-weight:600; margin-bottom:0.2rem; opacity:0.75; }
        .bubble-text { font-size:0.925rem; line-height:1.45; }
        .bubble-meta { display:flex; align-items:center; gap:0.4rem; justify-content:flex-end; margin-top:0.3rem; }
        .bubble-time { font-size:0.65rem; opacity:0.6; }
        .edited-tag  { font-size:0.6rem; opacity:0.55; font-style:italic; }

        /* Reactions row */
        .reactions-row { display:flex; flex-wrap:wrap; gap:0.3rem; }
        .reaction-chip {
          display:inline-flex; align-items:center; gap:0.25rem;
          background:#f3f4f6; border:1.5px solid transparent;
          border-radius:20px; padding:0.2rem 0.5rem;
          font-size:0.8rem; cursor:pointer;
          transition:border-color 0.15s, background 0.15s;
          user-select:none;
        }
        .reaction-chip.mine { background:#ede9ff; border-color:#6c63ff; }
        .reaction-chip:hover { border-color:#6c63ff; }
        .reaction-count { font-size:0.75rem; color:#374151; font-weight:500; }

        /* Emoji picker */
        .emoji-picker {
          position:absolute; bottom:calc(100% + 6px);
          background:#fff; border:1px solid #e5e7eb;
          border-radius:12px; padding:0.5rem;
          display:flex; gap:0.3rem; flex-wrap:wrap;
          box-shadow:0 4px 20px rgba(0,0,0,0.12);
          z-index:100; width:220px;
        }
        .msg-row.mine  .emoji-picker { right:0; }
        .msg-row.theirs .emoji-picker { left:38px; }
        .emoji-btn {
          font-size:1.3rem; background:none; border:none; cursor:pointer;
          border-radius:8px; padding:0.25rem 0.35rem;
          transition:background 0.15s, transform 0.1s;
          line-height:1;
        }
        .emoji-btn:hover { background:#f3f4f6; transform:scale(1.2); }

        /* Hover actions */
        .msg-actions { display:none; flex-direction:column; gap:0.25rem; position:absolute; top:0; }
        .msg-row.mine   .msg-actions { right:calc(100% + 8px); align-items:flex-end; }
        .msg-row.theirs .msg-actions { left:calc(100% + 8px); align-items:flex-start; }
        .msg-row:hover .msg-actions { display:flex; }

        .action-btn { background:#fff; border:1px solid #e5e7eb; border-radius:6px; padding:0.25rem 0.5rem; font-size:0.72rem; cursor:pointer; color:#374151; transition:background 0.15s; white-space:nowrap; box-shadow:0 1px 4px rgba(0,0,0,0.08); }
        .action-btn:hover { background:#f9fafb; }
        .action-btn.delete:hover { background:#fef2f2; color:#dc2626; border-color:#fecaca; }
        .action-btn.react { }

        /* Inline edit */
        .edit-input { flex:1; padding:0.4rem 0.6rem; border:1.5px solid #6c63ff; border-radius:8px; font-size:0.875rem; font-family:'Inter',sans-serif; outline:none; background:#fff; color:#111827; width:100%; margin-top:0.3rem; }
        .edit-area { display:flex; gap:0.4rem; margin-top:0.4rem; }
        .edit-save   { background:#6c63ff; color:#fff; border:none; border-radius:6px; padding:0.4rem 0.75rem; font-size:0.8rem; cursor:pointer; }
        .edit-cancel { background:none; border:1px solid #e5e7eb; border-radius:6px; padding:0.4rem 0.6rem; font-size:0.8rem; cursor:pointer; color:#6b7280; }

        /* Typing */
        .typing-bar { padding:0.4rem 1.25rem; min-height:1.5rem; font-size:0.8rem; color:#9ca3af; font-style:italic; display:flex; align-items:center; gap:0.4rem; }
        .typing-dots { display:flex; gap:3px; align-items:center; }
        .typing-dots span { width:5px; height:5px; background:#9ca3af; border-radius:50%; animation:bounce 1.2s infinite; }
        .typing-dots span:nth-child(2) { animation-delay:0.2s; }
        .typing-dots span:nth-child(3) { animation-delay:0.4s; }
        @keyframes bounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-4px)} }

        /* Input */
        .input-area { display:flex; align-items:center; gap:0.5rem; padding:0.75rem 1rem; border-top:1px solid #f3f4f6; background:#fff; }
        .chat-input { flex:1; padding:0.7rem 1rem; border-radius:24px; border:1.5px solid #e5e7eb; font-size:0.95rem; font-family:'Inter',sans-serif; background:#f9fafb; transition:border-color 0.2s,box-shadow 0.2s; outline:none; }
        .chat-input:focus { border-color:#6c63ff; box-shadow:0 0 0 3px rgba(108,99,255,0.1); background:#fff; }
        .send-btn { width:42px; height:42px; border-radius:50%; background:#6c63ff; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:background 0.2s,transform 0.15s; }
        .send-btn:hover:not(:disabled) { background:#5a52e0; transform:scale(1.05); }
        .send-btn:disabled { background:#c4c1f5; cursor:not-allowed; }
        .send-btn svg { width:18px; height:18px; fill:#fff; }

        .sidebar-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:10; }

        @media (max-width:640px) {
          .sidebar { position:fixed; inset:0 auto 0 0; z-index:20; transform:translateX(-100%); width:240px; }
          .sidebar.open { transform:translateX(0); }
          .sidebar-overlay.open { display:block; }
          .mobile-header { display:flex; }
          .bubble-wrap { max-width:min(75%,300px); }
        }
      `}</style>

      <div className="chat-root">
        <div className={`sidebar-overlay ${sidebarOpen ? 'open' : ''}`} onClick={() => setSidebarOpen(false)} />

        <div className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
          <div className="sidebar-logo">💬 ChatApp</div>
          <button className="back-btn" onClick={() => { socket.disconnect(); navigate('/rooms'); }}>← Back to Rooms</button>
          <div className="room-name"># {room}</div>
          <div className="section-label">Online — {onlineUsers.length}</div>
          {onlineUsers.map((u, i) => (
            <div key={i} className="online-user"><span className="online-dot" />{u}</div>
          ))}
        </div>

        <div className="chat-area">
          <div className="mobile-header">
            <button className="hamburger" onClick={() => setSidebarOpen(v => !v)}>☰</button>
            <span className="mobile-room-name"># {room}</span>
          </div>

          <div className="messages-list">
            {hasMore && (
              <button className="load-more-btn" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : '↑ Load older messages'}
              </button>
            )}
            {messages.length === 0 && <div className="empty-state">No messages yet — say hello! 👋</div>}

            {messages.map((msg) => {
              const mine    = isMine(msg.username);
              const grouped = groupReactions(msg.reactions || []);
              return (
                <div key={msg.id} className={`msg-row ${mine ? 'mine' : ''}`}>
                  <div className="avatar" style={{ background: getAvatarColor(msg.username) }} title={msg.username}>
                    {msg.username[0].toUpperCase()}
                  </div>

                  <div className="bubble-wrap">
                    <div className={`bubble ${mine ? 'mine' : 'theirs'} ${msg.is_deleted ? 'deleted' : ''}`}>
                      {!mine && <div className="bubble-username">{msg.username}</div>}

                      {editingId === msg.id ? (
                        <>
                          <input className="edit-input" value={editText} onChange={e => setEditText(e.target.value)}
                            onKeyDown={e => { if (e.key==='Enter') handleEdit(msg.id); if (e.key==='Escape') { setEditingId(null); setEditText(''); } }}
                            autoFocus />
                          <div className="edit-area">
                            <button className="edit-save" onClick={() => handleEdit(msg.id)}>Save</button>
                            <button className="edit-cancel" onClick={() => { setEditingId(null); setEditText(''); }}>Cancel</button>
                          </div>
                        </>
                      ) : (
                        <div className="bubble-text">
                          {msg.is_deleted ? '🚫 This message was deleted' : msg.message}
                        </div>
                      )}

                      <div className="bubble-meta">
                        {msg.is_edited && !msg.is_deleted && <span className="edited-tag">edited</span>}
                        <span className="bubble-time">{msg.time}</span>
                      </div>
                    </div>

                    {/* Reactions display */}
                    {!msg.is_deleted && Object.keys(grouped).length > 0 && (
                      <div className="reactions-row">
                        {Object.entries(grouped).map(([emoji, users]) => (
                          <button
                            key={emoji}
                            className={`reaction-chip ${users.includes(user?.username || '') ? 'mine' : ''}`}
                            onClick={e => handleReact(msg.id, emoji, e)}
                            title={users.join(', ')}
                          >
                            {emoji} <span className="reaction-count">{users.length}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Emoji picker */}
                  {pickerFor === msg.id && !msg.is_deleted && (
                    <div className="emoji-picker" onClick={e => e.stopPropagation()}>
                      {EMOJIS.map(emoji => (
                        <button key={emoji} className="emoji-btn" onClick={e => handleReact(msg.id, emoji, e)}>
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Hover actions */}
                  {!msg.is_deleted && editingId !== msg.id && (
                    <div className="msg-actions">
                      <button className="action-btn react"
                        onClick={e => { e.stopPropagation(); setPickerFor(p => p === msg.id ? null : msg.id); }}>
                        😊 React
                      </button>
                      {mine && (
                        <>
                          <button className="action-btn" onClick={() => { setEditingId(msg.id); setEditText(msg.message); }}>✏️ Edit</button>
                          <button className="action-btn delete" onClick={() => handleDelete(msg.id)}>🗑️ Delete</button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          <div className="typing-bar">
            {typing && <><div className="typing-dots"><span/><span/><span/></div>{typing}</>}
          </div>

          <div className="input-area">
            <input className="chat-input" placeholder={`Message #${room}…`} value={input}
              onChange={e => { setInput(e.target.value); handleTyping(); }}
              onKeyDown={e => e.key === 'Enter' && sendMessage()} />
            <button className="send-btn" onClick={sendMessage} disabled={!input.trim()}>
              <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}