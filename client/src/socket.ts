import { io } from 'socket.io-client';

const socket = io('http://localhost:3000', {
  autoConnect: false,
  // Always read the latest token at connect time
  auth: (cb) => {
    cb({ token: localStorage.getItem('accessToken') });
  }
});

export default socket;