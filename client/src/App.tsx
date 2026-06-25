import { useState, useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import axios from "axios";
import "./App.css";

const SERVER_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";
const EMOJIS = ["👍","❤️","😂","😮","😢","🔥","👏","🎉"];

// ── IMPORTANT: Replace with your actual Anthropic API key ──────────────────

interface Reaction  { emoji: string; username: string; }
interface Message   { id: string; username: string; message: string; time: string; is_edited?: boolean; is_deleted?: boolean; reactions?: Reaction[]; encrypted?: boolean; isBot?: boolean; }
interface User      { id: number; username: string; email: string; }
interface Room      { id: number; name: string; has_password: boolean; created_by: string; }
interface Invite    { id: number; room: string; from_user: string; status: string; }
interface Profile   { username: string; bio: string; avatar_url: string | null; is_public: boolean; friends: string[]; friend_status?: "none" | "pending_sent" | "pending_received" | "friends"; }
interface FriendReq { id: number; from_user: string; to_user: string; status: string; }
type Screen = "login" | "register" | "rooms" | "chat";

interface Particle {
  x: number; y: number; vx: number; vy: number;
  color: string; size: number; alpha: number; rotation: number; rotSpeed: number;
}

// ── E2E Crypto Helpers ────────────────────────────────────────────────────────
// Derives an AES-GCM key from a room password using PBKDF2
async function deriveKey(password: string, roomName: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode(roomName), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptMessage(plaintext: string, key: CryptoKey): Promise<string> {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, enc.encode(plaintext)
  );
  // Pack iv + ciphertext as base64
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

async function decryptMessage(b64: string, key: CryptoKey): Promise<string | null> {
  try {
    const combined = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plain);
  } catch {
    return null; // Wrong key or not encrypted
  }
}

// Detect if a string looks like our base64-encrypted payload (heuristic)
function looksEncrypted(text: string): boolean {
  return /^[A-Za-z0-9+/]{40,}={0,2}$/.test(text);
}

// ── AI Bot Helper ────────────────────────────────────────────────────────────
async function callClaudeBot(
  userMessage: string,
  roomHistory: Message[],
  currentUsername: string
): Promise<string> {
  const contextMessages = roomHistory
    .filter(m => !m.is_deleted && !m.message.startsWith("@bot"))
    .slice(-30)
    .map(m => `${m.username}: ${m.message}`)
    .join("\n");

  const token = localStorage.getItem("token");
  const response = await fetch(`${SERVER_URL}/api/bot`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ userMessage, contextMessages, currentUsername }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as any)?.error || "Bot request failed");
  }

  const data = await response.json();
  return data.reply || "Sorry, I couldn't generate a response.";
}

// ── Audio / Avatar / URL helpers ─────────────────────────────────────────────
const playPop = () => {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.1, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    o.start(); o.stop(ctx.currentTime + 0.15);
  } catch {}
};

const getAvatarColor = (u: string) => ["#6c63ff","#f64f59","#43c6ac","#f7971e","#12c2e9","#c471ed"][u.charCodeAt(0) % 6];

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp|svg)(\?.*)?$/i;

function isImageUrl(url: string) {
  try { return IMAGE_EXT.test(new URL(url).pathname); } catch { return false; }
}

function MessageContent({ text, isMine }: { text: string; isMine: boolean }) {
  const parts: React.ReactNode[] = [];
  const imageUrls: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  const regex = new RegExp(URL_REGEX.source, "g");

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const url = match[0];
    parts.push(
      <a key={match.index} href={url} target="_blank" rel="noopener noreferrer"
        style={{ color: isMine ? "#c4b9ff" : "#6c63ff", textDecoration: "underline", wordBreak: "break-all" }}>
        {url}
      </a>
    );
    if (isImageUrl(url)) imageUrls.push(url);
    last = match.index + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));

  return (
    <>
      <p style={{ margin: 0, fontSize: "0.925rem", lineHeight: 1.45 }}>{parts}</p>
      {imageUrls.map((url, i) => (
        <a key={i} href={url} target="_blank" rel="noopener noreferrer">
          <img src={url} alt="shared" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
            style={{ maxWidth: "100%", maxHeight: "240px", borderRadius: "8px", marginTop: "6px", display: "block", objectFit: "cover", cursor: "pointer" }} />
        </a>
      ))}
    </>
  );
}

function Avatar({ username, avatarUrl, size = 30 }: { username: string; avatarUrl?: string | null; size?: number }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt={username} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
  }
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: getAvatarColor(username), color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: size * 0.35, flexShrink: 0 }}>
      {username[0].toUpperCase()}
    </div>
  );
}

// ── Confetti ──────────────────────────────────────────────────────────────────
function ConfettiOverlay({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const COLORS = ["#6c63ff","#f64f59","#43c6ac","#f7971e","#12c2e9","#c471ed","#fff","#ffd700"];

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext("2d")!;
    const particles: Particle[] = Array.from({ length: 120 }, () => ({
      x: canvas.width / 2 + (Math.random() - 0.5) * 200,
      y: canvas.height / 2,
      vx: (Math.random() - 0.5) * 14,
      vy: -(Math.random() * 12 + 4),
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      size: Math.random() * 8 + 4,
      alpha: 1,
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.2,
    }));
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      particles.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.vy += 0.35; p.vx *= 0.99;
        p.alpha -= 0.012; p.rotation += p.rotSpeed;
        if (p.alpha > 0) {
          alive = true;
          ctx.save(); ctx.globalAlpha = Math.max(0, p.alpha); ctx.fillStyle = p.color;
          ctx.translate(p.x, p.y); ctx.rotate(p.rotation);
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.5);
          ctx.restore();
        }
      });
      if (alive) rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active]);

  if (!active) return null;
  return <canvas ref={canvasRef} style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9999 }} />;
}

// ── Welcome Toast ─────────────────────────────────────────────────────────────
function WelcomeToast({ roomName, visible }: { roomName: string; visible: boolean }) {
  return (
    <div style={{
      position: "fixed", top: visible ? "20px" : "-100px", left: "50%", transform: "translateX(-50%)",
      background: "linear-gradient(135deg, #6c63ff, #a89ff7)", color: "#fff",
      padding: "0.75rem 1.5rem", borderRadius: "40px", boxShadow: "0 8px 32px rgba(108,99,255,0.4)",
      fontSize: "0.95rem", fontWeight: 600, fontFamily: "Inter,sans-serif", zIndex: 9998,
      transition: "top 0.5s cubic-bezier(0.34,1.56,0.64,1)", whiteSpace: "nowrap",
      display: "flex", alignItems: "center", gap: "0.5rem", pointerEvents: "none",
    }}>
      👋 Welcome to <span style={{ color: "#ffd700" }}>#{roomName}</span>!
    </div>
  );
}

// ── Encryption Lock Modal ─────────────────────────────────────────────────────
function EncryptionModal({
  visible, onClose, onSetKey, currentlyEncrypted,
}: {
  visible: boolean;
  onClose: () => void;
  onSetKey: (password: string | null) => void;
  currentlyEncrypted: boolean;
}) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");

  if (!visible) return null;

  const handleSet = async () => {
    if (!pw.trim()) { setError("Enter a password"); return; }
    onSetKey(pw);
    setPw(""); setError("");
    onClose();
  };

  const handleClear = () => {
    onSetKey(null);
    setPw(""); setError("");
    onClose();
  };

  return (
    <div style={s.modal}>
      <div style={{ ...s.modalBox, width: "360px" }}>
        <h3 style={{ marginBottom: "0.5rem" }}>🔐 Room Encryption</h3>
        <p style={{ color: "#6b7280", fontSize: "0.875rem", marginBottom: "1.25rem", lineHeight: 1.5 }}>
          Set a shared password for this room. Messages will be encrypted client-side using AES-GCM before being sent. Only users with the same password can read them.
        </p>
        {currentlyEncrypted && (
          <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", padding: "0.6rem 0.9rem", marginBottom: "1rem", fontSize: "0.85rem", color: "#15803d" }}>
            ✅ Encryption is active for this room
          </div>
        )}
        <input
          style={s.input} type="password" placeholder="Room encryption password"
          value={pw} onChange={e => setPw(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSet()} autoFocus
        />
        {error && <p style={{ color: "#dc2626", fontSize: "0.8rem", marginBottom: "0.5rem" }}>{error}</p>}
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button style={s.btn} onClick={handleSet}>Enable Encryption</button>
          {currentlyEncrypted && (
            <button style={{ ...s.cancelBtn, background: "#fef2f2", color: "#dc2626" }} onClick={handleClear}>
              Disable Encryption
            </button>
          )}
          <button style={s.cancelBtn} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen]           = useState<Screen>("login");
  const [user, setUser]               = useState<User | null>(null);
  const [token, setToken]             = useState<string | null>(null);
  const [currentRoom, setCurrentRoom] = useState("");
  const [messages, setMessages]       = useState<Message[]>([]);
  const [inputText, setInputText]     = useState("");
  const [typing, setTyping]           = useState("");
  const [onlineUsers, setOnlineUsers] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch]   = useState(false);
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [editText, setEditText]       = useState("");
  const [pickerFor, setPickerFor]     = useState<string | null>(null);
  const [unread, setUnread]           = useState(0);
  const [rooms, setRooms]             = useState<Room[]>([]);
  const [invites, setInvites]         = useState<Invite[]>([]);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [showInvite, setShowInvite]   = useState(false);
  const [showInvites, setShowInvites] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomPass, setNewRoomPass] = useState("");
  const [inviteUser, setInviteUser]   = useState("");
  const [roomPassword, setRoomPassword] = useState("");
  const [passwordRoom, setPasswordRoom] = useState<Room | null>(null);
  const [roomError, setRoomError]     = useState("");

  // Profile state
  const [showMyProfile, setShowMyProfile]     = useState(false);
  const [viewingProfile, setViewingProfile]   = useState<Profile | null>(null);
  const [myProfile, setMyProfile]             = useState<Profile | null>(null);
  const [editBio, setEditBio]                 = useState("");
  const [editIsPublic, setEditIsPublic]       = useState(true);
  const [avatarPreview, setAvatarPreview]     = useState<string | null>(null);
  const [profileSaving, setProfileSaving]     = useState(false);
  const [profileMsg, setProfileMsg]           = useState("");
  const [avatarCache, setAvatarCache]         = useState<Record<string, string | null>>({});

  // Friend requests
  const [friendRequests, setFriendRequests]   = useState<FriendReq[]>([]);
  const [showFriendReqs, setShowFriendReqs]   = useState(false);
  const [friendReqLoading, setFriendReqLoading] = useState<number | null>(null);

  const [loginForm, setLoginForm]       = useState({ email: "", password: "" });
  const [registerForm, setRegisterForm] = useState({ username: "", email: "", password: "" });
  const [authError, setAuthError]       = useState("");
  const [loading, setLoading]           = useState(false);

  // Animation state
  const [showConfetti, setShowConfetti]           = useState(false);
  const [cardGlow, setCardGlow]                   = useState(false);
  const [showWelcomeToast, setShowWelcomeToast]   = useState(false);
  const [animatedMsgCount, setAnimatedMsgCount]   = useState(0);

  // ── E2E Encryption state ──────────────────────────────────────────────────
  const [cryptoKey, setCryptoKey]               = useState<CryptoKey | null>(null);
  const [showEncryptionModal, setShowEncryptionModal] = useState(false);
  const [encryptionActive, setEncryptionActive] = useState(false);

  // ── AI Bot state ──────────────────────────────────────────────────────────
  const [botThinking, setBotThinking] = useState(false);

  const bottomRef  = useRef<HTMLDivElement>(null);
  const socketRef  = useRef<Socket | null>(null);
  const fileRef    = useRef<HTMLInputElement>(null);
  // Keep a ref to messages for use in async bot handler
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // ── Session restore ───────────────────────────────────────────────────────
  useEffect(() => {
    const savedToken = localStorage.getItem("token");
    const savedUser  = localStorage.getItem("user");
    if (savedToken && savedUser) {
      axios.get(`${SERVER_URL}/api/rooms`, { headers: { Authorization: `Bearer ${savedToken}` } })
        .then(() => { setToken(savedToken); setUser(JSON.parse(savedUser)); setScreen("rooms"); })
        .catch(() => { localStorage.clear(); setScreen("login"); });
    } else {
      setScreen("login");
    }
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => { document.title = unread > 0 ? `(${unread}) ChatApp` : "ChatApp"; }, [unread]);
  useEffect(() => { const h = () => setPickerFor(null); document.addEventListener("click", h); return () => document.removeEventListener("click", h); }, []);

  // Reset encryption when leaving a room
  useEffect(() => {
    if (screen !== "chat") {
      setCryptoKey(null);
      setEncryptionActive(false);
    }
  }, [screen]);

  // ── Load rooms & invites ──────────────────────────────────────────────────
  const loadRooms = useCallback(async (t: string) => {
    const res = await axios.get(`${SERVER_URL}/api/rooms`, { headers: { Authorization: `Bearer ${t}` } });
    setRooms(res.data.rooms);
  }, []);

  const loadInvites = useCallback(async (t: string) => {
    const res = await axios.get(`${SERVER_URL}/api/invites`, { headers: { Authorization: `Bearer ${t}` } });
    setInvites(res.data.invites);
  }, []);

  const loadFriendRequests = useCallback(async (t: string) => {
    try {
      const res = await axios.get(`${SERVER_URL}/api/friend-requests`, { headers: { Authorization: `Bearer ${t}` } });
      setFriendRequests(res.data.requests);
    } catch {}
  }, []);

  const loadMyProfile = useCallback(async (t: string, username: string) => {
    try {
      const res = await axios.get(`${SERVER_URL}/api/profile/${username}`, { headers: { Authorization: `Bearer ${t}` } });
      setMyProfile(res.data.profile);
      setEditBio(res.data.profile.bio || "");
      setEditIsPublic(res.data.profile.is_public);
      setAvatarPreview(res.data.profile.avatar_url || null);
    } catch {}
  }, []);

  useEffect(() => {
    if (token && screen === "rooms" && user) {
      loadRooms(token); loadInvites(token); loadFriendRequests(token); loadMyProfile(token, user.username);
    }
  }, [token, screen, loadRooms, loadInvites, loadFriendRequests, loadMyProfile, user]);

  // ── Fetch avatar ──────────────────────────────────────────────────────────
  const fetchAvatar = useCallback(async (username: string, t: string) => {
    if (avatarCache.hasOwnProperty(username)) return;
    try {
      const res = await axios.get(`${SERVER_URL}/api/profile/${username}`, { headers: { Authorization: `Bearer ${t}` } });
      setAvatarCache(prev => ({ ...prev, [username]: res.data.profile.avatar_url || null }));
    } catch {
      setAvatarCache(prev => ({ ...prev, [username]: null }));
    }
  }, [avatarCache]);

  useEffect(() => {
    if (!token) return;
    const usernames = [...new Set(messages.map(m => m.username))];
    usernames.forEach(u => fetchAvatar(u, token));
  }, [messages, token, fetchAvatar]);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setAuthError("");
    try {
      const res = await axios.post(`${SERVER_URL}/api/login`, loginForm);
      localStorage.setItem("token", res.data.accessToken);
      localStorage.setItem("user",  JSON.stringify(res.data.user));
      setShowConfetti(true); setCardGlow(true);
      setTimeout(() => setShowConfetti(false), 3000);
      setTimeout(() => setCardGlow(false), 1000);
      setTimeout(() => { setToken(res.data.accessToken); setUser(res.data.user); setScreen("rooms"); }, 800);
    } catch (err: any) { setAuthError(err.response?.data?.error || "Login failed"); }
    finally { setLoading(false); }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setAuthError("");
    try {
      await axios.post(`${SERVER_URL}/api/register`, registerForm);
      setScreen("login"); setAuthError("Registered! Please login.");
    } catch (err: any) { setAuthError(err.response?.data?.error || "Registration failed"); }
    finally { setLoading(false); }
  };

  const handleLogout = useCallback(() => {
    socketRef.current?.disconnect(); socketRef.current = null;
    localStorage.clear(); setToken(null); setUser(null);
    setMessages([]); setScreen("login");
  }, []);

  // ── Profile save ──────────────────────────────────────────────────────────
  const handleSaveProfile = async () => {
    if (!token) return;
    setProfileSaving(true); setProfileMsg("");
    try {
      await axios.put(`${SERVER_URL}/api/profile`, { bio: editBio, is_public: editIsPublic, avatar_url: avatarPreview }, { headers: { Authorization: `Bearer ${token}` } });
      setProfileMsg("Profile saved!");
      loadMyProfile(token, user!.username);
      setAvatarCache(prev => ({ ...prev, [user!.username]: avatarPreview }));
    } catch { setProfileMsg("Failed to save."); }
    finally { setProfileSaving(false); }
  };

  const handleAvatarFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 500 * 1024) { setProfileMsg("Image must be under 500 KB"); return; }
    const reader = new FileReader();
    reader.onload = () => setAvatarPreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  // ── View profile ──────────────────────────────────────────────────────────
  const handleViewProfile = async (username: string) => {
    if (!token) return;
    try {
      const res = await axios.get(`${SERVER_URL}/api/profile/${username}`, { headers: { Authorization: `Bearer ${token}` } });
      setViewingProfile(res.data.profile);
    } catch { alert("Could not load profile."); }
  };

  // ── Friend requests ───────────────────────────────────────────────────────
  const handleSendFriendReq = async (toUser: string) => {
    if (!token) return;
    try {
      await axios.post(`${SERVER_URL}/api/friend-requests`, { to_user: toUser }, { headers: { Authorization: `Bearer ${token}` } });
      setViewingProfile(prev => prev ? { ...prev, friend_status: "pending_sent" } : prev);
    } catch (err: any) { alert(err.response?.data?.error || "Failed to send request"); }
  };

  const handleFriendReqResponse = async (reqId: number, accept: boolean) => {
    if (!token) return;
    setFriendReqLoading(reqId);
    try {
      await axios.put(`${SERVER_URL}/api/friend-requests/${reqId}`, { status: accept ? "accepted" : "declined" }, { headers: { Authorization: `Bearer ${token}` } });
      setFriendRequests(prev => prev.filter(r => r.id !== reqId));
    } catch { alert("Failed to respond."); }
    finally { setFriendReqLoading(null); }
  };

  const handleUnfriend = async (username: string) => {
    if (!token) return;
    try {
      await axios.delete(`${SERVER_URL}/api/friends/${username}`, { headers: { Authorization: `Bearer ${token}` } });
      setViewingProfile(prev => prev ? { ...prev, friend_status: "none", friends: prev.friends.filter(f => f !== user?.username) } : prev);
      loadMyProfile(token, user!.username);
    } catch { alert("Failed to unfriend."); }
  };

  // ── Create room ───────────────────────────────────────────────────────────
  const handleCreateRoom = async () => {
    if (!newRoomName.trim()) return;
    try {
      await axios.post(`${SERVER_URL}/api/rooms`, { name: newRoomName, password: newRoomPass || undefined }, { headers: { Authorization: `Bearer ${token}` } });
      setNewRoomName(""); setNewRoomPass(""); setShowCreateRoom(false); loadRooms(token!);
    } catch (err: any) { setRoomError(err.response?.data?.error || "Failed to create room"); }
  };

  // ── Join room ─────────────────────────────────────────────────────────────
  const joinRoom = async (room: Room, password?: string) => {
    setRoomError("");
    try {
      await axios.post(`${SERVER_URL}/api/rooms/${room.name}/join`, { password: password || undefined }, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err: any) {
      if (err.response?.data?.needsPassword || err.response?.data?.error === 'Password required') { setPasswordRoom(room); return; }
      setRoomError(err.response?.data?.error || "Failed to join room"); return;
    }

    if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null; }
    setCurrentRoom(room.name); setMessages([]); setUnread(0); setPasswordRoom(null); setRoomPassword("");
    // Reset encryption for new room
    setCryptoKey(null); setEncryptionActive(false);

    try {
      const res = await axios.get(`${SERVER_URL}/api/messages/${room.name}`, { headers: { Authorization: `Bearer ${token}` } });
      const loaded = (res.data.messages || []).map((m: any) => ({
        id: String(m.id), username: m.username, message: m.content,
        time: new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        is_edited: m.is_edited, is_deleted: m.is_deleted, reactions: m.reactions || [],
        encrypted: looksEncrypted(m.content),
      }));
      setMessages(loaded);
      setAnimatedMsgCount(Math.min(loaded.length, 20));
      setTimeout(() => setAnimatedMsgCount(0), loaded.length * 60 + 600);
    } catch {}

    const newSocket = io(SERVER_URL, { auth: { token } });
    socketRef.current = newSocket;
    newSocket.emit("join_room", room.name);

    newSocket.on("receive_message", (msg: any) => {
      setMessages(prev => [...prev, {
        id: String(msg.id || Date.now()), username: msg.username, message: msg.message,
        time: msg.time || new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        reactions: [], encrypted: looksEncrypted(msg.message),
      }]);
      playPop(); setUnread(n => n + 1);
    });
    newSocket.on("message_edited",    ({ id, content }: any) => setMessages(prev => prev.map(m => m.id === String(id) ? { ...m, message: content, is_edited: true } : m)));
    newSocket.on("message_deleted",   ({ id }: any)          => setMessages(prev => prev.map(m => m.id === String(id) ? { ...m, is_deleted: true } : m)));
    newSocket.on("reactions_updated", ({ messageId, reactions }: any) => setMessages(prev => prev.map(m => m.id === String(messageId) ? { ...m, reactions } : m)));
    newSocket.on("user_typing",       (u: string) => { setTyping(`${u} is typing...`); setTimeout(() => setTyping(""), 2000); });
    newSocket.on("user_joined",       ({ onlineUsers }: any) => setOnlineUsers(Object.values(onlineUsers)));
    newSocket.on("user_left",         ({ onlineUsers }: any) => setOnlineUsers(Object.values(onlineUsers)));
    newSocket.on("friend_request",    ({ from }: any) => {
      setFriendRequests(prev => [...prev, { id: Date.now(), from_user: from, to_user: user?.username || "", status: "pending" }]);
    });
    newSocket.on(`invite:${user?.username}`, ({ room: r, from }: any) => {
      if (window.confirm(`${from} invited you to #${r}! Join now?`)) {
        const inviteRoom = rooms.find(x => x.name === r);
        if (inviteRoom) joinRoom(inviteRoom);
      }
    });

    setShowWelcomeToast(true);
    setTimeout(() => setShowWelcomeToast(false), 3000);
    setScreen("chat");
  };

  const leaveRoom = () => {
    socketRef.current?.disconnect(); socketRef.current = null;
    setMessages([]); setUnread(0); setScreen("rooms");
  };

  // ── Invite ────────────────────────────────────────────────────────────────
  const handleSendInvite = async () => {
    if (!inviteUser.trim()) return;
    try {
      await axios.post(`${SERVER_URL}/api/invites`, { to_user: inviteUser, room: currentRoom }, { headers: { Authorization: `Bearer ${token}` } });
      setInviteUser(""); setShowInvite(false); alert(`Invite sent to ${inviteUser}!`);
    } catch (err: any) { alert(err.response?.data?.error || "Failed to send invite"); }
  };

  const handleInviteResponse = async (invite: Invite, accept: boolean) => {
    await axios.put(`${SERVER_URL}/api/invites/${invite.id}`, { status: accept ? "accepted" : "declined" }, { headers: { Authorization: `Bearer ${token}` } });
    if (accept) { const room = rooms.find(r => r.name === invite.room); if (room) { setShowInvites(false); joinRoom(room); } }
    setInvites(prev => prev.filter(i => i.id !== invite.id));
  };

  // ── E2E Encryption: set key for room ─────────────────────────────────────
  const handleSetEncryptionKey = async (password: string | null) => {
    if (!password) {
      setCryptoKey(null);
      setEncryptionActive(false);
      return;
    }
    try {
      const key = await deriveKey(password, currentRoom);
      setCryptoKey(key);
      setEncryptionActive(true);
    } catch {
      alert("Failed to derive encryption key.");
    }
  };

  // ── Messaging (with encryption + bot) ────────────────────────────────────
  const sendMessage = async () => {
    if (!inputText.trim() || !socketRef.current) return;
    const rawText = inputText.trim();
    setInputText("");

    // ── @bot trigger ───────────────────────────────────────────────────────
    if (rawText.toLowerCase().startsWith("@bot ")) {
      const query = rawText.slice(5).trim();
      if (!query) return;

      // Show user's message immediately
      const userMsgId = `local-${Date.now()}`;
      const userMsg: Message = {
        id: userMsgId, username: user?.username || "me", message: rawText,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        reactions: [],
      };
      setMessages(prev => [...prev, userMsg]);

      // Show thinking indicator
      setBotThinking(true);
      const thinkingId = `bot-thinking-${Date.now()}`;
      setMessages(prev => [...prev, {
        id: thinkingId, username: "🤖 ChatBot", message: "...", isBot: true,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        reactions: [],
      }]);

      // Also emit to socket so others see your @bot message
      socketRef.current.emit("send_message", { room: currentRoom, message: rawText });

      try {
        const botReply = await callClaudeBot(query, messagesRef.current, user?.username || "");
        setMessages(prev => prev.map(m =>
          m.id === thinkingId
            ? { ...m, message: botReply }
            : m
        ));
      } catch (err: any) {
        setMessages(prev => prev.map(m =>
          m.id === thinkingId
            ? { ...m, message: `❌ Bot error: ${err.message}` }
            : m
        ));
      } finally {
        setBotThinking(false);
      }
      return;
    }

    // ── Normal message (with optional encryption) ──────────────────────────
    let outgoing = rawText;
    if (cryptoKey) {
      try {
        outgoing = await encryptMessage(rawText, cryptoKey);
      } catch {
        alert("Encryption failed. Message not sent.");
        return;
      }
    }

    socketRef.current.emit("send_message", { room: currentRoom, message: outgoing });
  };

  // ── Decrypt a message for display ────────────────────────────────────────
  const decryptForDisplay = useCallback(async (msg: Message): Promise<string> => {
    if (!msg.encrypted || !cryptoKey) return msg.message;
    const plain = await decryptMessage(msg.message, cryptoKey);
    return plain ?? "[Encrypted — wrong password or no key set]";
  }, [cryptoKey]);

  // Resolved (decrypted) messages for display
  const [resolvedMessages, setResolvedMessages] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      const updates: Record<string, string> = {};
      for (const msg of messages) {
        if (msg.encrypted && cryptoKey) {
          updates[msg.id] = await decryptForDisplay(msg);
        }
      }
      if (!cancelled) setResolvedMessages(prev => ({ ...prev, ...updates }));
    };
    resolve();
    return () => { cancelled = true; };
  }, [messages, cryptoKey, decryptForDisplay]);

  const getDisplayText = (msg: Message): string => {
    if (msg.encrypted) {
      return resolvedMessages[msg.id] ?? (cryptoKey ? "Decrypting…" : "[Encrypted — set room password to read]");
    }
    return msg.message;
  };

  // ── Edit / Delete / React ─────────────────────────────────────────────────
  const handleEdit = async (id: string) => {
    if (!editText.trim()) return;
    await axios.put(`${SERVER_URL}/api/messages/${id}`, { content: editText }, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    setEditingId(null); setEditText("");
  };

  const handleDelete = async (id: string) => {
    await axios.delete(`${SERVER_URL}/api/messages/${id}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  };

  const handleReact = async (messageId: string, emoji: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await axios.post(`${SERVER_URL}/api/messages/${messageId}/react`, { emoji }, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    setPickerFor(null);
  };

  const groupReactions = (reactions: Reaction[] = []) => {
    const map: Record<string, string[]> = {};
    reactions.forEach(r => { if (!map[r.emoji]) map[r.emoji] = []; map[r.emoji].push(r.username); });
    return map;
  };

  const filteredMessages = messages.filter(m =>
    !searchQuery || m.message.toLowerCase().includes(searchQuery.toLowerCase()) || m.username.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const shareRoomLink = async (room: string) => {
    try {
      const res = await axios.post(`${SERVER_URL}/api/invite-links`, { room }, { headers: { Authorization: `Bearer ${token}` } });
      const link = `${window.location.origin}?invite=${res.data.token}`;
      navigator.clipboard.writeText(link).then(() => alert(`Invite link copied! ✅\n\n${link}\n\nExpires in 24 hours.`));
    } catch { alert("Failed to generate invite link"); }
  };

  // ── Invite link handling ──────────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const inviteToken = params.get("invite");
    if (inviteToken && token && screen === "rooms" && rooms.length > 0) {
      axios.get(`${SERVER_URL}/api/invite-links/${inviteToken}`)
        .then(res => {
          const room = rooms.find(r => r.name === res.data.room);
          if (room) { window.history.replaceState({}, '', window.location.pathname); joinRoom(room); }
        })
        .catch(() => alert("This invite link has expired or is invalid."));
    }
  }, [rooms, token, screen]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const inviteToken = params.get("invite");
    if (inviteToken && !token) localStorage.setItem("pendingInvite", inviteToken);
  }, []);

  useEffect(() => {
    const pendingInvite = localStorage.getItem("pendingInvite");
    if (pendingInvite && token && screen === "rooms" && rooms.length > 0) {
      localStorage.removeItem("pendingInvite");
      axios.get(`${SERVER_URL}/api/invite-links/${pendingInvite}`)
        .then(res => { const room = rooms.find(r => r.name === res.data.room); if (room) joinRoom(room); })
        .catch(() => alert("This invite link has expired or is invalid."));
    }
  }, [token, screen, rooms]);

  const pendingFriendReqs = friendRequests.filter(r => r.to_user === user?.username && r.status === "pending");

  // ── LOGIN ─────────────────────────────────────────────────────────────────
  if (screen === "login") return (
    <div style={s.page}>
      <ConfettiOverlay active={showConfetti} />
      <div style={{
        ...s.card,
        transition: "box-shadow 0.3s ease, transform 0.3s ease",
        boxShadow: cardGlow ? "0 0 0 4px #a89ff7, 0 8px 40px rgba(108,99,255,0.5)" : "0 4px 24px rgba(0,0,0,0.1)",
        transform: cardGlow ? "scale(1.02)" : "scale(1)",
      }}>
        <h2 style={s.logo}>💬 ChatApp</h2>
        <p style={s.sub}>Welcome back!</p>
        {authError && <p style={s.error}>{authError}</p>}
        <form onSubmit={handleLogin}>
          <input style={s.input} type="email" placeholder="Email" value={loginForm.email} onChange={e => setLoginForm({ ...loginForm, email: e.target.value })} required />
          <input style={s.input} type="password" placeholder="Password" value={loginForm.password} onChange={e => setLoginForm({ ...loginForm, password: e.target.value })} required />
          <button style={s.btn} type="submit" disabled={loading}>{loading ? "Logging in..." : "Login"}</button>
        </form>
        <p style={s.switchText}>No account? <span style={s.link} onClick={() => { setScreen("register"); setAuthError(""); }}>Register</span></p>
      </div>
    </div>
  );

  // ── REGISTER ──────────────────────────────────────────────────────────────
  if (screen === "register") return (
    <div style={s.page}>
      <div style={s.card}>
        <h2 style={s.logo}>💬 ChatApp</h2>
        <p style={s.sub}>Create your account</p>
        {authError && <p style={s.error}>{authError}</p>}
        <form onSubmit={handleRegister}>
          <input style={s.input} type="text" placeholder="Username" value={registerForm.username} onChange={e => setRegisterForm({ ...registerForm, username: e.target.value })} required />
          <input style={s.input} type="email" placeholder="Email" value={registerForm.email} onChange={e => setRegisterForm({ ...registerForm, email: e.target.value })} required />
          <input style={s.input} type="password" placeholder="Password" value={registerForm.password} onChange={e => setRegisterForm({ ...registerForm, password: e.target.value })} required />
          <button style={s.btn} type="submit" disabled={loading}>{loading ? "Registering..." : "Register"}</button>
        </form>
        <p style={s.switchText}>Have an account? <span style={s.link} onClick={() => { setScreen("login"); setAuthError(""); }}>Login</span></p>
      </div>
    </div>
  );

  // ── ROOMS ─────────────────────────────────────────────────────────────────
  if (screen === "rooms") return (
    <div style={s.page}>
      <div style={{ ...s.card, width: "440px" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.5rem" }}>
          <h2 style={{ ...s.logo, margin:0 }}>💬 ChatApp</h2>
          <div style={{ display:"flex", gap:"0.5rem", alignItems:"center" }}>
            {pendingFriendReqs.length > 0 && <button style={s.iconBtnRed} onClick={() => setShowFriendReqs(true)}>🤝 {pendingFriendReqs.length}</button>}
            {invites.length > 0 && <button style={s.iconBtnRed} onClick={() => setShowInvites(true)}>🔔 {invites.length}</button>}
            <button style={s.profileChip} onClick={() => setShowMyProfile(true)}>
              <Avatar username={user?.username || ""} avatarUrl={myProfile?.avatar_url} size={24} />
              <span style={{ fontSize:"0.85rem", fontWeight:500 }}>{user?.username}</span>
            </button>
            <button style={s.logoutBtn} onClick={handleLogout}>Logout</button>
          </div>
        </div>
        <p style={s.sub}>Pick a room to join</p>
        {roomError && <p style={s.error}>{roomError}</p>}

        {showCreateRoom ? (
          <div style={s.createRoomBox}>
            <input style={s.input} placeholder="Room name" value={newRoomName} onChange={e => setNewRoomName(e.target.value)} autoFocus />
            <input style={s.input} placeholder="Password (optional)" type="password" value={newRoomPass} onChange={e => setNewRoomPass(e.target.value)} />
            <div style={{ display:"flex", gap:"0.5rem" }}>
              <button style={s.btn} onClick={handleCreateRoom}>Create</button>
              <button style={s.cancelBtn} onClick={() => { setShowCreateRoom(false); setNewRoomName(""); setNewRoomPass(""); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <button style={{ ...s.btn, marginBottom:"1rem" }} onClick={() => setShowCreateRoom(true)}>+ Create Room</button>
        )}

        <div style={{ display:"flex", flexDirection:"column", gap:"0.5rem", maxHeight:"400px", overflowY:"auto" }}>
          {rooms.map(room => (
            <div key={room.id} style={s.roomRow}>
              <div style={{ flex:1 }}>
                <span style={{ fontWeight:500 }}># {room.name}</span>
                {room.has_password && <span style={s.lockBadge}>🔒 Private</span>}
              </div>
              <div style={{ display:"flex", gap:"0.4rem" }}>
                <button style={s.shareBtn} onClick={() => shareRoomLink(room.name)} title="Copy invite link">🔗</button>
                <button style={s.joinBtn} onClick={() => joinRoom(room)}>Join</button>
              </div>
            </div>
          ))}
        </div>

        {/* Password modal */}
        {passwordRoom && (
          <div style={s.modal}>
            <div style={s.modalBox}>
              <h3 style={{ marginBottom:"1rem" }}>🔒 {passwordRoom.name} requires a password</h3>
              <input style={s.input} type="password" placeholder="Enter room password" value={roomPassword}
                onChange={e => setRoomPassword(e.target.value)}
                onKeyDown={e => e.key === "Enter" && joinRoom(passwordRoom, roomPassword)} autoFocus />
              {roomError && <p style={s.error}>{roomError}</p>}
              <div style={{ display:"flex", gap:"0.5rem" }}>
                <button style={s.btn} onClick={() => joinRoom(passwordRoom, roomPassword)}>Join</button>
                <button style={s.cancelBtn} onClick={() => { setPasswordRoom(null); setRoomPassword(""); setRoomError(""); }}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* Invites modal */}
        {showInvites && (
          <div style={s.modal}><div style={s.modalBox}>
            <h3 style={{ marginBottom:"1rem" }}>🔔 Pending Invites</h3>
            {invites.map(inv => (
              <div key={inv.id} style={s.inviteRow}>
                <span><strong>{inv.from_user}</strong> invited you to <strong>#{inv.room}</strong></span>
                <div style={{ display:"flex", gap:"0.4rem" }}>
                  <button style={s.btn} onClick={() => handleInviteResponse(inv, true)}>Accept</button>
                  <button style={s.cancelBtn} onClick={() => handleInviteResponse(inv, false)}>Decline</button>
                </div>
              </div>
            ))}
            <button style={s.cancelBtn} onClick={() => setShowInvites(false)}>Close</button>
          </div></div>
        )}

        {/* Friend requests modal */}
        {showFriendReqs && (
          <div style={s.modal}><div style={s.modalBox}>
            <h3 style={{ marginBottom:"1rem" }}>🤝 Friend Requests</h3>
            {pendingFriendReqs.length === 0 && <p style={{ color:"#9ca3af", marginBottom:"1rem" }}>No pending requests.</p>}
            {pendingFriendReqs.map(req => (
              <div key={req.id} style={s.inviteRow}>
                <span><strong>{req.from_user}</strong> wants to be friends</span>
                <div style={{ display:"flex", gap:"0.4rem" }}>
                  <button style={s.btn} disabled={friendReqLoading === req.id} onClick={() => handleFriendReqResponse(req.id, true)}>Accept</button>
                  <button style={s.cancelBtn} disabled={friendReqLoading === req.id} onClick={() => handleFriendReqResponse(req.id, false)}>Decline</button>
                </div>
              </div>
            ))}
            <button style={s.cancelBtn} onClick={() => setShowFriendReqs(false)}>Close</button>
          </div></div>
        )}

        {/* My Profile modal */}
        {showMyProfile && renderProfileModal()}
        {viewingProfile && renderViewProfileModal()}
      </div>
    </div>
  );

  // ── CHAT ──────────────────────────────────────────────────────────────────
  return (
    <div style={s.chatLayout} onClick={() => setPickerFor(null)}>
      <WelcomeToast roomName={currentRoom} visible={showWelcomeToast} />

      {/* Encryption Modal */}
      <EncryptionModal
        visible={showEncryptionModal}
        onClose={() => setShowEncryptionModal(false)}
        onSetKey={handleSetEncryptionKey}
        currentlyEncrypted={encryptionActive}
      />

      <div style={s.sidebar}>
        <h3 style={{ color:"#fff", marginBottom:"1rem", fontSize:"1rem" }}>💬 ChatApp</h3>
        <button style={s.backBtn} onClick={leaveRoom}>← Rooms</button>
        <p style={s.roomLabel}># {currentRoom}</p>
        <p style={s.sectionLabel}>Online ({onlineUsers.length})</p>
        {onlineUsers.map((u, i) => (
          <div key={i} style={{ ...s.onlineUser, cursor:"pointer" }} onClick={() => handleViewProfile(u)}>
            <Avatar username={u} avatarUrl={avatarCache[u]} size={22} />
            <span style={{ fontSize:"0.875rem", marginLeft:"6px" }}>{u}</span>
            <span style={{ color:"#22c55e", fontSize:"0.55rem", marginLeft:"auto" }}>●</span>
          </div>
        ))}
        <div style={{ marginTop:"auto", display:"flex", flexDirection:"column", gap:"0.5rem" }}>
          <button style={s.profileBtn} onClick={() => setShowMyProfile(true)}>
            <Avatar username={user?.username || ""} avatarUrl={myProfile?.avatar_url} size={20} />
            <span style={{ fontSize:"0.8rem" }}>My Profile</span>
          </button>
          <button style={s.shareBtn2} onClick={() => shareRoomLink(currentRoom)}>🔗 Share Room</button>
          <button style={s.inviteBtn} onClick={() => setShowInvite(true)}>👤 Invite User</button>
          <button style={s.logoutBtn} onClick={handleLogout}>Logout</button>
        </div>
      </div>

      <div style={s.chatArea}>
        <div style={s.chatHeader}>
          <span style={{ fontWeight:600 }}># {currentRoom}</span>
          <div style={{ display:"flex", gap:"0.5rem", alignItems:"center" }}>
            {pendingFriendReqs.length > 0 && (
              <button style={{ ...s.iconBtnRed, fontSize:"0.8rem" }} onClick={() => setShowFriendReqs(true)}>🤝 {pendingFriendReqs.length}</button>
            )}
            {/* 🔐 Encryption toggle button */}
            <button
              style={{
                ...s.iconBtn,
                background: encryptionActive ? "rgba(108,99,255,0.12)" : "none",
                border: encryptionActive ? "1.5px solid #6c63ff" : "1.5px solid transparent",
                borderRadius: "8px",
                fontSize: "1rem",
                padding: "0.3rem 0.6rem",
                position: "relative",
              }}
              onClick={() => setShowEncryptionModal(true)}
              title={encryptionActive ? "Encryption active — click to change" : "Enable end-to-end encryption"}
            >
              {encryptionActive ? "🔒" : "🔓"}
              {encryptionActive && (
                <span style={{ position:"absolute", top:"-4px", right:"-4px", width:"8px", height:"8px", background:"#22c55e", borderRadius:"50%", border:"1.5px solid #fff" }} />
              )}
            </button>
            {unread > 0 && <span style={s.unreadBadge} onClick={() => { setUnread(0); bottomRef.current?.scrollIntoView({ behavior:"smooth" }); }}>{unread} new ↓</span>}
            <button style={s.iconBtn} onClick={() => setShowSearch(v => !v)}>🔍</button>
          </div>
        </div>

        {/* Encryption status bar */}
        {encryptionActive && (
          <div style={{ padding:"0.35rem 1.25rem", background:"linear-gradient(90deg,rgba(108,99,255,0.08),rgba(108,99,255,0.04))", borderBottom:"1px solid rgba(108,99,255,0.15)", display:"flex", alignItems:"center", gap:"0.5rem", fontSize:"0.78rem", color:"#6c63ff" }}>
            <span>🔐</span>
            <span style={{ fontWeight:500 }}>End-to-end encrypted</span>
            <span style={{ color:"#9ca3af" }}>— Messages are encrypted before leaving your device</span>
          </div>
        )}

        {showSearch && (
          <div style={s.searchBar}>
            <input style={s.searchInput} placeholder="Search messages..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} autoFocus />
            {searchQuery && <span style={{ color:"#999", fontSize:"0.8rem" }}>{filteredMessages.length} results</span>}
          </div>
        )}

        <div style={s.messages}>
          {/* Bot usage hint */}
          <div style={{ textAlign:"center", padding:"0.5rem", color:"#c4b9ff", fontSize:"0.75rem", background:"rgba(108,99,255,0.04)", borderRadius:"10px", margin:"0 0 0.5rem" }}>
            💡 Tip: Type <code style={{ background:"rgba(108,99,255,0.15)", padding:"0.1rem 0.35rem", borderRadius:"4px" }}>@bot your question</code> to ask the AI assistant
          </div>

          {filteredMessages.length === 0 && !searchQuery && <p style={{ color:"#999", textAlign:"center", marginTop:"2rem" }}>No messages yet — say hello! 👋</p>}
          {filteredMessages.map((msg, idx) => {
            const isMine  = msg.username === user?.username;
            const isBot   = msg.isBot === true || msg.username === "🤖 ChatBot";
            const grouped = groupReactions(msg.reactions);
            const totalFiltered = filteredMessages.length;
            const waveStart = totalFiltered - animatedMsgCount;
            const isWaving = animatedMsgCount > 0 && idx >= waveStart;
            const waveDelay = isWaving ? (idx - waveStart) * 55 : 0;
            const displayText = getDisplayText(msg);
            void (msg.encrypted && !resolvedMessages[msg.id]?.startsWith("["));

            return (
              <div
                key={msg.id}
                style={{
                  ...s.msgRow,
                  flexDirection: isMine ? "row-reverse" : "row",
                  position: "relative",
                  opacity: isWaving ? undefined : 1,
                  animation: isWaving ? "msgWaveIn 0.4s ease both" : undefined,
                  animationDelay: isWaving ? `${waveDelay}ms` : undefined,
                }}
                className="msg-row"
              >
                {/* Bot gets special avatar */}
                {isBot ? (
                  <div style={{ width:30, height:30, borderRadius:"50%", background:"linear-gradient(135deg,#6c63ff,#a89ff7)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:"0.9rem", flexShrink:0 }}>
                    🤖
                  </div>
                ) : (
                  <div style={{ cursor:"pointer" }} onClick={() => handleViewProfile(msg.username)}>
                    <Avatar username={msg.username} avatarUrl={avatarCache[msg.username]} size={30} />
                  </div>
                )}

                <div style={{ display:"flex", flexDirection:"column", maxWidth:"60%", gap:"4px", alignItems: isMine ? "flex-end" : "flex-start" }}>
                  {/* Bot bubble has distinct style */}
                  <div style={{
                    ...s.bubble,
                    background: msg.is_deleted ? "#f3f4f6"
                      : isBot ? "linear-gradient(135deg, #1a1b2e, #2d2f4e)"
                      : isMine ? "#6c63ff"
                      : "#f0f2f5",
                    color: msg.is_deleted ? "#9ca3af" : isBot ? "#e2e8f0" : isMine ? "#fff" : "#111827",
                    fontStyle: msg.is_deleted ? "italic" : "normal",
                    borderBottomRightRadius: isMine ? 4 : 16,
                    borderBottomLeftRadius: isMine ? 16 : 4,
                    border: isBot ? "1px solid rgba(108,99,255,0.3)" : "none",
                    boxShadow: isBot ? "0 2px 12px rgba(108,99,255,0.15)" : "none",
                  }}>
                    {/* Sender label */}
                    {(!isMine || isBot) && (
                      <p style={{ ...s.msgUser, cursor: isBot ? "default" : "pointer", color: isBot ? "#a89ff7" : undefined }}
                        onClick={isBot ? undefined : () => handleViewProfile(msg.username)}>
                        {isBot ? "🤖 AI Assistant" : msg.username}
                      </p>
                    )}

                    {editingId === msg.id ? (
                      <div>
                        <input style={s.editInput} value={editText} onChange={e => setEditText(e.target.value)} onKeyDown={e => { if (e.key==="Enter") handleEdit(msg.id); if (e.key==="Escape") setEditingId(null); }} autoFocus />
                        <div style={{ display:"flex", gap:"6px", marginTop:"6px" }}>
                          <button style={s.editSave} onClick={() => handleEdit(msg.id)}>Save</button>
                          <button style={s.editCancel} onClick={() => setEditingId(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : msg.is_deleted ? (
                      <p style={s.msgText}>🚫 This message was deleted</p>
                    ) : displayText === "..." && isBot ? (
                      // Thinking animation
                      <div style={{ display:"flex", gap:"4px", padding:"2px 0", alignItems:"center" }}>
                        <span style={{ width:"6px", height:"6px", background:"#a89ff7", borderRadius:"50%", animation:"bounce 1.2s infinite" }} />
                        <span style={{ width:"6px", height:"6px", background:"#a89ff7", borderRadius:"50%", animation:"bounce 1.2s 0.2s infinite" }} />
                        <span style={{ width:"6px", height:"6px", background:"#a89ff7", borderRadius:"50%", animation:"bounce 1.2s 0.4s infinite" }} />
                      </div>
                    ) : (
                      <>
                        <MessageContent text={displayText} isMine={isMine && !isBot} />
                        {/* Encryption badge */}
                        {msg.encrypted && (
                          <span style={{ display:"inline-flex", alignItems:"center", gap:"3px", marginTop:"4px", fontSize:"0.65rem", opacity:0.75, color: isMine ? "#c4b9ff" : "#6c63ff" }}>
                            🔒 encrypted
                          </span>
                        )}
                      </>
                    )}
                    <div style={{ display:"flex", justifyContent:"flex-end", alignItems:"center", gap:"4px", marginTop:"4px" }}>
                      {msg.is_edited && !msg.is_deleted && <span style={{ fontSize:"0.6rem", opacity:0.6, fontStyle:"italic" }}>edited</span>}
                      <span style={s.msgTime}>{msg.time}</span>
                    </div>
                  </div>

                  {!msg.is_deleted && Object.keys(grouped).length > 0 && (
                    <div style={{ display:"flex", flexWrap:"wrap", gap:"4px" }}>
                      {Object.entries(grouped).map(([emoji, users]) => (
                        <button key={emoji} onClick={e => handleReact(msg.id, emoji, e)}
                          style={{ ...s.reactionChip, background: users.includes(user?.username||"") ? "#ede9ff" : "#f3f4f6", border: users.includes(user?.username||"") ? "1.5px solid #6c63ff" : "1.5px solid transparent" }}
                          title={users.join(", ")}>
                          {emoji} <span style={{ fontSize:"0.75rem" }}>{users.length}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {!msg.is_deleted && !isBot && editingId !== msg.id && (
                  <div style={{ ...s.msgActions, [isMine?"right":"left"]: "calc(100% + 8px)" }} className="msg-actions">
                    <button style={s.actionBtn} onClick={e => { e.stopPropagation(); setPickerFor(p => p===msg.id ? null : msg.id); }}>😊</button>
                    {isMine && <>
                      <button style={s.actionBtn} onClick={() => { setEditingId(msg.id); setEditText(msg.message); }}>✏️</button>
                      <button style={{ ...s.actionBtn, color:"#dc2626" }} onClick={() => handleDelete(msg.id)}>🗑️</button>
                    </>}
                  </div>
                )}
                {pickerFor === msg.id && !msg.is_deleted && (
                  <div style={{ ...s.emojiPicker, [isMine?"right":"left"]: 40 }} onClick={e => e.stopPropagation()}>
                    {EMOJIS.map(emoji => <button key={emoji} style={s.emojiBtn} onClick={e => handleReact(msg.id, emoji, e)}>{emoji}</button>)}
                  </div>
                )}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {typing && <div style={s.typingBar}><div style={s.typingDots}><span/><span/><span/></div>{typing}</div>}
        {botThinking && <div style={{ ...s.typingBar, color:"#6c63ff" }}>🤖 AI is thinking…</div>}

        <div style={s.inputRow}>
          <input
            style={{ ...s.chatInput, borderColor: encryptionActive ? "rgba(108,99,255,0.4)" : "#e5e7eb" }}
            placeholder={encryptionActive ? `🔒 Encrypted message to #${currentRoom}...` : `Message #${currentRoom}… or @bot your question`}
            value={inputText}
            onChange={e => { setInputText(e.target.value); socketRef.current?.emit("typing"); }}
            onKeyDown={e => e.key === "Enter" && sendMessage()}
          />
          <button style={{ ...s.sendBtn, opacity: inputText.trim() ? 1 : 0.5 }} onClick={sendMessage} disabled={!inputText.trim()}>➤</button>
        </div>
      </div>

      {/* Invite modal */}
      {showInvite && (
        <div style={s.modal}><div style={s.modalBox}>
          <h3 style={{ marginBottom:"1rem" }}>👤 Invite to #{currentRoom}</h3>
          <input style={s.input} placeholder="Enter username" value={inviteUser} onChange={e => setInviteUser(e.target.value)} onKeyDown={e => e.key==="Enter" && handleSendInvite()} autoFocus />
          <div style={{ display:"flex", gap:"0.5rem" }}>
            <button style={s.btn} onClick={handleSendInvite}>Send Invite</button>
            <button style={s.cancelBtn} onClick={() => { setShowInvite(false); setInviteUser(""); }}>Cancel</button>
          </div>
        </div></div>
      )}

      {showMyProfile && renderProfileModal()}
      {viewingProfile && renderViewProfileModal()}

      {/* Friend requests modal in chat */}
      {showFriendReqs && (
        <div style={s.modal}><div style={s.modalBox}>
          <h3 style={{ marginBottom:"1rem" }}>🤝 Friend Requests</h3>
          {pendingFriendReqs.length === 0 && <p style={{ color:"#9ca3af", marginBottom:"1rem" }}>No pending requests.</p>}
          {pendingFriendReqs.map(req => (
            <div key={req.id} style={s.inviteRow}>
              <span><strong>{req.from_user}</strong> wants to be friends</span>
              <div style={{ display:"flex", gap:"0.4rem" }}>
                <button style={s.btn} disabled={friendReqLoading === req.id} onClick={() => handleFriendReqResponse(req.id, true)}>Accept</button>
                <button style={s.cancelBtn} disabled={friendReqLoading === req.id} onClick={() => handleFriendReqResponse(req.id, false)}>Decline</button>
              </div>
            </div>
          ))}
          <button style={s.cancelBtn} onClick={() => setShowFriendReqs(false)}>Close</button>
        </div></div>
      )}

      <style>{`
        .msg-row .msg-actions { display: none !important; }
        .msg-row:hover .msg-actions { display: flex !important; }
        @keyframes bounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-4px)} }
        @keyframes msgWaveIn {
          0%   { opacity: 0; transform: translateY(18px); }
          100% { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );

  // ── Shared modal renderers ────────────────────────────────────────────────
  function renderProfileModal() {
    return (
      <div style={s.modal}><div style={{ ...s.modalBox, width:"420px" }}>
        <h3 style={{ marginBottom:"1.25rem" }}>👤 My Profile</h3>
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:"0.75rem", marginBottom:"1.25rem" }}>
          <div style={{ position:"relative", cursor:"pointer" }} onClick={() => fileRef.current?.click()}>
            <Avatar username={user?.username || ""} avatarUrl={avatarPreview} size={72} />
            <div style={s.avatarOverlay}>📷</div>
          </div>
          <input ref={fileRef} type="file" accept="image/*" style={{ display:"none" }} onChange={handleAvatarFile} />
          <span style={{ fontSize:"0.75rem", color:"#9ca3af" }}>Click avatar to change (max 500 KB)</span>
        </div>
        <div style={{ marginBottom:"0.75rem" }}>
          <label style={s.label}>Username</label>
          <div style={{ ...s.input, color:"#6b7280", cursor:"default" }}>{user?.username}</div>
        </div>
        <div style={{ marginBottom:"0.75rem" }}>
          <label style={s.label}>Bio</label>
          <textarea style={{ ...s.input, height:"72px", resize:"vertical", fontFamily:"inherit" }}
            placeholder="Tell others about yourself..." value={editBio} onChange={e => setEditBio(e.target.value)} />
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:"0.75rem", marginBottom:"1.25rem", padding:"0.75rem", background:"#f9fafb", borderRadius:"10px" }}>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:500, fontSize:"0.9rem" }}>Account visibility</div>
            <div style={{ fontSize:"0.8rem", color:"#6b7280" }}>{editIsPublic ? "Public — anyone can send you friend requests" : "Private — only people you invite can add you"}</div>
          </div>
          <div style={{ ...s.toggle, background: editIsPublic ? "#6c63ff" : "#d1d5db" }} onClick={() => setEditIsPublic(v => !v)}>
            <div style={{ ...s.toggleKnob, transform: editIsPublic ? "translateX(20px)" : "translateX(2px)" }} />
          </div>
        </div>
        <div style={{ marginBottom:"1rem" }}>
          <label style={s.label}>Friends ({myProfile?.friends?.length || 0})</label>
          <div style={{ display:"flex", flexWrap:"wrap", gap:"0.4rem" }}>
            {(myProfile?.friends || []).length === 0 && <span style={{ fontSize:"0.85rem", color:"#9ca3af" }}>No friends yet.</span>}
            {(myProfile?.friends || []).map(f => (
              <div key={f} style={s.friendChip} onClick={() => { setShowMyProfile(false); handleViewProfile(f); }}>
                <Avatar username={f} avatarUrl={avatarCache[f]} size={20} />
                <span>{f}</span>
              </div>
            ))}
          </div>
        </div>
        {profileMsg && <p style={{ ...s.error, background: profileMsg.includes("saved") ? "#f0fdf4" : "#fef2f2", color: profileMsg.includes("saved") ? "#16a34a" : "#dc2626" }}>{profileMsg}</p>}
        <div style={{ display:"flex", gap:"0.5rem" }}>
          <button style={s.btn} onClick={handleSaveProfile} disabled={profileSaving}>{profileSaving ? "Saving..." : "Save Profile"}</button>
          <button style={s.cancelBtn} onClick={() => { setShowMyProfile(false); setProfileMsg(""); }}>Close</button>
        </div>
      </div></div>
    );
  }

  function renderViewProfileModal() {
    if (!viewingProfile) return null;
    return (
      <div style={s.modal}><div style={{ ...s.modalBox, width:"380px" }}>
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:"0.5rem", marginBottom:"1.25rem" }}>
          <Avatar username={viewingProfile.username} avatarUrl={viewingProfile.avatar_url} size={64} />
          <h3 style={{ margin:0 }}>{viewingProfile.username}</h3>
          <span style={{ fontSize:"0.75rem", color:"#9ca3af" }}>{viewingProfile.is_public ? "🌐 Public account" : "🔒 Private account"}</span>
          {viewingProfile.bio && <p style={{ color:"#6b7280", textAlign:"center", fontSize:"0.9rem", margin:0 }}>{viewingProfile.bio}</p>}
        </div>
        <div style={{ marginBottom:"1.25rem" }}>
          <label style={s.label}>Friends ({viewingProfile.friends?.length || 0})</label>
          <div style={{ display:"flex", flexWrap:"wrap", gap:"0.4rem" }}>
            {(viewingProfile.friends || []).length === 0 && <span style={{ fontSize:"0.85rem", color:"#9ca3af" }}>No friends yet.</span>}
            {(viewingProfile.friends || []).map(f => (
              <div key={f} style={s.friendChip}>
                <Avatar username={f} avatarUrl={avatarCache[f]} size={20} />
                <span>{f}</span>
              </div>
            ))}
          </div>
        </div>
        {viewingProfile.username !== user?.username && (
          <div style={{ marginBottom:"1rem" }}>
            {viewingProfile.friend_status === "friends" && (
              <button style={s.cancelBtn} onClick={() => handleUnfriend(viewingProfile.username)}>👋 Unfriend</button>
            )}
            {viewingProfile.friend_status === "pending_sent" && <div style={s.statusPill}>⏳ Friend request sent</div>}
            {viewingProfile.friend_status === "pending_received" && (
              <div style={{ display:"flex", gap:"0.5rem" }}>
                {pendingFriendReqs.filter(r => r.from_user === viewingProfile.username).map(req => (
                  <div key={req.id} style={{ display:"flex", gap:"0.5rem", width:"100%" }}>
                    <button style={s.btn} onClick={() => { handleFriendReqResponse(req.id, true); setViewingProfile(prev => prev ? { ...prev, friend_status: "friends" } : prev); }}>Accept</button>
                    <button style={s.cancelBtn} onClick={() => { handleFriendReqResponse(req.id, false); setViewingProfile(prev => prev ? { ...prev, friend_status: "none" } : prev); }}>Decline</button>
                  </div>
                ))}
              </div>
            )}
            {viewingProfile.friend_status === "none" && viewingProfile.is_public && (
              <button style={s.btn} onClick={() => handleSendFriendReq(viewingProfile.username)}>🤝 Send Friend Request</button>
            )}
            {viewingProfile.friend_status === "none" && !viewingProfile.is_public && (
              <div style={s.statusPill}>🔒 This account is private</div>
            )}
          </div>
        )}
        <button style={s.cancelBtn} onClick={() => setViewingProfile(null)}>Close</button>
      </div></div>
    );
  }
}

const s: Record<string, React.CSSProperties> = {
  page:         { display:"flex", justifyContent:"center", alignItems:"center", height:"100vh", background:"#f5f6fa", fontFamily:"Inter,sans-serif" },
  card:         { background:"#fff", padding:"2rem", borderRadius:"16px", width:"380px", boxShadow:"0 4px 24px rgba(0,0,0,0.1)" },
  logo:         { textAlign:"center", fontSize:"1.8rem", margin:"0 0 0.25rem" },
  sub:          { textAlign:"center", color:"#6b7280", marginBottom:"1.25rem" },
  input:        { width:"100%", padding:"0.75rem 1rem", marginBottom:"0.75rem", borderRadius:"10px", border:"1.5px solid #e5e7eb", fontSize:"1rem", boxSizing:"border-box", outline:"none", display:"block" },
  btn:          { width:"100%", padding:"0.75rem", background:"#6c63ff", color:"#fff", border:"none", borderRadius:"10px", fontSize:"1rem", cursor:"pointer", fontWeight:500 },
  cancelBtn:    { width:"100%", padding:"0.75rem", background:"#f3f4f6", color:"#374151", border:"none", borderRadius:"10px", fontSize:"1rem", cursor:"pointer" },
  error:        { color:"#dc2626", textAlign:"center", marginBottom:"1rem", background:"#fef2f2", padding:"0.5rem", borderRadius:"8px", fontSize:"0.85rem" },
  switchText:   { textAlign:"center", marginTop:"1rem", color:"#6b7280", fontSize:"0.875rem" },
  link:         { color:"#6c63ff", cursor:"pointer", fontWeight:500 },
  logoutBtn:    { padding:"0.4rem 0.8rem", background:"#ef4444", color:"#fff", border:"none", borderRadius:"6px", cursor:"pointer", fontSize:"0.85rem" },
  iconBtnRed:   { padding:"0.4rem 0.75rem", background:"#fef2f2", color:"#dc2626", border:"1px solid #fecaca", borderRadius:"6px", cursor:"pointer", fontSize:"0.85rem", fontWeight:600 },
  roomRow:      { display:"flex", alignItems:"center", padding:"0.75rem 1rem", background:"#f9fafb", border:"1.5px solid #e5e7eb", borderRadius:"10px" },
  lockBadge:    { marginLeft:"0.5rem", fontSize:"0.7rem", background:"#fef3c7", color:"#92400e", padding:"0.15rem 0.4rem", borderRadius:"4px" },
  shareBtn:     { padding:"0.4rem 0.6rem", background:"#f3f4f6", border:"1px solid #e5e7eb", borderRadius:"6px", cursor:"pointer", fontSize:"0.85rem" },
  joinBtn:      { padding:"0.4rem 0.75rem", background:"#6c63ff", color:"#fff", border:"none", borderRadius:"6px", cursor:"pointer", fontSize:"0.85rem" },
  createRoomBox:{ background:"#f9fafb", border:"1.5px solid #e5e7eb", borderRadius:"12px", padding:"1rem", marginBottom:"1rem" },
  modal:        { position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 },
  modalBox:     { background:"#fff", padding:"2rem", borderRadius:"16px", width:"380px", boxShadow:"0 8px 40px rgba(0,0,0,0.2)", maxHeight:"90vh", overflowY:"auto" },
  inviteRow:    { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.75rem", padding:"0.75rem", background:"#f9fafb", borderRadius:"8px", gap:"0.5rem" },
  chatLayout:   { display:"flex", height:"100vh", fontFamily:"Inter,sans-serif" },
  sidebar:      { width:"220px", background:"#1a1b2e", color:"#fff", padding:"1.25rem 1rem", display:"flex", flexDirection:"column", gap:"0.4rem", flexShrink:0 },
  backBtn:      { background:"rgba(108,99,255,0.2)", color:"#a89ff7", border:"1px solid rgba(108,99,255,0.3)", borderRadius:"8px", padding:"0.5rem", cursor:"pointer", fontSize:"0.85rem" },
  roomLabel:    { fontSize:"1rem", fontWeight:600, marginTop:"1rem", padding:"0.5rem 0.75rem", background:"rgba(255,255,255,0.06)", borderRadius:"8px" },
  sectionLabel: { color:"#6b7280", fontSize:"0.7rem", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", margin:"0.75rem 0 0.4rem 0.25rem" },
  onlineUser:   { display:"flex", alignItems:"center", padding:"0.3rem 0.5rem", borderRadius:"6px", color:"#d1d5db" },
  shareBtn2:    { padding:"0.5rem", background:"rgba(255,255,255,0.08)", color:"#d1d5db", border:"1px solid rgba(255,255,255,0.1)", borderRadius:"6px", cursor:"pointer", fontSize:"0.8rem", textAlign:"center" },
  inviteBtn:    { padding:"0.5rem", background:"rgba(108,99,255,0.2)", color:"#a89ff7", border:"1px solid rgba(108,99,255,0.3)", borderRadius:"6px", cursor:"pointer", fontSize:"0.8rem", textAlign:"center" },
  profileBtn:   { display:"flex", alignItems:"center", gap:"0.5rem", padding:"0.5rem", background:"rgba(255,255,255,0.06)", color:"#d1d5db", border:"1px solid rgba(255,255,255,0.1)", borderRadius:"6px", cursor:"pointer", fontSize:"0.8rem" },
  profileChip:  { display:"flex", alignItems:"center", gap:"0.4rem", padding:"0.3rem 0.6rem", background:"#f3f4f6", border:"1px solid #e5e7eb", borderRadius:"20px", cursor:"pointer" },
  chatArea:     { flex:1, display:"flex", flexDirection:"column", background:"#fff", minWidth:0 },
  chatHeader:   { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"0.75rem 1.25rem", borderBottom:"1px solid #f3f4f6" },
  iconBtn:      { background:"none", border:"none", cursor:"pointer", fontSize:"1.1rem", padding:"0.25rem 0.5rem", borderRadius:"6px" },
  unreadBadge:  { background:"#6c63ff", color:"#fff", fontSize:"0.75rem", padding:"0.25rem 0.6rem", borderRadius:"20px", cursor:"pointer" },
  searchBar:    { padding:"0.5rem 1rem", borderBottom:"1px solid #f3f4f6", display:"flex", alignItems:"center", gap:"0.75rem" },
  searchInput:  { flex:1, padding:"0.5rem 0.75rem", borderRadius:"8px", border:"1.5px solid #e5e7eb", fontSize:"0.9rem", outline:"none" },
  messages:     { flex:1, overflowY:"auto", padding:"1rem", display:"flex", flexDirection:"column", gap:"0.75rem" },
  msgRow:       { display:"flex", alignItems:"flex-end", gap:"0.5rem" },
  bubble:       { padding:"0.55rem 0.9rem 0.4rem", borderRadius:"16px", wordBreak:"break-word", width:"100%" },
  msgUser:      { fontSize:"0.7rem", fontWeight:600, margin:"0 0 0.2rem", opacity:0.75 },
  msgText:      { margin:0, fontSize:"0.925rem", lineHeight:1.45 },
  msgTime:      { fontSize:"0.65rem", opacity:0.6, margin:0 },
  msgActions:   { position:"absolute", top:0, display:"flex", flexDirection:"column", gap:"4px", zIndex:10 },
  actionBtn:    { background:"#fff", border:"1px solid #e5e7eb", borderRadius:"6px", padding:"0.2rem 0.4rem", fontSize:"0.8rem", cursor:"pointer", boxShadow:"0 1px 4px rgba(0,0,0,0.08)" },
  emojiPicker:  { position:"absolute", bottom:"calc(100% + 6px)", background:"#fff", border:"1px solid #e5e7eb", borderRadius:"12px", padding:"0.5rem", display:"flex", gap:"4px", flexWrap:"wrap", boxShadow:"0 4px 20px rgba(0,0,0,0.12)", zIndex:100, width:"220px" },
  emojiBtn:     { fontSize:"1.3rem", background:"none", border:"none", cursor:"pointer", borderRadius:"8px", padding:"0.2rem 0.3rem" },
  reactionChip: { display:"inline-flex", alignItems:"center", gap:"4px", borderRadius:"20px", padding:"0.15rem 0.5rem", fontSize:"0.8rem", cursor:"pointer" },
  editInput:    { width:"100%", padding:"0.35rem 0.5rem", border:"1.5px solid #6c63ff", borderRadius:"6px", fontSize:"0.875rem", outline:"none", background:"rgba(255,255,255,0.15)", color:"inherit" },
  editSave:     { background:"#6c63ff", color:"#fff", border:"none", borderRadius:"6px", padding:"0.3rem 0.6rem", fontSize:"0.8rem", cursor:"pointer" },
  editCancel:   { background:"none", border:"1px solid rgba(255,255,255,0.3)", borderRadius:"6px", padding:"0.3rem 0.6rem", fontSize:"0.8rem", cursor:"pointer", color:"inherit" },
  typingBar:    { padding:"0.4rem 1.25rem", fontSize:"0.8rem", color:"#9ca3af", fontStyle:"italic", display:"flex", alignItems:"center", gap:"0.4rem", minHeight:"1.5rem" },
  typingDots:   { display:"flex", gap:"3px" },
  inputRow:     { display:"flex", padding:"0.75rem 1rem", gap:"0.5rem", borderTop:"1px solid #f3f4f6" },
  chatInput:    { flex:1, padding:"0.7rem 1rem", borderRadius:"24px", border:"1.5px solid #e5e7eb", fontSize:"0.95rem", outline:"none", background:"#f9fafb" },
  sendBtn:      { width:"42px", height:"42px", borderRadius:"50%", background:"#6c63ff", color:"#fff", border:"none", cursor:"pointer", fontSize:"1.1rem", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  label:        { display:"block", fontSize:"0.8rem", fontWeight:600, color:"#6b7280", marginBottom:"0.35rem", textTransform:"uppercase", letterSpacing:"0.04em" },
  avatarOverlay:{ position:"absolute", bottom:0, right:0, background:"rgba(0,0,0,0.55)", borderRadius:"50%", width:"22px", height:"22px", display:"flex", alignItems:"center", justifyContent:"center", fontSize:"0.7rem" },
  toggle:       { width:"44px", height:"24px", borderRadius:"12px", cursor:"pointer", position:"relative", transition:"background 0.2s", flexShrink:0 },
  toggleKnob:   { position:"absolute", top:"2px", width:"20px", height:"20px", borderRadius:"50%", background:"#fff", transition:"transform 0.2s", boxShadow:"0 1px 3px rgba(0,0,0,0.2)" },
  friendChip:   { display:"inline-flex", alignItems:"center", gap:"0.35rem", padding:"0.25rem 0.6rem", background:"#f3f4f6", borderRadius:"20px", fontSize:"0.8rem", cursor:"pointer", border:"1px solid #e5e7eb" },
  statusPill:   { padding:"0.6rem 1rem", background:"#f9fafb", border:"1px solid #e5e7eb", borderRadius:"10px", fontSize:"0.85rem", color:"#6b7280", textAlign:"center" },
};