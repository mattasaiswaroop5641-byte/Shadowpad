const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Global State
const rooms = {}; // In-memory state for active rooms

// 1. MongoDB Connection
// Ensure you have MongoDB running locally or use a cloud URI
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/shadowpad';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// 2. Define Pad Schema
const PadSchema = new mongoose.Schema({
    roomId: { type: String, required: true, unique: true },
    content: { type: String, default: "" }, // Stores the Encrypted Blob
    lastActive: { type: Date, default: Date.now }
});
const Pad = mongoose.model('Pad', PadSchema);

// 3. Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); // Crucial for parsing JSON body in POST requests

// 4. API Route: Save Encrypted Pad
app.post('/api/save-pad', async (req, res) => {
    try {
        const { roomId, content } = req.body;
        
        if (!roomId || !content) {
            return res.status(400).json({ error: 'Room ID and Content are required' });
        }

        // Upsert: Update if exists, Insert if new
        await Pad.findOneAndUpdate(
            { roomId }, 
            { content, lastActive: Date.now() },
            { upsert: true, new: true }
        );

        console.log(`💾 Encrypted Pad saved: ${roomId}`);
        res.status(200).json({ success: true, message: 'Pad saved to MongoDB' });
    } catch (error) {
        console.error('Save failed:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// 4.1 API Route: Delete Pad
app.delete('/api/delete-pad', async (req, res) => {
    try {
        const { roomId } = req.body;
        if (!roomId) return res.status(400).json({ error: 'Room ID required' });

        await Pad.findOneAndDelete({ roomId });
        if (rooms[roomId]) delete rooms[roomId]; // Clear from memory

        console.log(`🗑️ Pad deleted: ${roomId}`);
        res.status(200).json({ success: true, message: 'Pad deleted' });
    } catch (error) {
        console.error('Delete failed:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// 4.2 API Route: Get All Pads (Admin Dashboard)
app.get('/api/pads', async (req, res) => {
    try {
        // Simple security check (Use ?secret=Mgsai@1042 in URL)
        if (req.query.secret !== 'Mgsai@1042') {
            return res.status(403).json({ error: 'Unauthorized access' });
        }
        const pads = await Pad.find().sort({ lastActive: -1 });
        res.json(pads);
    } catch (error) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 5. Socket.IO Logic
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Create Room
    socket.on('create-room', ({ roomName, password, userName, maxUsers }) => {
        const roomId = roomName.toUpperCase();
        if (rooms[roomId]) {
            socket.emit('error-msg', 'Room already exists');
            return;
        }
        
        rooms[roomId] = {
            id: roomId,
            name: roomName,
            password, 
            users: [],
            files: [],
            content: '',
            hostId: socket.id,
            maxUsers: maxUsers || 20,
            permissions: { allowEdit: true, allowUpload: true, allowDelete: true }
        };
        
        joinRoomLogic(socket, roomId, userName, true);
    });

    // Join Room (Handles restoring from MongoDB)
    socket.on('join-room', async ({ roomId, password, userName }) => {
        let room = rooms[roomId];

        // If room not active, check MongoDB
        if (!room) {
            const savedPad = await Pad.findOne({ roomId });
            if (savedPad) {
                // Restore room from DB
                room = rooms[roomId] = {
                    id: roomId,
                    name: roomId,
                    password: password, // The password entered becomes the session key
                    users: [],
                    files: [],
                    content: savedPad.content, // Load encrypted content
                    hostId: socket.id,
                    maxUsers: 20,
                    permissions: { allowEdit: true, allowUpload: true, allowDelete: true }
                };
            }
        }

        if (!room) return socket.emit('error-msg', 'Room not found');
        if (room.password !== password) return socket.emit('error-msg', 'Incorrect password');
        if (room.users.length >= room.maxUsers) return socket.emit('error-msg', 'Room is full');

        joinRoomLogic(socket, roomId, userName, false);
    });

    // Sync Text
    socket.on('update-text', ({ roomId, content }) => {
        if (rooms[roomId]) {
            rooms[roomId].content = content;
            socket.to(roomId).emit('text-synced', content);
        }
    });

    // Helper: Join Logic
    function joinRoomLogic(socket, roomId, userName, isHost) {
        const room = rooms[roomId];
        const user = { id: socket.id, name: userName, isHost: isHost || socket.id === room.hostId };
        
        room.users.push(user);
        socket.join(roomId);

        socket.emit('joined-successfully', {
            roomId: room.id,
            roomName: room.name,
            content: room.content,
            users: room.users,
            isHost: user.isHost,
            files: room.files
        });
        
        io.to(roomId).emit('update-user-list', room.users);
        io.to(roomId).emit('activity-log', `${userName} joined.`);
    }

    // ... Add other handlers (upload-file, delete-file, disconnect) as needed ...
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));