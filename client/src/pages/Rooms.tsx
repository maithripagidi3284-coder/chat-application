import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const ROOMS = ['General', 'Technology', 'Gaming', 'Music', 'Movies'];

export default function Rooms() {
  const navigate    = useNavigate();
  const { user, logout } = useAuth();

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.header}>
          <h2 style={styles.title}>💬 Chat Rooms</h2>
          <div style={styles.userInfo}>
            <span>👤 {user?.username}</span>
            <button onClick={() => { logout(); navigate('/login'); }} style={styles.logout}>
              Logout
            </button>
          </div>
        </div>
        <p style={styles.subtitle}>Pick a room to join:</p>
        <div style={styles.rooms}>
          {ROOMS.map(room => (
            <button
              key={room}
              style={styles.roomBtn}
              onClick={() => navigate(`/chat/${room}`)}
            >
              # {room}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container:  { display:'flex', justifyContent:'center', alignItems:'center', height:'100vh', background:'#f0f2f5' },
  card:       { background:'#fff', padding:'2rem', borderRadius:'12px', width:'420px', boxShadow:'0 4px 20px rgba(0,0,0,0.1)' },
  header:     { display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'0.5rem' },
  title:      { fontSize:'1.8rem', margin:0 },
  subtitle:   { color:'#666', marginBottom:'1.5rem' },
  userInfo:   { display:'flex', alignItems:'center', gap:'0.75rem' },
  logout:     { padding:'0.4rem 0.8rem', background:'#ff4d4d', color:'#fff', border:'none', borderRadius:'6px', cursor:'pointer' },
  rooms:      { display:'flex', flexDirection:'column', gap:'0.75rem' },
  roomBtn:    { padding:'1rem', background:'#f0f2f5', border:'none', borderRadius:'8px', fontSize:'1.1rem', cursor:'pointer', textAlign:'left', transition:'background 0.2s' },
};